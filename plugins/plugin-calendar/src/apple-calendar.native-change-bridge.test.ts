/** Exercises the packaged Bun FFI EventKit notification transport, including delivery and teardown. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ffi = vi.hoisted(() => {
  let generation = 0;
  const symbols = {
    listAppleCalendarsJson: vi.fn(() => 0),
    listAppleCalendarEventsJson: vi.fn(() => 0),
    createAppleCalendarEventJson: vi.fn(() => 0),
    updateAppleCalendarEventJson: vi.fn(() => 0),
    deleteAppleCalendarEventJson: vi.fn(() => 0),
    freeNativeCString: vi.fn(),
    elizaCalendarStoreChangesStart: vi.fn(() => true),
    elizaCalendarStoreChangesPoll: vi.fn(() => generation),
    elizaCalendarStoreChangesStop: vi.fn(),
  };
  return {
    symbols,
    dlopen: vi.fn(() => ({ symbols, close: vi.fn() })),
    setGeneration(value: number) {
      generation = value;
    },
  };
});

vi.mock("bun:ffi", () => ({
  CString: class {
    toString() {
      return "";
    }
  },
  FFIType: { ptr: 0, f64: 1, i32: 2, bool: 3, void: 4 },
  dlopen: ffi.dlopen,
  ptr: vi.fn(() => 1),
}));

vi.mock("@elizaos/shared/platform/native-library-policy", () => ({
  resolveNativeLibraryCandidate: vi.fn(
    () =>
      "/Applications/Eliza.app/Contents/Resources/libMacWindowEffects.dylib",
  ),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

describe("Apple Calendar native change ABI", () => {
  let calendar: typeof import("./apple-calendar.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ffi.setGeneration(0);
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    // Load the cold module graph before measuring the listener lifecycle.
    calendar = await import("./apple-calendar.js");
    vi.useFakeTimers();
  }, 120_000);

  afterEach(() => {
    vi.useRealTimers();
    if (originalPlatform)
      Object.defineProperty(process, "platform", originalPlatform);
  });

  it("registers, delivers a generation change, and unsubscribes idempotently", async () => {
    const listener = vi.fn();
    const subscription =
      await calendar.subscribeNativeAppleCalendarChanges(listener);

    expect(subscription).not.toBeNull();
    expect(ffi.symbols.elizaCalendarStoreChangesStart).toHaveBeenCalledOnce();
    ffi.setGeneration(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(listener).toHaveBeenCalledWith({ observedAt: expect.any(String) });

    await subscription?.remove();
    await subscription?.remove();
    expect(ffi.symbols.elizaCalendarStoreChangesStop).toHaveBeenCalledOnce();
    ffi.setGeneration(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledOnce();
  }, 15_000);

  it("isolates a failing reentrant listener from the remaining subscribers", async () => {
    let firstSubscription: { remove: () => Promise<void> } | null | undefined;
    const first = vi.fn(() => {
      void firstSubscription?.remove();
      throw new Error("listener failed");
    });
    const second = vi.fn();
    firstSubscription =
      await calendar.subscribeNativeAppleCalendarChanges(first);
    const secondSubscription =
      await calendar.subscribeNativeAppleCalendarChanges(second);

    expect(ffi.symbols.elizaCalendarStoreChangesStart).toHaveBeenCalledOnce();
    ffi.setGeneration(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(ffi.symbols.elizaCalendarStoreChangesStop).not.toHaveBeenCalled();

    await secondSubscription?.remove();
    expect(ffi.symbols.elizaCalendarStoreChangesStop).toHaveBeenCalledOnce();
  }, 15_000);
});
