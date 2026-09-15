// @vitest-environment jsdom

/** Exercises native credential migration and fail-closed storage behavior. */
import {
  clearStoredStewardToken,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as persistence from "../state/persistence";

// Captured once, before any test installs the storage-bridge proxy, so every
// test can read/write "the raw disk" (bypassing whatever proxy state a prior
// test in this file left behind) instead of accidentally re-capturing an
// already-patched method. Bind the functions `localStorage` itself resolves:
// jsdom exposes Storage through a proxy whose branded internal-slot check
// rejects `Storage.prototype.getItem.call(localStorage)`.
const rawStorage = window.localStorage;
const rawGetItem = rawStorage.getItem.bind(rawStorage) as (
  key: string,
) => string | null;
const rawSetItem = rawStorage.setItem.bind(rawStorage) as (
  key: string,
  value: string,
) => void;

const nativeStores = vi.hoisted(() => ({
  preferences: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  secureSetError: null as null | "dropped" | "rejected" | "thrown",
  secureDeleteError: null as null | "denied" | "unavailable" | "native_error",
  secureSetWait: null as Promise<void> | null,
  secureDeleteWait: null as Promise<void> | null,
  secureGetWait: null as Promise<void> | null,
  operations: [] as string[],
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: nativeStores.preferences.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      nativeStores.preferences.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      nativeStores.preferences.delete(key);
    },
  },
}));

vi.mock("@elizaos/logger", () => ({
  createLogger: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
  logger: { error: () => undefined },
}));

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
}));

vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) => {
      nativeStores.operations.push(`get:start:${key}`);
      await nativeStores.secureGetWait;
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      nativeStores.operations.push(`get:done:${key}`);
      return nativeStores.secure.has(key)
        ? { ok: true, value: nativeStores.secure.get(key) }
        : { ok: false, error: "not_found" };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      nativeStores.operations.push(`set:start:${key}`);
      await nativeStores.secureSetWait;
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      if (nativeStores.secureSetError === "thrown")
        throw new Error("bridge failed");
      if (nativeStores.secureSetError === "rejected") {
        return { ok: false, error: "denied" };
      }
      if (nativeStores.secureSetError === "dropped") return { ok: true };
      nativeStores.secure.set(key, value);
      nativeStores.operations.push(`set:done:${key}`);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => {
      nativeStores.operations.push(`delete:start:${key}`);
      await nativeStores.secureDeleteWait;
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      if (nativeStores.secureDeleteError) {
        return { ok: false, error: nativeStores.secureDeleteError };
      }
      const deleted = nativeStores.secure.delete(key);
      nativeStores.operations.push(`delete:done:${key}`);
      return { ok: true, deleted };
    },
  },
}));

vi.mock("./electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

vi.mock("./electrobun-rpc", () => ({
  desktopSecureStoreDelete: vi.fn(),
  desktopSecureStoreGet: vi.fn(),
  desktopSecureStoreSet: vi.fn(),
}));

vi.mock("../surface-realm-channel", () => ({
  runAsPrivilegedShell: (operation: () => unknown) => operation(),
}));

describe("native protected-storage bridge contract", () => {
  beforeEach(() => {
    nativeStores.preferences.clear();
    nativeStores.secure.clear();
    nativeStores.secureAvailable = true;
    nativeStores.secureSetError = null;
    nativeStores.secureDeleteError = null;
    nativeStores.secureSetWait = null;
    nativeStores.secureDeleteWait = null;
    nativeStores.secureGetWait = null;
    nativeStores.operations.length = 0;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("protects every native session/runtime record from ever landing in plaintext localStorage", async () => {
    const bridge = await import("./storage-bridge");
    const cases: Array<[string, string]> = [
      ["eliza.device.auth", "device-secret"],
      ["elizaos:active-server", "active-server-secret"],
      ["elizaos:agent-profiles", "agent-profiles-secret"],
      [STEWARD_TOKEN_KEY, "steward-secret"],
    ];
    for (const [key, value] of cases) {
      await bridge.setStorageValue(key, value);
      // The raw Storage prototype (bypassing the secure-store cache) must
      // never see the plaintext value — only the protected native store and
      // the in-memory cache may hold it.
      expect(rawGetItem(key)).toBeNull();
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(await bridge.getStorageValue(key)).toBe(value);
    }
  });

  it("refuses to fall back to plaintext localStorage when a protected write is rejected", async () => {
    const bridge = await import("./storage-bridge");
    nativeStores.secureSetError = "rejected";

    await expect(
      bridge.setStorageValue(STEWARD_TOKEN_KEY, "attempted-plaintext-fallback"),
    ).rejects.toThrow();

    expect(rawGetItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(nativeStores.secure.has("session.steward_token")).toBe(false);
  });

  it("publishes a Steward login only after secure write and exact readback", async () => {
    await import("./storage-bridge");
    const transitions: string[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      nativeStores.secureSetError = "rejected";
      await expect(
        writeStoredStewardToken("not-durable"),
      ).rejects.toMatchObject({ name: "StewardTokenPersistenceError" });
      expect(transitions).toEqual([]);
      expect(nativeStores.secure.has("session.steward_token")).toBe(false);
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();

      nativeStores.secureSetError = "dropped";
      await expect(
        writeStoredStewardToken("not-readable-after-write"),
      ).rejects.toMatchObject({ name: "StewardTokenPersistenceError" });
      expect(transitions).toEqual([]);
      expect(nativeStores.secure.has("session.steward_token")).toBe(false);

      nativeStores.secureSetError = null;
      await writeStoredStewardToken("durable-steward-token");
      expect(nativeStores.secure.get("session.steward_token")).toBe(
        "durable-steward-token",
      );
      expect(transitions).toEqual(["present"]);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("keeps a later Steward token invisible until its own durable write can run", async () => {
    await import("./storage-bridge");
    const transitions: string[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    let releaseFirst: () => void = () => {};
    nativeStores.secureSetWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = writeStoredStewardToken("first-durable-token");
      await vi.waitFor(() => {
        expect(nativeStores.operations).toContain(
          "set:start:session.steward_token",
        );
      });
      const second = writeStoredStewardToken("second-durable-token");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
      expect(
        nativeStores.operations.filter((entry) =>
          entry.startsWith("set:start:"),
        ),
      ).toHaveLength(1);
      expect(transitions).toEqual([]);

      releaseFirst();
      await first;
      expect(transitions).toEqual(["present"]);
      await second;
      expect(nativeStores.secure.get("session.steward_token")).toBe(
        "second-durable-token",
      );
      expect(transitions).toEqual(["present", "present"]);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("does not resurrect a Steward token when a deferred refresh loses to logout", async () => {
    await import("./storage-bridge");
    await writeStoredStewardToken("refresh-source-token");
    const transitions: string[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    let releaseDelete: () => void = () => {};
    nativeStores.secureDeleteWait = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    try {
      const clear = clearStoredStewardToken();
      await vi.waitFor(() => {
        expect(nativeStores.operations).toContain(
          "delete:start:session.steward_token",
        );
      });
      const staleRefresh = replaceStoredStewardTokenIfCurrent(
        "refresh-source-token",
        "stale-refreshed-token",
      );

      releaseDelete();
      await clear;
      await expect(staleRefresh).resolves.toBe(false);
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
      expect(nativeStores.secure.has("session.steward_token")).toBe(false);
      expect(transitions).toEqual(["cleared"]);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("installs the storage proxy before the native secure store responds, so a concurrent write during migration never touches plaintext", async () => {
    nativeStores.preferences.set("eliza.device.auth", "legacy-device-secret");
    // Seed through the raw handle: this must be a genuine pre-migration
    // plaintext value on disk, not a write that a proxy from an earlier test
    // in this file might already intercept.
    rawSetItem("eliza.device.auth", "legacy-device-secret");
    let releaseGet: () => void = () => {};
    nativeStores.secureGetWait = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const bridge = await import("./storage-bridge");
    const init = bridge.initializeStorageBridge();

    // initializeStorageBridge() is now blocked inside its migration loop,
    // awaiting the (still cold) native secure-store GET. If the proxy were
    // installed only after that await resolves, this concurrent write would
    // hit the raw, unpatched Storage prototype and land in plaintext.
    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "get:start:session.device_auth",
      );
    });
    window.localStorage.setItem(
      "eliza.device.auth",
      "concurrent-write-during-migration",
    );
    expect(rawGetItem("eliza.device.auth")).toBeNull();

    // Fail the rest of this migration pass so `initialized` stays false —
    // this file's other tests import the same module singleton and the next
    // one relies on observing a genuinely fresh cold start.
    nativeStores.secureAvailable = false;
    releaseGet();
    await init;

    expect(bridge.isStorageBridgeInitialized()).toBe(false);
    // Drain the concurrent write's deferred native-persist attempt (scheduled
    // via `setTimeout`) so it cannot leak a pending timer into the next test.
    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "set:start:session.device_auth",
      );
    });
    expect(rawGetItem("eliza.device.auth")).toBeNull();
    nativeStores.secureAvailable = true;
  });

  it("serializes concurrent writes to the same key instead of racing", async () => {
    const bridge = await import("./storage-bridge");
    let releaseFirst: () => void = () => {};
    nativeStores.secureSetWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = bridge.setStorageValue("eliza.device.auth", "first-value");
    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "set:start:session.device_auth",
      );
    });

    const second = bridge.setStorageValue("eliza.device.auth", "second-value");
    // The second write must queue behind the first mutation for this key and
    // must not touch the native bridge until the first write's own
    // serialized operation has completed. Give the second call's promise
    // chain real time to run (it is only microtasks away from touching the
    // native bridge if nothing queues it) before asserting it stayed queued.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nativeStores.operations).toEqual(["set:start:session.device_auth"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(nativeStores.operations).toEqual([
      "set:start:session.device_auth",
      "set:done:session.device_auth",
      "get:start:session.device_auth",
      "get:done:session.device_auth",
      "set:start:session.device_auth",
      "set:done:session.device_auth",
      "get:start:session.device_auth",
      "get:done:session.device_auth",
    ]);
    expect(nativeStores.secure.get("session.device_auth")).toBe("second-value");
    expect(await bridge.getStorageValue("eliza.device.auth")).toBe(
      "second-value",
    );
  });

  it("migrates an Android plaintext session only after exact secure read-back", async () => {
    nativeStores.preferences.set("eliza.device.auth", "legacy-device-secret");
    // Seed through the raw handle, not `window.localStorage` — an earlier
    // test in this file may have already installed the storage proxy (it is
    // a one-time, idempotent install on the shared module), and a proxied
    // write to a protected key would route into the secure-store path instead
    // of leaving a genuine pre-migration plaintext value on raw disk.
    rawSetItem("eliza.device.auth", "legacy-device-secret");

    const bridge = await import("./storage-bridge");
    nativeStores.secureAvailable = false;
    await bridge.initializeStorageBridge();
    expect(bridge.isStorageBridgeInitialized()).toBe(false);
    expect(rawGetItem("eliza.device.auth")).toBe("legacy-device-secret");

    nativeStores.secureAvailable = true;
    await bridge.initializeStorageBridge();

    expect(nativeStores.secure.get("session.device_auth")).toBe(
      "legacy-device-secret",
    );
    expect(nativeStores.preferences.has("eliza.device.auth")).toBe(false);
    expect(await bridge.getStorageValue("eliza.device.auth")).toBe(
      "legacy-device-secret",
    );
    expect(window.localStorage.getItem("eliza.device.auth")).toBe(
      "legacy-device-secret",
    );
    expect(rawGetItem("eliza.device.auth")).toBeNull();
    window.sessionStorage.setItem("storage-bridge-probe", "unchanged");
    expect(window.sessionStorage.getItem("storage-bridge-probe")).toBe(
      "unchanged",
    );
    expect(bridge.isStorageBridgeInitialized()).toBe(true);
  }, 60_000);

  it("keeps an awaited Steward write hidden until native verification succeeds", async () => {
    const bridge = await import("./storage-bridge");
    await bridge.initializeStorageBridge();
    await bridge.setStorageValue(STEWARD_TOKEN_KEY, "durable-steward-token");
    nativeStores.operations.length = 0;
    let releaseWrite: () => void = () => {};
    nativeStores.secureSetWait = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const transitions: string[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      const pendingWrite = writeStoredStewardToken("verified-steward-token");
      await vi.waitFor(() => {
        expect(nativeStores.operations).toContain(
          "set:start:session.steward_token",
        );
      });

      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "durable-steward-token",
      );
      expect(transitions).toEqual([]);

      releaseWrite();
      await pendingWrite;
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "verified-steward-token",
      );
      expect(nativeStores.secure.get("session.steward_token")).toBe(
        "verified-steward-token",
      );
      expect(transitions).toEqual(["present"]);

      nativeStores.operations.length = 0;
      nativeStores.secureSetError = "rejected";
      nativeStores.secureSetWait = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const rejectedWrite = writeStoredStewardToken("rejected-steward-token");
      await vi.waitFor(() => {
        expect(nativeStores.operations).toContain(
          "set:start:session.steward_token",
        );
      });
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "verified-steward-token",
      );

      releaseWrite();
      await expect(rejectedWrite).rejects.toMatchObject({
        name: "StewardTokenPersistenceError",
      });
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "verified-steward-token",
      );
      expect(nativeStores.secure.get("session.steward_token")).toBe(
        "verified-steward-token",
      );
      expect(transitions).toEqual(["present"]);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("retains the live and restart credential when native deletion is denied", async () => {
    const bridge = await import("./storage-bridge");
    await bridge.setStorageValue(
      "eliza.device.auth",
      "still-durable-after-failed-delete",
    );
    nativeStores.secureDeleteError = "denied";

    await expect(
      bridge.removeStorageValue("eliza.device.auth"),
    ).rejects.toThrow("Native protected storage rejected deletion");

    expect(nativeStores.secure.get("session.device_auth")).toBe(
      "still-durable-after-failed-delete",
    );
    expect(await bridge.getStorageValue("eliza.device.auth")).toBe(
      "still-durable-after-failed-delete",
    );
  });

  it.each(["rejected", "thrown"] as const)(
    "rolls the live cache back when an awaited protected write is %s",
    async (failureMode) => {
      const bridge = await import("./storage-bridge");
      await bridge.setStorageValue("eliza.device.auth", "durable-secret");
      nativeStores.secureSetError = failureMode;

      await expect(
        bridge.setStorageValue("eliza.device.auth", "rejected-secret"),
      ).rejects.toThrow();

      expect(window.localStorage.getItem("eliza.device.auth")).toBe(
        "durable-secret",
      );
    },
  );

  it("publishes logout only after secure deletion and preserves the restart credential on denial", async () => {
    const bridge = await import("./storage-bridge");
    await bridge.setStorageValue(STEWARD_TOKEN_KEY, "durable-steward-token");
    const transitions: string[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<{ state: string }>).detail.state);
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    nativeStores.secureDeleteError = "denied";

    try {
      await expect(clearStoredStewardToken()).rejects.toThrow(
        "Native protected storage rejected deletion",
      );
      expect(transitions).toEqual([]);
      expect(nativeStores.secure.get("session.steward_token")).toBe(
        "durable-steward-token",
      );
      expect(await bridge.getStorageValue(STEWARD_TOKEN_KEY)).toBe(
        "durable-steward-token",
      );

      nativeStores.secureDeleteError = null;
      await clearStoredStewardToken();
      expect(transitions).toEqual(["cleared"]);
      expect(nativeStores.secure.has("session.steward_token")).toBe(false);
      expect(await bridge.getStorageValue(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("serializes set then delete so a late set cannot resurrect a token", async () => {
    const bridge = await import("./storage-bridge");
    let releaseSet: () => void = () => {};
    nativeStores.secureSetWait = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });

    const write = bridge.setStorageValue("eliza.device.auth", "new-token");
    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "set:start:session.device_auth",
      );
    });
    const removal = bridge.removeStorageValue("eliza.device.auth");
    expect(nativeStores.operations).not.toContain(
      "delete:start:session.device_auth",
    );

    releaseSet();
    await Promise.all([write, removal]);
    expect(nativeStores.operations).toEqual([
      "set:start:session.device_auth",
      "set:done:session.device_auth",
      "get:start:session.device_auth",
      "get:done:session.device_auth",
      "delete:start:session.device_auth",
      "delete:done:session.device_auth",
    ]);
    expect(await bridge.getStorageValue("eliza.device.auth")).toBeNull();
  });

  it("serializes delete then set so a late delete cannot erase a new token", async () => {
    const bridge = await import("./storage-bridge");
    await bridge.setStorageValue("elizaos:active-server", "old-token");
    nativeStores.operations.length = 0;
    let releaseDelete: () => void = () => {};
    nativeStores.secureDeleteWait = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const removal = bridge.removeStorageValue("elizaos:active-server");
    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "delete:start:runtime.active_server",
      );
    });
    const write = bridge.setStorageValue("elizaos:active-server", "new-token");
    expect(nativeStores.operations).not.toContain(
      "set:start:runtime.active_server",
    );

    releaseDelete();
    await Promise.all([removal, write]);
    expect(nativeStores.operations).toEqual([
      "delete:start:runtime.active_server",
      "delete:done:runtime.active_server",
      "set:start:runtime.active_server",
      "set:done:runtime.active_server",
      "get:start:runtime.active_server",
      "get:done:runtime.active_server",
    ]);
    expect(await bridge.getStorageValue("elizaos:active-server")).toBe(
      "new-token",
    );
  });

  it("does not finish active-server teardown before native deletion commits", async () => {
    const bridge = await import("./storage-bridge");
    // Production installs the native storage proxy before any auth/runtime
    // state is published. Model that boot boundary so synchronous persistence
    // readers observe the verified secure-store cache rather than raw disk.
    await bridge.initializeStorageBridge();
    await bridge.setStorageValue(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:previous-account-agent",
        kind: "cloud",
        label: "Previous account agent",
        apiBase: "https://previous-account-agent.cloud.eliza.app",
      }),
    );
    expect(persistence.loadPersistedActiveServer()).not.toBeNull();

    let releaseDelete: () => void = () => {};
    nativeStores.secureDeleteWait = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let settled = false;
    const removal = persistence.clearPersistedActiveServerDurably().then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(nativeStores.operations).toContain(
        "delete:start:runtime.active_server",
      );
    });
    expect(settled).toBe(false);
    expect(persistence.loadPersistedActiveServer()).not.toBeNull();

    releaseDelete();
    await removal;
    expect(settled).toBe(true);
    expect(persistence.loadPersistedActiveServer()).toBeNull();
  });
});
