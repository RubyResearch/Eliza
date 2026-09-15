/**
 * Verifies that Notes is a read-only projection of authoritative capability
 * state across loading, empty, populated, and error conditions.
 *
 * @vitest-environment jsdom
 */

import { ApiError } from "@elizaos/ui/api/client-types-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesSnapshot, StickyNote } from "../types.js";
import type { NotesState } from "./useNotesState.js";

const stateHook = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: (definition: { id: string }) => ({
    ref: { current: null },
    agentProps: { "data-agent-id": definition.id },
  }),
}));

vi.mock(
  "@elizaos/ui/components/shared/ViewHeader",
  () => import("../../../../packages/ui/src/components/shared/ViewHeader.tsx"),
);

vi.mock("./useNotesState.js", () => ({
  useNotesState: stateHook,
}));

import { NotesView } from "./NotesView.js";

function snapshot(revision: number): NotesSnapshot {
  return { notes: [], revision };
}

function stickyNote(overrides: Partial<StickyNote> = {}): StickyNote {
  return {
    id: "note-1",
    title: "Release checklist",
    body: "Verify the signed build",
    color: "yellow",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function hookState(overrides: Partial<NotesState> = {}): NotesState {
  return {
    snapshot: null,
    loading: false,
    busy: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    ...overrides,
  };
}

function sharedNotesUnavailable(): ApiError {
  const data = {
    success: false,
    code: "notes_runtime_unavailable",
    error:
      "Notes require a dedicated agent runtime; this shared agent does not have a persistent notes store.",
    capability: "notes",
    requiredExecutionTier: "dedicated-always",
    upgradeRequired: true,
    retryable: false,
  } as const;
  return new ApiError({
    kind: "http",
    path: "/api/notes/state",
    status: 503,
    code: data.code,
    message: data.error,
    data,
  });
}

function expectNoDirectControls(container: HTMLElement): void {
  const content = container.querySelector(
    '[data-testid="simple-notes-scroll-region"]',
  );
  expect(content).not.toBeNull();
  expect(content?.querySelector("form")).toBeNull();
  expect(content?.querySelector("button")).toBeNull();
  expect(content?.querySelector("input")).toBeNull();
  expect(content?.querySelector("textarea")).toBeNull();
  expect(content?.querySelector("select")).toBeNull();
}

beforeEach(() => {
  stateHook.mockReset();
  window.history.replaceState(null, "", "/notes");
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Notes state labels", () => {
  it("keeps standalone Notes accessible without a repeated title or launcher button", () => {
    const notesSnapshot = snapshot(4);
    notesSnapshot.notes = [stickyNote()];
    stateHook.mockReturnValue(hookState({ snapshot: notesSnapshot }));
    const notes = render(<NotesView standalone />);
    expect(
      screen.getByRole("main", {
        name: "Notes. 1 note.",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Notes" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
    expect(screen.getByText("Verify the signed build")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
    notes.unmount();
  });

  it("defaults to shell-owned route chrome", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));
    render(<NotesView />);

    expect(screen.queryByTestId("view-header")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
  });

  it.each([
    { height: 499, label: "compact", width: 315 },
    { height: 800, label: "desktop", width: 1280 },
  ])(
    "keeps one semantic collection inside one scroll owner at $label size",
    ({ height, width }) => {
      Object.defineProperties(window, {
        innerHeight: { configurable: true, value: height },
        innerWidth: { configurable: true, value: width },
      });
      const surfaceSnapshot = snapshot(1);
      surfaceSnapshot.notes = [stickyNote()];
      stateHook.mockReturnValue(hookState({ snapshot: surfaceSnapshot }));
      const notes = render(<NotesView />);
      const notesRoot = notes.getByTestId("simple-notes-view");
      const notesScroll = notes.getByTestId("simple-notes-scroll-region");
      const rail = notesRoot.querySelector<HTMLElement>(
        '[data-slot="page-panel-content-rail"]',
      );

      expect(notesRoot.tagName).toBe("MAIN");
      expect(notesScroll.parentElement).toBe(notesRoot);
      expect(notesScroll.tabIndex).toBe(0);
      expect(
        notesRoot.querySelectorAll('[data-slot="page-panel-content-rail"]'),
      ).toHaveLength(1);
      expect(rail).not.toBeNull();
      expect(notesScroll.contains(rail)).toBe(true);
      expect(rail?.style.paddingBlockStart).toContain("--view-pad-top");
      expect(rail?.style.paddingBlockEnd).toContain("--view-pad-bottom");
      expect(notesScroll.getAttribute("style") ?? "").not.toContain(
        "safe-area",
      );
      expect(notesScroll.getAttribute("style") ?? "").not.toContain(
        "eliza-chat-clearance",
      );
      expect(rail?.getAttribute("style") ?? "").not.toContain("safe-area");
      expect(rail?.getAttribute("style") ?? "").not.toContain(
        "eliza-chat-clearance",
      );
      const notesList = notes.getByRole("list");
      expect(notesList).toBe(notes.getByTestId("simple-notes-list"));
      expect(rail?.contains(notesList)).toBe(true);
      notes.unmount();
    },
  );

  it("keeps cached Notes labels and content stable across background refreshes", () => {
    const cached = snapshot(4);
    cached.notes = [stickyNote()];
    stateHook.mockReturnValue(hookState({ snapshot: cached }));
    const notes = render(<NotesView />);
    const helper = screen.getByText("Ask Eliza to create or edit");
    const content = screen.getByText("Verify the signed build");
    for (const loading of [true, false, true, false]) {
      stateHook.mockReturnValue(hookState({ snapshot: cached, loading }));
      notes.rerender(<NotesView />);
      const main = screen.getByRole("main", { name: "Notes. 1 note." });
      expect(main.getAttribute("aria-busy")).toBe(String(loading));
      expect(screen.getByText("Ask Eliza to create or edit")).toBe(helper);
      expect(screen.getByText("Verify the signed build")).toBe(content);
      expect(screen.queryByText("Refreshing")).toBeNull();
      expect(
        screen.queryByRole("status", { name: "Loading notes" }),
      ).toBeNull();
    }
  });

  it("does not report healthy zero counts before the first snapshot", () => {
    stateHook.mockReturnValue(hookState({ loading: true }));
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Loading.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading notes" })).toBeTruthy();
    expect(screen.queryByText(/0 notes/)).toBeNull();
  });

  it("distinguishes synchronization errors from healthy empty state", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    stateHook.mockReturnValue(
      hookState({
        snapshot: snapshot(4),
        error: new Error("Agent disconnected"),
        refresh,
      }),
    );
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Sync unavailable.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Notes are offline",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Reconnect to Eliza to see your saved notes.",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 notes/)).toBeNull();
    expect(screen.queryByText("No notes yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("replaces a generic missing endpoint response with useful runtime copy", () => {
    stateHook.mockReturnValue(
      hookState({
        error: new ApiError({
          kind: "http",
          path: "/api/notes/state",
          status: 404,
          message: "Not found",
        }),
      }),
    );

    render(<NotesView />);

    const alert = screen.getByRole("alert");
    expect(alert.classList.contains("min-h-[58vh]")).toBe(true);
    expect(alert.textContent).toContain("Notes unavailable");
    expect(alert.textContent).toContain(
      "The Notes service is unavailable on this runtime.",
    );
    expect(alert.textContent).not.toContain("Not found");
    expect(
      screen.queryByRole("button", { name: /retry|try again/i }),
    ).toBeNull();
  });

  it("keeps cached notes visible when a refresh fails", () => {
    const stale = snapshot(5);
    stale.notes = [stickyNote()];
    const refresh = vi.fn().mockResolvedValue(undefined);
    stateHook.mockReturnValue(
      hookState({
        snapshot: stale,
        error: new Error("Agent disconnected"),
        refresh,
      }),
    );

    const notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Sync unavailable. Showing 1 note.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Notes are offline",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Agent disconnected",
    );
    expect(notes.getByText("Release checklist")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Notes" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renders Shared unavailability as Dedicated guidance without a futile retry", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    stateHook.mockReturnValue(
      hookState({ error: sharedNotesUnavailable(), refresh }),
    );

    render(<NotesView />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Notes need a Dedicated agent",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Connect a Dedicated agent to keep a persistent Notes collection.",
    );
    expect(
      screen.queryByRole("button", { name: /retry|try again/i }),
    ).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps cached Notes truthful when Shared unavailability replaces a prior sync", () => {
    const stale = snapshot(8);
    stale.notes = [stickyNote()];
    const refresh = vi.fn().mockResolvedValue(undefined);
    stateHook.mockReturnValue(
      hookState({
        snapshot: stale,
        error: sharedNotesUnavailable(),
        refresh,
      }),
    );

    render(<NotesView />);

    expect(screen.getByText("Release checklist")).toBeTruthy();
    expect(screen.getByText("Last available snapshot")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Notes need a Dedicated agent",
    );
    expect(
      screen.queryByRole("button", { name: /retry|try again/i }),
    ).toBeNull();
    expect(screen.queryByText("No notes yet")).toBeNull();
  });

  it("reports empty counts only after a successful snapshot", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(7) }));
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. 0 notes.",
      }),
    ).toBeTruthy();
    const emptyTitle = screen.getByText("No notes yet");
    expect(emptyTitle).toBeTruthy();
    expect(
      emptyTitle.parentElement?.parentElement?.classList.contains(
        "min-h-[58vh]",
      ),
    ).toBe(true);
    expect(screen.getByText("Ask Eliza to save something here.")).toBeTruthy();
  });

  it("uses calm controlled copy for server and rate-limit failures", () => {
    stateHook.mockReturnValue(
      hookState({
        error: new ApiError({
          kind: "http",
          path: "/api/notes/state",
          status: 502,
          message: "upstream socket exploded with internal detail",
        }),
      }),
    );
    const { rerender } = render(<NotesView />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Notes are temporarily unavailable",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "upstream socket",
    );

    stateHook.mockReturnValue(
      hookState({
        error: new ApiError({
          kind: "http",
          path: "/api/notes/state",
          status: 429,
          message: "rate limited",
        }),
      }),
    );
    rerender(<NotesView />);
    expect(screen.getByRole("alert").textContent).toContain("Notes are busy");
    expect(screen.getByRole("alert").textContent).toContain(
      "Wait a moment, then try again.",
    );
  });
});

describe("chat-only presentation", () => {
  it("renders authoritative notes without direct mutation controls", () => {
    const populated = snapshot(4);
    populated.notes = [stickyNote()];
    const mutate = vi.fn();
    stateHook.mockReturnValue(hookState({ snapshot: populated, mutate }));

    const notes = render(<NotesView />);

    const note = notes.container.querySelector('[data-agent-id="note-1"]');
    expect(note?.querySelector("h2")?.textContent).toBe("Release checklist");
    expect(note?.querySelector("p")?.textContent).toBe(
      "Verify the signed build",
    );
    expect(note?.getAttribute("data-agent-id")).toBe("note-1");
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expectNoDirectControls(notes.container);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps long and international note content intact in the collection", () => {
    const populated = snapshot(5);
    populated.notes = [
      stickyNote({
        title: "研究メモ 🌏 ".repeat(12),
        body: "هذا نص طويل للاختبار\n".repeat(8),
      }),
      stickyNote({ id: "note-2", title: "One character", body: "x" }),
    ];
    stateHook.mockReturnValue(hookState({ snapshot: populated }));

    render(<NotesView />);

    expect(
      screen.getByRole("heading", { level: 2, name: /研究メモ/ }),
    ).toBeTruthy();
    expect(screen.getByText(/هذا نص طويل للاختبار/)).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const firstRow = rows[0] as HTMLElement;
    const firstHeading = firstRow.querySelector<HTMLElement>("h2");
    const firstBody = firstRow.querySelector<HTMLElement>("p");
    if (!firstHeading || !firstBody) {
      throw new Error("The first Notes row is missing its content hierarchy.");
    }
    expect(firstHeading.style.overflowWrap).toBe("anywhere");
    expect(firstBody.style.overflowWrap).toBe("anywhere");
  });
});
