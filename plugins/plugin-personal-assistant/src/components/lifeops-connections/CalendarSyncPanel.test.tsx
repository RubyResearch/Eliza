// @vitest-environment jsdom
/** Exercises sync review controls with deterministic adapters; no provider requests are sent. */
import type { LifeOpsLinkedCalendarControl } from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarSyncPanel } from "./CalendarSyncPanel.js";

afterEach(cleanup);
const active: LifeOpsLinkedCalendarControl = {
  revision: 7,
  paused: false,
  destination: {
    connectorAccountId: "test-account",
    providerCalendarId: "reviewed-calendar",
  },
  pendingDispatch: null,
};

describe("calendar sync review", () => {
  it("pauses against the displayed revision and renders the accepted result", async () => {
    const adapter = {
      getLinkedCalendarControl: vi.fn(async () => active),
      updateLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        revision: 8,
        paused: true,
      })),
    };
    render(<CalendarSyncPanel adapter={adapter} calendars={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause sync" }));
    await screen.findByText("Synchronization is paused.");
    expect(adapter.updateLinkedCalendarControl).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "pause", expectedRevision: 7 }),
    );
  });

  it("does not show a successful pause when the review is stale and refreshes to current state", async () => {
    const adapter = {
      getLinkedCalendarControl: vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockResolvedValue({ ...active, revision: 10, paused: true }),
      updateLinkedCalendarControl: vi.fn(async () => {
        throw new Error("Calendar sync changed; refresh its review.");
      }),
    };
    render(<CalendarSyncPanel adapter={adapter} calendars={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause sync" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Synchronization is paused.")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh sync status" }),
    );
    await screen.findByText("Synchronization is paused.");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("blocks destination and resume controls while an operation remains pending", async () => {
    const adapter = {
      getLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        paused: true,
        pendingDispatch: { linkId: "pending-link" },
      })),
      updateLinkedCalendarControl: vi.fn(async () => active),
    };
    render(<CalendarSyncPanel adapter={adapter} calendars={[]} />);
    const resume = await screen.findByRole("button", {
      name: "Verify and resume sync",
    });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(resume);
    expect(adapter.updateLinkedCalendarControl).not.toHaveBeenCalled();
  });

  it("checks pending work without resuming and renders only the recovered server state", async () => {
    const adapter = {
      getLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        paused: true,
        pendingDispatch: { linkId: "pending" },
      })),
      updateLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        revision: 8,
        paused: true,
      })),
    };
    render(<CalendarSyncPanel adapter={adapter} calendars={[]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Check pending operation" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Check pending operation" }),
      ).toBeNull(),
    );
    expect(screen.getByText("Synchronization is paused.")).toBeTruthy();
    expect(adapter.updateLinkedCalendarControl).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: "recover", expectedRevision: 7 }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Verify and resume sync",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("discards a pending mutation response after switching connections", async () => {
    let finishPause!: (control: LifeOpsLinkedCalendarControl) => void;
    const oldAdapter = {
      getLinkedCalendarControl: vi.fn(async () => active),
      updateLinkedCalendarControl: vi.fn(
        () =>
          new Promise<LifeOpsLinkedCalendarControl>((resolve) => {
            finishPause = resolve;
          }),
      ),
    };
    const newAdapter = {
      getLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        revision: 42,
      })),
      updateLinkedCalendarControl: vi.fn(async () => ({
        ...active,
        revision: 43,
        paused: true,
      })),
    };
    const view = render(
      <CalendarSyncPanel adapter={oldAdapter} calendars={[]} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pause sync" }));
    view.rerender(<CalendarSyncPanel adapter={newAdapter} calendars={[]} />);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Pause sync",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () =>
      finishPause({ ...active, revision: 8, paused: true }),
    );
    expect(screen.queryByText("Synchronization is paused.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause sync" }));
    await screen.findByText("Synchronization is paused.");
    expect(newAdapter.updateLinkedCalendarControl).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "pause", expectedRevision: 42 }),
    );
  });

  it("offers retry after a failed initial read without offering mutation controls", async () => {
    const adapter = {
      getLinkedCalendarControl: vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection unavailable"))
        .mockResolvedValue({ ...active, paused: true }),
      updateLinkedCalendarControl: vi.fn(async () => active),
    };
    render(<CalendarSyncPanel adapter={adapter} calendars={[]} />);
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Verify and resume sync" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh sync status" }),
    );
    await screen.findByRole("button", { name: "Verify and resume sync" });
    expect(adapter.updateLinkedCalendarControl).not.toHaveBeenCalled();
  });
});
