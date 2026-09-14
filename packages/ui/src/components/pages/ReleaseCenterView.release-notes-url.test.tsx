/**
 * The release-notes URL field is the one editable input in Release Center, and
 * every updater refresh writes to it after awaiting the desktop bridge. These
 * tests pin that a snapshot landing mid-edit cannot discard what the user
 * typed, while an untouched field still follows the snapshot.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: bridge.invoke,
  isElectrobunRuntime: () => true,
  subscribeDesktopBridgeEvent: () => () => {},
}));
vi.mock("../../config/branding", () => ({
  useBranding: () => ({ appUrl: "https://app.example/" }),
}));
vi.mock("../../services/app-updates/update-policy", () => ({
  getApplicationUpdateSnapshot: vi.fn().mockResolvedValue(null),
  mapAgentUpdateStatusToSnapshot: () => null,
}));
vi.mock("../../utils", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../../utils/desktop-workspace", () => ({
  openDesktopSurfaceWindow: vi.fn(),
}));
vi.mock("../../state", () => ({
  useAppSelectorShallow: (select: (state: unknown) => unknown) =>
    select({
      loadUpdateStatus: vi.fn().mockResolvedValue(undefined),
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
      updateLoading: false,
      updateStatus: null,
    }),
}));

import { ReleaseCenterView } from "./ReleaseCenterView";

const INITIAL_URL = "https://initial.example/notes";
const CHECKED_URL = "https://from-check.example/notes";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Render with the update check held in flight, and return the field. */
async function renderWithPendingCheck() {
  const pending = deferred<{ baseUrl: string; canAutoUpdate: boolean }>();
  bridge.invoke.mockImplementation((args: { rpcMethod: string }) =>
    args.rpcMethod === "desktopCheckForUpdates"
      ? pending.promise
      : Promise.resolve({ baseUrl: INITIAL_URL, canAutoUpdate: true }),
  );

  render(<ReleaseCenterView />);
  await flush();
  const field = screen.getAllByRole("textbox")[0] as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe(INITIAL_URL));

  const checkButton = screen
    .getAllByRole("button")
    .find((button) => (button.textContent ?? "").includes("Check"));
  if (!checkButton) throw new Error("Check / Download Update button not found");
  fireEvent.click(checkButton);
  await act(async () => {
    await Promise.resolve();
  });

  return {
    field,
    settle: async () => {
      pending.resolve({ baseUrl: CHECKED_URL, canAutoUpdate: true });
      await flush();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Release Center release-notes URL", () => {
  it("keeps a URL typed while an update check was in flight", async () => {
    const { field, settle } = await renderWithPendingCheck();

    fireEvent.change(field, {
      target: { value: "https://typed-by-user.test/n" },
    });
    await settle();

    // The dirty flag used to be read from the closure captured before the
    // await, so it was still `false` here and the snapshot won.
    expect(field.value).toBe("https://typed-by-user.test/n");
  });

  it("still adopts the checked snapshot URL when the user did not type", async () => {
    // Liveness control: without this, the assertion above would pass just as
    // well if the field stopped following updater snapshots altogether.
    const { field, settle } = await renderWithPendingCheck();
    await settle();
    expect(field.value).toBe(CHECKED_URL);
  });

  it("does not re-run the updater refresh just because the field was edited", async () => {
    bridge.invoke.mockResolvedValue({
      baseUrl: INITIAL_URL,
      canAutoUpdate: true,
    });
    render(<ReleaseCenterView />);
    await flush();
    const field = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe(INITIAL_URL));

    const before = bridge.invoke.mock.calls.length;
    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(field, { target: { value } });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // The refresh callback used to take the dirty flag as a dependency, so the
    // first keystroke changed its identity and re-ran the effects holding it.
    expect(bridge.invoke.mock.calls.length).toBe(before);
  });
});
