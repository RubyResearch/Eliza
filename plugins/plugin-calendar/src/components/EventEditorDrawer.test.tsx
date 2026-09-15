// @vitest-environment jsdom

/**
 * Tests for the EventEditorDrawer create/edit form: field population, attendee
 * editing, and submit-payload shape in jsdom against fixture calendars (no live
 * service).
 */

import type {
  LifeOpsCalendarEvent,
  ListLifeOpsCalendarsResponse,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @elizaos/ui: spied calendar client + lightweight form-control stubs.
// ---------------------------------------------------------------------------

const uiClient = vi.hoisted(() => ({
  getLifeOpsCalendars: vi.fn(),
  createLifeOpsCalendarEvent: vi.fn(),
  updateLifeOpsCalendarEvent: vi.fn(),
  deleteLifeOpsCalendarEvent: vi.fn(),
}));

vi.mock("@elizaos/ui", () => {
  const Input = forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => <input ref={ref} {...props} />);
  Input.displayName = "Input";

  const Textarea = forwardRef<
    HTMLTextAreaElement,
    React.TextareaHTMLAttributes<HTMLTextAreaElement>
  >((props, ref) => <textarea ref={ref} {...props} />);
  Textarea.displayName = "Textarea";

  // The drawer imports `../api/client-calendar.js` for its side effect, which
  // augments `ElizaClient.prototype`. Provide a throwaway class so that import
  // resolves; we exercise the spied `client` object, not the prototype.
  class ElizaClient {
    fetch = vi.fn(async () => ({}) as never);
  }

  const appValue = {
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setActionNotice: vi.fn(),
  };

  return {
    ElizaClient,
    client: uiClient,
    Button: forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement>
    >(({ children, ...props }, ref) => (
      <button type="button" ref={ref} {...props}>
        {children}
      </button>
    )),
    Input,
    Textarea,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({
      children,
      ...props
    }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    // Native-select stub: walks SelectItem descendants to build selectable
    // <option>s (value/onValueChange) AND renders the raw children so the
    // SelectItem summary/account text is queryable in the DOM.
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => {
      const options: string[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
          return;
        }
        if (node && typeof node === "object" && "props" in node) {
          // biome-ignore lint/suspicious/noExplicitAny: test stub introspection
          const anyNode = node as any;
          if (anyNode.props?.["data-select-item-value"]) {
            options.push(anyNode.props["data-select-item-value"]);
          }
          walk(anyNode.props?.children);
        }
      };
      walk(children);
      return (
        <div data-testid="calendar-select-wrap">
          <select
            data-testid="calendar-select"
            value={options.includes(value) ? value : ""}
            onChange={(e) => onValueChange(e.target.value)}
          >
            {!options.includes(value) ? <option value="">--</option> : null}
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {/* render raw items so their text/labels appear in the DOM */}
          <div data-testid="calendar-select-items">{children}</div>
        </div>
      );
    },
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => (
      <div data-select-item data-select-item-value={value}>
        {children}
      </div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    TagEditor: ({
      items,
      onChange,
      placeholder,
    }: {
      items: string[];
      onChange: (items: string[]) => void;
      placeholder?: string;
    }) => (
      <div data-testid="tag-editor">
        {items.map((item) => (
          <span key={item} data-testid="attendee-chip">
            {item}
          </span>
        ))}
        <input
          data-testid="attendee-input"
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const value = (e.target as HTMLInputElement).value;
              onChange([...items, value]);
            }
          }}
        />
      </div>
    ),
    ConfirmDialog: ({
      open,
      message,
      confirmLabel = "Confirm",
      onConfirm,
      onCancel,
    }: {
      open: boolean;
      message: string;
      confirmLabel?: string;
      onConfirm: () => void;
      onCancel: () => void;
    }) =>
      open ? (
        <div data-testid="confirm-dialog">
          <span>{message}</span>
          <button
            type="button"
            data-testid="confirm-delete"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            cancel
          </button>
        </div>
      ) : null,
    useApp: () => appValue,
    useAppSelector: <T,>(selector: (value: typeof appValue) => T) =>
      selector(appValue),
    useAppSelectorShallow: <T,>(selector: (value: typeof appValue) => T) =>
      selector(appValue),
  };
});

vi.mock("@elizaos/ui/api", () => ({
  client: uiClient,
  ElizaClient: class {
    fetch = vi.fn(async () => ({}));
  },
}));

vi.mock("@elizaos/ui/components", async () => {
  return await vi.importMock<Record<string, unknown>>("@elizaos/ui");
});

vi.mock("@elizaos/ui/state", async () => {
  const ui = await vi.importMock<{
    useApp: () => unknown;
    useAppSelector: <T>(selector: (value: unknown) => T) => T;
    useAppSelectorShallow: <T>(selector: (value: unknown) => T) => T;
  }>("@elizaos/ui");
  return {
    useApp: ui.useApp,
    useAppSelector: ui.useAppSelector,
    useAppSelectorShallow: ui.useAppSelectorShallow,
  };
});

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

import {
  EventEditorDrawer,
  eventEditorMutability,
} from "./EventEditorDrawer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const calendarsResponse: ListLifeOpsCalendarsResponse = {
  calendars: [
    {
      provider: "google",
      side: "owner",
      grantId: "connector-account:acct-1",
      connectorAccountId: "acct-1",
      accountEmail: "owner@example.com",
      calendarId: "owner@example.com",
      summary: "Owner Calendar",
      description: null,
      primary: true,
      accessRole: "owner",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/New_York",
      selected: true,
      includeInFeed: true,
      selectionVersion: 0,
    },
    {
      provider: "google",
      side: "owner",
      grantId: "connector-account:acct-1",
      connectorAccountId: "acct-1",
      accountEmail: "owner@example.com",
      calendarId: "team@example.com",
      summary: "Team Calendar",
      description: null,
      primary: false,
      accessRole: "writer",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/New_York",
      selected: true,
      includeInFeed: true,
      selectionVersion: 0,
    },
  ],
};

const editEvent: LifeOpsCalendarEvent = {
  id: "agent-1:google:owner:calendar:owner@example.com:evt_1",
  externalId: "evt_1",
  agentId: "agent-1",
  provider: "google",
  side: "owner",
  calendarId: "owner@example.com",
  title: "Quarterly review",
  description: "Numbers walkthrough",
  location: "HQ Boardroom",
  status: "confirmed",
  startAt: new Date(2026, 5, 17, 14, 0, 0).toISOString(),
  endAt: new Date(2026, 5, 17, 15, 0, 0).toISOString(),
  isAllDay: false,
  timezone: "America/New_York",
  htmlLink: null,
  conferenceLink: null,
  organizer: { self: true, email: "owner@example.com" },
  attendees: [
    {
      email: "cfo@example.com",
      displayName: "CFO",
      responseStatus: null,
      self: false,
      organizer: false,
      optional: false,
    },
  ],
  metadata: { etag: '"event-editor-v1"' },
  syncedAt: new Date(2026, 5, 16).toISOString(),
  updatedAt: new Date(2026, 5, 16).toISOString(),
  grantId: "connector-account:acct-1",
};

function saveButton(): HTMLButtonElement {
  // The primary action button's accessible name comes from its sr-only span
  // ("Create" in create mode, "Save" in edit mode).
  return screen
    .getByText("Create", { selector: "span.sr-only" })
    .closest("button") as HTMLButtonElement;
}

function editSaveButton(): HTMLButtonElement {
  return screen
    .getByText("Save", { selector: "span.sr-only" })
    .closest("button") as HTMLButtonElement;
}

describe("EventEditorDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiClient.getLifeOpsCalendars.mockResolvedValue(calendarsResponse);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows local save separately from pending Google delivery and clears it after sync", () => {
    const saved: LifeOpsCalendarEvent = {
      ...editEvent,
      provider: "eliza",
      grantId: "eliza-calendar",
      calendarId: "primary",
      metadata: {
        etag: '"eliza-2"',
        version: 2,
        deduplication: {
          pendingUpdate: { linkId: "reviewed-link", snapshots: [editEvent] },
        },
      },
    };
    const view = render(
      <EventEditorDrawer open mode="edit" event={saved} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Google calendar update pending",
    );
    expect(screen.getByText("Save", { selector: "span.sr-only" })).toBeTruthy();
    view.rerender(
      <EventEditorDrawer
        open
        mode="edit"
        event={{ ...saved, metadata: { etag: '"eliza-2"', version: 2 } }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(uiClient.updateLifeOpsCalendarEvent).not.toHaveBeenCalled();
    expect(uiClient.createLifeOpsCalendarEvent).not.toHaveBeenCalled();
  });

  // ----- create mode --------------------------------------------------------

  it.each([
    ["2026-03-08", "2026-03-08", "2026-03-09"],
    ["2026-10-31", "2026-11-02", "2026-11-03"],
    ["2028-02-29", "2028-02-29", "2028-03-01"],
  ])(
    "creates an all-day civil interval starting %s without timed bounds",
    async (first, last, exclusive) => {
      uiClient.createLifeOpsCalendarEvent.mockResolvedValue({
        outcome: "event",
        event: editEvent,
        writeOnlyReceipt: null,
      });
      const onCreated = vi.fn();
      render(
        <EventEditorDrawer
          open
          mode="create"
          event={null}
          onClose={vi.fn()}
          onCreated={onCreated}
        />,
      );
      fireEvent.change(screen.getByLabelText("Event title"), {
        target: { value: "School closed" },
      });
      await waitFor(() => expect(saveButton().disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "All day" }));
      fireEvent.change(
        document.getElementById("event-editor-start-at") as HTMLInputElement,
        { target: { value: first } },
      );
      fireEvent.change(
        document.getElementById("event-editor-end-at") as HTMLInputElement,
        { target: { value: last } },
      );
      fireEvent.click(saveButton());
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      const request = uiClient.createLifeOpsCalendarEvent.mock.calls[0][0];
      expect(request.allDay).toEqual({
        startDate: first,
        endDateExclusive: exclusive,
      });
      expect(request.startAt).toBeUndefined();
      expect(request.endAt).toBeUndefined();
    },
  );

  it("rejects reversed all-day dates before dispatch", async () => {
    render(
      <EventEditorDrawer open mode="create" event={null} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "School closed" },
    });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "All day" }));
    fireEvent.change(
      document.getElementById("event-editor-start-at") as HTMLInputElement,
      { target: { value: "2026-03-09" } },
    );
    fireEvent.change(
      document.getElementById("event-editor-end-at") as HTMLInputElement,
      { target: { value: "2026-03-08" } },
    );
    fireEvent.click(saveButton());
    expect(uiClient.createLifeOpsCalendarEvent).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Choose valid dates with the last day on or after the first day.",
      ),
    ).toBeTruthy();
  });

  it("preserves civil dates when renaming an existing all-day event", async () => {
    const event = {
      ...editEvent,
      isAllDay: true,
      startAt: "2026-03-08T00:00:00.000Z",
      endAt: "2026-03-10T00:00:00.000Z",
    };
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({ event });
    const onSaved = vi.fn();
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={event}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await waitFor(() => expect(editSaveButton().disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Updated school closure" },
    });
    fireEvent.click(editSaveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const patch = uiClient.updateLifeOpsCalendarEvent.mock.calls[0][1];
    expect(patch.allDay).toEqual({
      startDate: "2026-03-08",
      endDateExclusive: "2026-03-10",
    });
    expect(patch.startAt).toBeUndefined();
    expect(patch.endAt).toBeUndefined();
  });

  it("converts an edited all-day date range to timed bounds only on explicit selection", async () => {
    const event = {
      ...editEvent,
      isAllDay: true,
      startAt: "2026-03-08T00:00:00.000Z",
      endAt: "2026-03-09T00:00:00.000Z",
    };
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({ event });
    const onSaved = vi.fn();
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={event}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await waitFor(() => expect(editSaveButton().disabled).toBe(false));
    fireEvent.change(
      document.getElementById("event-editor-start-at") as HTMLInputElement,
      { target: { value: "2026-03-10" } },
    );
    fireEvent.change(
      document.getElementById("event-editor-end-at") as HTMLInputElement,
      { target: { value: "2026-03-10" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Timed", exact: true }));
    fireEvent.click(editSaveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const patch = uiClient.updateLifeOpsCalendarEvent.mock.calls[0][1];
    expect(patch.allDay).toBeUndefined();
    expect(patch.startAt).toBe(new Date(2026, 2, 10, 9, 0).toISOString());
    expect(patch.endAt).toBe(new Date(2026, 2, 10, 9, 30).toISOString());
  });

  it("seeds a blank create form with a next-half-hour start window", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{
          date: new Date(2026, 5, 15, 9, 12, 0),
          side: "owner",
        }}
        onClose={vi.fn()}
      />,
    );

    const title = screen.getByLabelText("Event title") as HTMLInputElement;
    expect(title.value).toBe("");

    const start = document.getElementById(
      "event-editor-start-at",
    ) as HTMLInputElement;
    const end = document.getElementById(
      "event-editor-end-at",
    ) as HTMLInputElement;
    // 09:12 rounds up to the next half hour -> 09:30, end +30min -> 10:00.
    expect(start.value).toBe("2026-06-15T09:30");
    expect(end.value).toBe("2026-06-15T10:00");

    // Create button is disabled while the title is empty.
    expect(saveButton().disabled).toBe(true);
  });

  it("populates the calendar select from getLifeOpsCalendars", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ side: "owner" }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalledWith({
        side: "owner",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Owner Calendar")).toBeTruthy(),
    );
    expect(screen.getByText("Team Calendar")).toBeTruthy();
  });

  it("blocks saving instead of fabricating a Primary calendar when source discovery fails", async () => {
    uiClient.getLifeOpsCalendars.mockRejectedValue(new Error("boom"));

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ side: "owner" }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(screen.queryByText("Primary")).toBeNull();
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee" },
    });
    expect(saveButton().disabled).toBe(true);
  });

  it("creates an event with the trimmed title/start/end and fires onCreated", async () => {
    uiClient.createLifeOpsCalendarEvent.mockResolvedValue({
      outcome: "event",
      event: { ...editEvent, id: "new-id", title: "Coffee" },
      writeOnlyReceipt: null,
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ date: new Date(2026, 5, 15, 9, 0, 0), side: "owner" }}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "  Coffee  " },
    });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(uiClient.createLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    const request = uiClient.createLifeOpsCalendarEvent.mock.calls[0][0];
    expect(request.title).toBe("Coffee"); // trimmed
    expect(request.side).toBe("owner");
    expect(request.startAt).toContain("2026-06-15T");
    expect(request.endAt).toContain("2026-06-15T");
    expect(typeof request.timeZone).toBe("string");
    expect(request.idempotencyKey).toMatch(/^event-editor:/);
    expect(request.notifyAttendees).toBe(false);

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reuses the create idempotency key after an ambiguous client failure", async () => {
    uiClient.createLifeOpsCalendarEvent
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({
        outcome: "event",
        event: { ...editEvent, id: "new-id", title: "Coffee" },
        writeOnlyReceipt: null,
      });

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ date: new Date(2026, 5, 15, 9, 0, 0), side: "owner" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee" },
    });

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText("connection closed")).toBeTruthy(),
    );
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(uiClient.createLifeOpsCalendarEvent).toHaveBeenCalledTimes(2),
    );

    const first = uiClient.createLifeOpsCalendarEvent.mock.calls[0]?.[0];
    const second = uiClient.createLifeOpsCalendarEvent.mock.calls[1]?.[0];
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });

  it("rotates the create idempotency key when the owner edits a failed request", async () => {
    uiClient.createLifeOpsCalendarEvent
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce({
        outcome: "event",
        event: { ...editEvent, id: "new-id", title: "Coffee with Sam" },
        writeOnlyReceipt: null,
      });

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{
          date: new Date(2026, 5, 15, 9, 0, 0),
          side: "owner",
        }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Owner Calendar")).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText("connection closed")).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee with Sam" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(uiClient.createLifeOpsCalendarEvent).toHaveBeenCalledTimes(2),
    );

    const first = uiClient.createLifeOpsCalendarEvent.mock.calls[0]?.[0];
    const second = uiClient.createLifeOpsCalendarEvent.mock.calls[1]?.[0];
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it("surfaces an invalid-times error when start/end are cleared", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ date: new Date(2026, 5, 15, 9, 0, 0), side: "owner" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee" },
    });
    fireEvent.change(
      document.getElementById("event-editor-start-at") as HTMLInputElement,
      { target: { value: "" } },
    );
    fireEvent.change(
      document.getElementById("event-editor-end-at") as HTMLInputElement,
      { target: { value: "" } },
    );

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Pick valid start and end times.")).toBeTruthy(),
    );
    expect(uiClient.createLifeOpsCalendarEvent).not.toHaveBeenCalled();
  });

  // ----- edit mode ----------------------------------------------------------

  it("seeds the edit form from the event (title/location/attendees/notes)", async () => {
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText("Event title") as HTMLInputElement).value,
    ).toBe("Quarterly review");
    expect(
      (screen.getByLabelText("Event location") as HTMLInputElement).value,
    ).toBe("HQ Boardroom");
    expect(
      (document.getElementById("event-editor-notes") as HTMLTextAreaElement)
        .value,
    ).toBe("Numbers walkthrough");
    expect(screen.getByTestId("attendee-chip").textContent).toBe(
      "cfo@example.com",
    );
  });

  it("PATCHes only the changed title via updateLifeOpsCalendarEvent and fires onSaved", async () => {
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({
      event: { ...editEvent, title: "Quarterly review (final)" },
    });
    const onSaved = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Quarterly review (final)" },
    });
    fireEvent.click(editSaveButton());

    await waitFor(() =>
      expect(uiClient.updateLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    const [externalId, patch] =
      uiClient.updateLifeOpsCalendarEvent.mock.calls[0];
    expect(externalId).toBe("evt_1");
    // Patch only carries the changed title (plus routing fields), not start/end.
    expect(patch.title).toBe("Quarterly review (final)");
    expect(patch.startAt).toBeUndefined();
    expect(patch.endAt).toBeUndefined();
    expect(patch.location).toBeUndefined();
    expect(patch.expectedProviderVersion).toBe('"event-editor-v1"');
    expect(patch.notifyAttendees).toBe(false);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("deletes via the confirm dialog and fires onDeleted", async () => {
    uiClient.deleteLifeOpsCalendarEvent.mockResolvedValue({
      outcome: "deleted",
      cancellationMode: "organizer_cancel",
      event: null,
    });
    const onDeleted = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    // Open the confirm dialog via the Delete action.
    fireEvent.click(
      screen
        .getByText("Delete", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );
    const confirm = await screen.findByTestId("confirm-dialog");
    expect(confirm).toBeTruthy();

    fireEvent.click(screen.getByTestId("confirm-delete"));

    await waitFor(() =>
      expect(uiClient.deleteLifeOpsCalendarEvent).toHaveBeenCalledWith(
        "evt_1",
        {
          side: "owner",
          grantId: "connector-account:acct-1",
          calendarId: "owner@example.com",
          expectedProviderVersion: '"event-editor-v1"',
          idempotencyKey: expect.stringMatching(/^event-editor:/),
          notifyAttendees: false,
          cancellationMode: "organizer_cancel",
        },
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(editEvent.id));
  });

  it("declines an invited event instead of organizer-deleting it", async () => {
    const invitedEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      organizer: { self: false, email: "host@example.com" },
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          self: true,
          organizer: false,
          optional: false,
        },
      ],
    };
    const declinedEvent: LifeOpsCalendarEvent = {
      ...invitedEvent,
      attendees: invitedEvent.attendees.map((attendee) => ({
        ...attendee,
        responseStatus: attendee.self ? "declined" : attendee.responseStatus,
      })),
    };
    uiClient.deleteLifeOpsCalendarEvent.mockResolvedValue({
      outcome: "invitation_declined",
      cancellationMode: "decline_invitation",
      event: declinedEvent,
    });
    const onSaved = vi.fn();
    const onDeleted = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={invitedEvent}
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(
      screen
        .getByText("Decline invitation", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );
    await screen.findByTestId("confirm-dialog");
    expect(
      screen.getByText(
        "Your response will change to declined. This does not delete the organizer's event.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    fireEvent.click(screen.getByTestId("confirm-delete"));

    await waitFor(() =>
      expect(uiClient.deleteLifeOpsCalendarEvent).toHaveBeenCalledWith(
        "evt_1",
        expect.objectContaining({
          cancellationMode: "decline_invitation",
          expectedProviderVersion: '"event-editor-v1"',
          notifyAttendees: false,
        }),
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(declinedEvent));
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("invokes onChat with the event from the Chat action (edit mode only)", async () => {
    const onChat = vi.fn();
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onChat={onChat}
      />,
    );

    fireEvent.click(
      screen
        .getByText("Chat", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );
    expect(onChat).toHaveBeenCalledWith(editEvent);
  });

  // ----- provider capability ------------------------------------------------

  function deleteButton(): HTMLButtonElement {
    return screen
      .getByText("Delete", { selector: "span.sr-only" })
      .closest("button") as HTMLButtonElement;
  }

  function expectNoSaveAffordances(): void {
    expect(screen.queryByText("Save", { selector: "span.sr-only" })).toBeNull();
    expect(
      screen.queryByText("Save and continue", { selector: "span.sr-only" }),
    ).toBeNull();
  }

  it("keeps built-in calendar events editable with their local version token", () => {
    const builtInEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      provider: "eliza",
      grantId: "eliza-calendar",
      calendarId: "primary",
      metadata: { etag: '"eliza-1"', version: 1 },
    };

    expect(eventEditorMutability(builtInEvent)).toEqual({
      kind: "editable",
      providerVersion: '"eliza-1"',
    });

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={builtInEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Save", { selector: "span.sr-only" })).toBeTruthy();
    expect(deleteButton().disabled).toBe(false);
    expect(screen.queryByTestId("event-editor-read-only-reason")).toBeNull();
  });

  it("renders Apple events read-only instead of offering saves that dead-end", async () => {
    const appleEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      provider: "apple_calendar",
      organizer: null,
      attendees: [],
      metadata: { appleCalendar: true },
      grantId: "apple-calendar",
    };

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={appleEvent}
        onClose={vi.fn()}
      />,
    );

    expectNoSaveAffordances();
    expect(
      screen.getByTestId("event-editor-read-only-reason").textContent,
    ).toContain("Apple Calendar");
    expect(
      (screen.getByLabelText("Event title") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(deleteButton().disabled).toBe(true);
    expect(screen.getByTestId("event-editor-attendees-read-only")).toBeTruthy();
  });

  it("renders ICS subscription events read-only with delete disabled and a reason", async () => {
    const icsEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      provider: "ics",
      organizer: null,
      attendees: [],
      metadata: {},
      grantId: "ics-source-1",
    };

    render(
      <EventEditorDrawer open mode="edit" event={icsEvent} onClose={vi.fn()} />,
    );

    expectNoSaveAffordances();
    expect(
      screen.getByTestId("event-editor-read-only-reason").textContent,
    ).toContain("subscription");
    expect(deleteButton().disabled).toBe(true);
  });

  it("renders Microsoft events read-only with an Outlook reason", async () => {
    const microsoftEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      provider: "microsoft",
      metadata: {},
    };

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={microsoftEvent}
        onClose={vi.fn()}
      />,
    );

    expectNoSaveAffordances();
    expect(
      screen.getByTestId("event-editor-read-only-reason").textContent,
    ).toContain("Outlook");
    expect(deleteButton().disabled).toBe(true);
  });

  it("renders a Google event without a provider version read-only with a refresh reason", async () => {
    const staleEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      metadata: {},
    };

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={staleEvent}
        onClose={vi.fn()}
      />,
    );

    expectNoSaveAffordances();
    expect(
      screen.getByTestId("event-editor-read-only-reason").textContent,
    ).toContain("Refresh the calendar");
    expect(deleteButton().disabled).toBe(true);
    expect(uiClient.updateLifeOpsCalendarEvent).not.toHaveBeenCalled();
  });

  it("enables organizer delete when organizer identity is only a matching account email", async () => {
    const emailOrganizerEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      organizer: { email: "Owner@Example.com" },
      attendees: [],
      accountEmail: "owner@example.com",
    };
    uiClient.deleteLifeOpsCalendarEvent.mockResolvedValue({
      outcome: "deleted",
      cancellationMode: "organizer_cancel",
      event: null,
    });

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={emailOrganizerEvent}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(deleteButton().disabled).toBe(false);
    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByTestId("confirm-delete"));

    await waitFor(() =>
      expect(uiClient.deleteLifeOpsCalendarEvent).toHaveBeenCalledWith(
        "evt_1",
        expect.objectContaining({ cancellationMode: "organizer_cancel" }),
      ),
    );
  });

  it("disables delete with a visible reason when the owner's role is unknown", async () => {
    const roleUnknownEvent: LifeOpsCalendarEvent = {
      ...editEvent,
      organizer: null,
      attendees: [],
      accountEmail: undefined,
    };

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={roleUnknownEvent}
        onClose={vi.fn()}
      />,
    );

    // The event itself is still saveable (Google + etag) — only delete lacks
    // an executor-honorable cancellation mode.
    expect(screen.getByText("Save", { selector: "span.sr-only" })).toBeTruthy();
    expect(deleteButton().disabled).toBe(true);
    expect(
      screen.getByTestId("event-editor-delete-unavailable").textContent,
    ).toContain("role");
  });

  it("keeps the drawer open on save-and-continue", async () => {
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({
      event: { ...editEvent, title: "Renamed" },
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(
      screen
        .getByText("Save and continue", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(uiClient.updateLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Save-and-continue does NOT close the drawer.
    expect(onClose).not.toHaveBeenCalled();
  });
});
