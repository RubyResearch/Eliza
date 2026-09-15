/**
 * Exercises the production Capacitor desired-state reconciler against a
 * multi-surface native transport with lost acknowledgements and renderer races.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CapacitorNativeSurfaceShell,
  type ElizaSurfaceManagerPlugin,
  type ElizaSurfaceManagerState,
  type NativeSurfaceOwnerIdentity,
} from "./capacitor-native-surface-shell";
import type {
  NativeSurfaceCreateRequest,
  SurfaceBounds,
  SurfaceOcclusionRect,
} from "./native-surface-shell";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function drainPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const IDENTITY_A: NativeSurfaceOwnerIdentity = {
  owner: "browser",
  session: "realm-a",
  epoch: 1,
};
const IDENTITY_B: NativeSurfaceOwnerIdentity = {
  owner: "browser",
  session: "realm-b",
  epoch: 2,
};
const CREATE_A: NativeSurfaceCreateRequest = {
  id: "browser-tab:a",
  url: "https://a.example",
  policy: { process: "isolated", storage: "isolated" },
};
const CREATE_B: NativeSurfaceCreateRequest = {
  ...CREATE_A,
  id: "browser-tab:b",
  url: "https://b.example",
};
const CREATE_C: NativeSurfaceCreateRequest = {
  ...CREATE_A,
  id: "browser-tab:c",
  url: "https://c.example",
};
const REOPENED_A: NativeSurfaceCreateRequest = {
  ...CREATE_A,
  url: "https://reopened.example",
};
const BOUNDS: SurfaceBounds = {
  x: 8,
  y: 72,
  width: 368,
  height: 640,
  outerClip: {
    x: 8,
    y: 72,
    width: 368,
    height: 640,
    cornerRadii: {
      topLeft: 24,
      topRight: 0,
      bottomRight: 12,
      bottomLeft: 0,
    },
  },
};
const HOLES: readonly SurfaceOcclusionRect[] = [
  { x: 12, y: 580, width: 344, height: 48, cornerRadius: 24 },
];
const ABSENT_STATE: ElizaSurfaceManagerState = {
  exists: false,
  foregrounded: false,
  currentUrl: null,
  process: null,
  storage: null,
  owner: null,
  session: null,
  epoch: null,
};

type NativeOperation =
  | "reconcile"
  | "create"
  | "bounds"
  | "occlusions"
  | "navigate"
  | "reload"
  | "back"
  | "present"
  | "destroy"
  | "state"
  | "list";

interface NativeSurfaceRecord extends ElizaSurfaceManagerState {
  readonly id: string;
}

class StatefulNativeManager implements ElizaSurfaceManagerPlugin {
  [key: string]: unknown;
  readonly events: string[] = [];
  readonly bounds: SurfaceBounds[] = [];
  readonly occlusions: Array<readonly SurfaceOcclusionRect[]> = [];
  readonly surfaces = new Map<string, NativeSurfaceRecord>();
  readonly navigationListeners = new Set<(event: unknown) => void>();

  async addListener(
    _event: "navigationChanged",
    listener: (event: unknown) => void,
  ) {
    this.navigationListeners.add(listener);
    return {
      remove: async () => {
        this.navigationListeners.delete(listener);
      },
    };
  }

  emitNavigation(identity = IDENTITY_A, id = CREATE_A.id): void {
    for (const listener of this.navigationListeners)
      listener({ ...identity, id });
  }

  goBack(options: NativeSurfaceOwnerIdentity & { id: string }): Promise<void> {
    return this.execute("back", `back:${options.id}`, () => {
      this.requireOwned(options);
    });
  }
  async readPage(options: NativeSurfaceOwnerIdentity & { id: string }) {
    this.requireOwned(options);
    return {
      url: "https://a.example/",
      title: "Native page",
      text: "Visible page text",
      truncated: false,
    };
  }
  private readonly failures = new Map<NativeOperation, number>();
  private readonly appliedFailures = new Map<NativeOperation, number>();
  private readonly gates = new Map<NativeOperation, Array<Deferred<void>>>();
  private readonly activeOwners = new Map<
    string,
    { session: string; epoch: number }
  >();
  private ownerCleanupFailures = 0;

  rejectNext(operation: NativeOperation, count = 1): void {
    this.failures.set(operation, (this.failures.get(operation) ?? 0) + count);
  }

  applyThenRejectNext(operation: NativeOperation, count = 1): void {
    this.appliedFailures.set(
      operation,
      (this.appliedFailures.get(operation) ?? 0) + count,
    );
  }

  deferNext(operation: NativeOperation): Deferred<void> {
    const gate = deferred<void>();
    const gates = this.gates.get(operation) ?? [];
    gates.push(gate);
    this.gates.set(operation, gates);
    return gate;
  }

  rejectNextOwnerCleanup(count = 1): void {
    this.ownerCleanupFailures += count;
  }

  seed(
    identity: NativeSurfaceOwnerIdentity,
    req: NativeSurfaceCreateRequest,
  ): void {
    this.activeOwners.set(identity.owner, {
      session: identity.session,
      epoch: identity.epoch,
    });
    this.surfaces.set(req.id, {
      id: req.id,
      exists: true,
      foregrounded: false,
      currentUrl: req.url ?? null,
      process: req.policy.process,
      storage: req.policy.storage,
      owner: identity.owner,
      session: identity.session,
      epoch: identity.epoch,
    });
  }

  createSurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
    url?: string;
    process: "isolated" | "shared";
    storage: "isolated" | "shared";
  }): Promise<void> {
    return this.execute("create", `create:${options.id}`, () => {
      this.requireActive(options);
      const existing = this.surfaces.get(options.id);
      if (existing) {
        if (
          existing.owner !== options.owner ||
          existing.session !== options.session ||
          existing.epoch !== options.epoch ||
          existing.process !== options.process ||
          existing.storage !== options.storage
        ) {
          throw new Error("stale same-id native surface");
        }
        if (options.url) existing.currentUrl = options.url;
        return;
      }
      this.surfaces.set(options.id, {
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
    });
  }

  setBounds(
    options: {
      owner: string;
      session: string;
      epoch: number;
      id: string;
    } & SurfaceBounds,
  ): Promise<void> {
    return this.execute("bounds", `bounds:${options.id}`, () => {
      this.requireOwned(options);
      this.bounds.push(options);
    });
  }

  setOcclusionRects(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
    rects: readonly SurfaceOcclusionRect[];
  }): Promise<void> {
    return this.execute("occlusions", `occlusions:${options.id}`, () => {
      this.requireOwned(options);
      this.occlusions.push(options.rects);
    });
  }

  navigate(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
    url: string;
  }): Promise<void> {
    return this.execute("navigate", `navigate:${options.id}`, () => {
      this.requireOwned(options).currentUrl = options.url;
    });
  }

  reloadSurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): Promise<void> {
    return this.execute("reload", `reload:${options.id}`, () => {
      this.requireOwned(options);
    });
  }

  presentSurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string | null;
  }): Promise<void> {
    return this.execute("present", `present:${options.id ?? "host"}`, () => {
      this.requireActive(options);
      for (const surface of this.surfaces.values()) {
        if (surface.owner === options.owner) {
          surface.foregrounded = false;
        }
      }
      if (options.id) {
        this.requireOwned({ ...options, id: options.id }).foregrounded = true;
      }
    });
  }

  destroySurface(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): Promise<void> {
    return this.execute("destroy", `destroy:${options.id}`, () => {
      this.requireActive(options);
      const surface = this.surfaces.get(options.id);
      if (!surface) return;
      this.requireOwned(options);
      this.surfaces.delete(options.id);
    });
  }

  getSurfaceState(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): Promise<ElizaSurfaceManagerState> {
    return this.execute("state", `state:${options.id}`, () => undefined).then(
      () => {
        this.requireActive(options);
        const surface = this.surfaces.get(options.id);
        return surface?.owner === options.owner &&
          surface.session === options.session &&
          surface.epoch === options.epoch
          ? { ...surface }
          : { ...ABSENT_STATE };
      },
    );
  }

  listSurfaceStates(options: {
    owner: string;
    session: string;
    epoch: number;
  }): Promise<unknown> {
    return this.execute("list", "list", () => undefined).then(() => {
      this.requireActive(options);
      return {
        surfaces: [...this.surfaces.values()]
          .filter(
            (surface) =>
              surface.owner === options.owner &&
              surface.session === options.session &&
              surface.epoch === options.epoch,
          )
          .map((surface) => ({ ...surface })),
      };
    });
  }

  reconcileOwner(options: {
    owner: string;
    session: string;
    epoch: number;
    desiredIds: readonly string[];
  }): Promise<void> {
    return this.execute("reconcile", "reconcile", () => {
      const current = this.activeOwners.get(options.owner);
      if (
        current &&
        (options.epoch < current.epoch ||
          (options.epoch === current.epoch &&
            options.session !== current.session))
      ) {
        throw new Error("retired native owner");
      }
      if (!current || options.epoch > current.epoch) {
        this.activeOwners.set(options.owner, {
          session: options.session,
          epoch: options.epoch,
        });
      }
      for (const surface of this.surfaces.values()) {
        if (surface.owner === options.owner) surface.foregrounded = false;
      }
      if (this.ownerCleanupFailures > 0) {
        this.ownerCleanupFailures -= 1;
        throw new Error("native owner cleanup rejected");
      }
      const desired = new Set(options.desiredIds);
      for (const [id, surface] of this.surfaces) {
        if (
          surface.owner === options.owner &&
          (surface.session !== options.session ||
            surface.epoch !== options.epoch ||
            !desired.has(id))
        ) {
          this.surfaces.delete(id);
        }
      }
    });
  }

  private execute(
    operation: NativeOperation,
    event: string,
    apply: () => void,
  ): Promise<void> {
    this.events.push(event);
    const gate = this.gates.get(operation)?.shift();
    if (gate) return gate.promise.then(apply);
    const failures = this.failures.get(operation) ?? 0;
    if (failures > 0) {
      this.failures.set(operation, failures - 1);
      return Promise.reject(new Error(`${operation} transport rejected`));
    }
    const appliedFailures = this.appliedFailures.get(operation) ?? 0;
    if (appliedFailures > 0) {
      this.appliedFailures.set(operation, appliedFailures - 1);
      apply();
      return Promise.reject(new Error(`${operation} acknowledgement lost`));
    }
    try {
      apply();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private requireOwned(options: {
    owner: string;
    session: string;
    epoch: number;
    id: string;
  }): NativeSurfaceRecord {
    const surface = this.surfaces.get(options.id);
    if (
      !surface ||
      surface.owner !== options.owner ||
      surface.session !== options.session ||
      surface.epoch !== options.epoch
    ) {
      throw new Error(`no owned surface ${options.id}`);
    }
    return surface;
  }

  private requireActive(options: {
    owner: string;
    session: string;
    epoch: number;
  }): void {
    const active = this.activeOwners.get(options.owner);
    if (
      !active ||
      active.session !== options.session ||
      active.epoch !== options.epoch
    ) {
      throw new Error("retired native owner");
    }
  }
}

describe("CapacitorNativeSurfaceShell", () => {
  it("preserves complete long native reads and rejects clipped payloads", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    await expect(shell.readPage(CREATE_A.id, "h1")).resolves.toMatchObject({
      text: "Visible page text",
      truncated: false,
    });
    const complete = "x".repeat(32_001) + " 終端 Ω";
    const read = vi.spyOn(manager, "readPage").mockResolvedValueOnce({
      url: "https://a.example/",
      title: "A",
      text: complete,
      truncated: false,
    });
    await expect(shell.readPage(CREATE_A.id)).resolves.toMatchObject({
      text: complete,
    });
    read.mockResolvedValueOnce({
      url: "https://a.example/",
      title: "A",
      text: "prefix",
      truncated: true,
    });
    await expect(shell.readPage(CREATE_A.id)).rejects.toThrow(
      "invalid page read",
    );
  });

  it("discards a page read if its surface is destroyed while awaiting native", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    const gate = deferred<Awaited<ReturnType<typeof manager.readPage>>>();
    vi.spyOn(manager, "readPage").mockReturnValueOnce(gate.promise);
    const read = shell.readPage(CREATE_A.id);
    const rejected = expect(read).rejects.toThrow();
    await drainPromises();
    await shell.destroySurface(CREATE_A.id);
    gate.resolve({
      url: "https://a.example/",
      title: "Old",
      text: "Old",
      truncated: false,
    });
    await rejected;
  });

  it("observes the native URL without navigating back to stale desired state", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    const listener = vi.fn();
    const onError = vi.fn();
    const remove = await shell.subscribeNavigation(listener, onError);
    const surface = manager.surfaces.get(CREATE_A.id);
    if (!surface) throw new Error("Expected created native surface");
    surface.currentUrl = "https://next.example/";
    manager.emitNavigation();
    await drainPromises();
    expect(listener).toHaveBeenLastCalledWith({
      id: CREATE_A.id,
      url: "https://next.example/",
      previousUrl: CREATE_A.url,
    });
    await shell.setBounds(CREATE_A.id, BOUNDS);
    expect(manager.surfaces.get(CREATE_A.id)?.currentUrl).toBe(
      "https://next.example/",
    );
    expect(
      manager.events.filter((event) => event.startsWith("navigate:")),
    ).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    await remove();
    expect(manager.navigationListeners.size).toBe(0);
  });

  it("ignores foreign-owner events and state reads superseded by navigation or teardown", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    const listener = vi.fn();
    const remove = await shell.subscribeNavigation(listener, vi.fn());
    listener.mockClear();
    manager.emitNavigation(IDENTITY_B);
    await drainPromises();
    expect(listener).not.toHaveBeenCalled();
    const readGate = manager.deferNext("state");
    manager.emitNavigation();
    await drainPromises();
    await shell.navigate(CREATE_A.id, "https://new-command.example/");
    readGate.resolve();
    await drainPromises();
    expect(listener).not.toHaveBeenCalled();
    const lateRead = manager.deferNext("state");
    manager.emitNavigation();
    await drainPromises();
    await remove();
    lateRead.resolve();
    await drainPromises();
    expect(listener).not.toHaveBeenCalled();
  });

  it("never repeats a history step after its acknowledgement is lost", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.applyThenRejectNext("back");
    await expect(shell.back(CREATE_A.id)).rejects.toThrow();
    expect(
      manager.events.filter((event) => event === `back:${CREATE_A.id}`),
    ).toHaveLength(1);
  });
  it("holds initial geometry, holes, and presentation behind acknowledged create", async () => {
    const manager = new StatefulNativeManager();
    const gate = manager.deferNext("create");
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    const requests = [
      shell.createSurface(CREATE_A),
      shell.setBounds(CREATE_A.id, BOUNDS),
      shell.setOcclusionRects(CREATE_A.id, HOLES),
      shell.presentSurface(CREATE_A.id),
    ];

    await drainPromises();
    expect(manager.events).toEqual([
      "reconcile",
      `state:${CREATE_A.id}`,
      `create:${CREATE_A.id}`,
    ]);
    expect(shell.hasSurface(CREATE_A.id)).toBe(false);

    gate.resolve();
    await Promise.all(requests);
    expect(manager.events).toContain(`bounds:${CREATE_A.id}`);
    expect(manager.events).toContain(`occlusions:${CREATE_A.id}`);
    expect(manager.events.at(-1)).toBe(`present:${CREATE_A.id}`);
    expect(shell.hasSurface(CREATE_A.id)).toBe(true);
  });

  it("accepts a create whose mutation succeeded before its acknowledgement was lost", async () => {
    const manager = new StatefulNativeManager();
    manager.applyThenRejectNext("create");
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);

    await Promise.all([
      shell.createSurface(CREATE_A),
      shell.setBounds(CREATE_A.id, BOUNDS),
      shell.presentSurface(CREATE_A.id),
    ]);

    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: CREATE_A.url,
      foregrounded: true,
    });
    expect(
      manager.events.filter((event) => event.startsWith("create:")),
    ).toHaveLength(1);
  });

  it("enters a typed terminal failure after bounded attempts and converges on explicit retry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    manager.rejectNext("create", 3);
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);

    await expect(shell.createSurface(CREATE_A)).rejects.toMatchObject({
      operation: `createSurface(${CREATE_A.id})`,
    });
    expect(shell.hasSurface(CREATE_A.id)).toBe(false);
    await shell.createSurface(CREATE_A);
    expect(shell.hasSurface(CREATE_A.id)).toBe(true);

    manager.rejectNext("bounds", 3);
    await expect(shell.setBounds(CREATE_A.id, BOUNDS)).rejects.toMatchObject({
      operation: `setBounds(${CREATE_A.id})`,
    });
    await shell.setBounds(CREATE_A.id, BOUNDS);
    manager.rejectNext("bounds", 3);
    const shifted = { ...BOUNDS, x: BOUNDS.x + 1 };
    await expect(shell.setBounds(CREATE_A.id, shifted)).rejects.toMatchObject({
      operation: `setBounds(${CREATE_A.id})`,
    });
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("reconciles navigation, geometry, reload, and global visibility on a motionless page", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.rejectNext("bounds", 2);
    await shell.setBounds(CREATE_A.id, BOUNDS);
    manager.rejectNext("navigate", 2);
    await shell.navigate(CREATE_A.id, "https://next.example");
    manager.rejectNext("reload", 2);
    await shell.reload(CREATE_A.id);
    manager.rejectNext("present", 2);
    await shell.presentSurface(CREATE_A.id);
    manager.rejectNext("present", 2);
    await shell.presentSurface(null);

    expect(manager.bounds).toHaveLength(1);
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: "https://next.example",
      foregrounded: false,
    });
    expect(
      manager.events.filter((event) => event.startsWith("reload:")),
    ).toHaveLength(3);
  });

  it("navigates on Android WebViews that do not implement URL.canParse", async () => {
    const originalCanParse = URL.canParse;
    Object.defineProperty(URL, "canParse", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      const manager = new StatefulNativeManager();
      const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
      await shell.createSurface(CREATE_A);
      await shell.navigate(CREATE_A.id, "https://compatible.example/path");
      expect(manager.surfaces.get(CREATE_A.id)?.currentUrl).toBe(
        "https://compatible.example/path",
      );
    } finally {
      Object.defineProperty(URL, "canParse", {
        configurable: true,
        value: originalCanParse,
        writable: true,
      });
    }
  });

  it("accepts navigation whose mutation landed before its acknowledgement was lost", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.applyThenRejectNext("navigate");

    await shell.navigate(CREATE_A.id, "https://landed.example");

    expect(manager.surfaces.get(CREATE_A.id)?.currentUrl).toBe(
      "https://landed.example",
    );
    expect(
      manager.events.filter((event) => event === `navigate:${CREATE_A.id}`),
    ).toHaveLength(1);
  });

  it("destroys a stale generation before reopening the same id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.rejectNext("destroy", 3);
    await expect(shell.destroySurface(CREATE_A.id)).rejects.toThrow(
      /destroySurface/,
    );

    await shell.createSurface(REOPENED_A);
    expect(manager.surfaces.get(CREATE_A.id)?.currentUrl).toBe(REOPENED_A.url);
    expect(
      manager.events.filter((event) => event.startsWith("destroy:")),
    ).toHaveLength(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("hands an in-flight close to a newer same-id generation without adopting it", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    const gate = manager.deferNext("destroy");
    const closing = shell.destroySurface(CREATE_A.id);
    await drainPromises();
    const reopening = shell.createSurface(REOPENED_A);
    const bounds = shell.setBounds(CREATE_A.id, BOUNDS);
    const present = shell.presentSurface(CREATE_A.id);
    gate.resolve();
    await Promise.all([closing, reopening, bounds, present]);

    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: REOPENED_A.url,
      foregrounded: true,
    });
  });

  it("atomically presents exactly one of two surfaces and host supersedes pending selection", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await Promise.all([
      shell.createSurface(CREATE_A),
      shell.createSurface(CREATE_B),
    ]);
    await shell.presentSurface(CREATE_A.id);
    expect(
      [...manager.surfaces.values()]
        .filter((state) => state.foregrounded)
        .map((state) => state.id),
    ).toEqual([CREATE_A.id]);

    await shell.presentSurface(CREATE_B.id);
    expect(
      [...manager.surfaces.values()]
        .filter((state) => state.foregrounded)
        .map((state) => state.id),
    ).toEqual([CREATE_B.id]);

    const gate = manager.deferNext("present");
    const staleSelection = shell.presentSurface(CREATE_A.id);
    await drainPromises();
    const host = shell.presentSurface(null);
    gate.resolve();
    await Promise.all([staleSelection, host]);
    expect(
      [...manager.surfaces.values()].some((state) => state.foregrounded),
    ).toBe(false);
    expect(manager.events.at(-1)).toBe("present:host");
  });

  it("reconciles startup orphans and fences an already-owned older renderer realm", async () => {
    const manager = new StatefulNativeManager();
    const older = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await older.createSurface(CREATE_A);
    const newer = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await newer.createSurface(REOPENED_A);
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      owner: IDENTITY_B.owner,
      session: IDENTITY_B.session,
      currentUrl: REOPENED_A.url,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    await expect(
      older.navigate(CREATE_A.id, "https://stale-realm.example"),
    ).rejects.toMatchObject({ surfaceId: CREATE_A.id });
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      session: IDENTITY_B.session,
      currentUrl: REOPENED_A.url,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects delayed create and presentation commands from a retired renderer epoch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    const older = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await older.createSurface(CREATE_A);
    await older.presentSurface(CREATE_A.id);

    const newer = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await Promise.all([
      newer.createSurface(REOPENED_A),
      newer.createSurface(CREATE_B),
    ]);
    await newer.presentSurface(CREATE_B.id);

    await expect(older.createSurface(CREATE_C)).rejects.toMatchObject({
      surfaceId: CREATE_C.id,
    });
    await expect(older.presentSurface(null)).rejects.toMatchObject({
      surfaceId: null,
    });
    expect(manager.surfaces.has(CREATE_C.id)).toBe(false);
    expect(manager.surfaces.get(CREATE_B.id)).toMatchObject({
      epoch: IDENTITY_B.epoch,
      foregrounded: true,
    });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("hides every stale owner surface before fallible epoch cleanup", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    manager.seed(IDENTITY_A, CREATE_A);
    manager.seed(IDENTITY_A, CREATE_B);
    const staleA = manager.surfaces.get(CREATE_A.id);
    const staleB = manager.surfaces.get(CREATE_B.id);
    if (!staleA || !staleB) throw new Error("expected seeded surfaces");
    staleA.foregrounded = true;
    staleB.foregrounded = true;
    manager.rejectNextOwnerCleanup(3);

    const newer = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await expect(newer.presentSurface(null)).rejects.toMatchObject({
      surfaceId: null,
    });
    expect(
      [...manager.surfaces.values()].every((state) => !state.foregrounded),
    ).toBe(true);

    await newer.presentSurface(null);
    expect(manager.surfaces.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns presentation to the host before rejecting a missing selected surface", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await Promise.all([
      shell.createSurface(CREATE_A),
      shell.createSurface(CREATE_B),
    ]);
    await shell.presentSurface(CREATE_A.id);

    await expect(
      manager.presentSurface({ ...IDENTITY_A, id: "browser-tab:missing" }),
    ).rejects.toThrow(/no owned surface/);
    expect(
      [...manager.surfaces.values()].every((state) => !state.foregrounded),
    ).toBe(true);
  });

  it("removes a native orphan left by a renderer that no longer exists", async () => {
    const manager = new StatefulNativeManager();
    manager.seed(IDENTITY_A, CREATE_A);
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await shell.createSurface(CREATE_B);
    expect(manager.surfaces.has(CREATE_A.id)).toBe(false);
    expect(manager.surfaces.get(CREATE_B.id)?.session).toBe(IDENTITY_B.session);
  });

  it("rejects malformed native state instead of adopting it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    (
      manager as unknown as {
        getSurfaceState(): Promise<unknown>;
      }
    ).getSurfaceState = () => Promise.resolve({ exists: true });
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await expect(shell.createSurface(CREATE_A)).rejects.toMatchObject({
      operation: `getSurfaceState(${CREATE_A.id})`,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
