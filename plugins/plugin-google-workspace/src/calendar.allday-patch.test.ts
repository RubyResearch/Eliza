/**
 * Exercises real Google calendar update serialization against a deterministic
 * provider boundary that merges nested patch fields. Covers one-bound
 * rescheduling and conversions between timed and all-day events; incompatible
 * retained date/dateTime fields are rejected as they are by Google.
 */
import type { calendar_v3 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "./calendar";
import type { GoogleApiClientFactory } from "./client-factory";

type PatchMock = ReturnType<typeof vi.fn>;

function updateEventCapture(existing: calendar_v3.Schema$Event): {
  client: GoogleCalendarClient;
  patch: PatchMock;
} {
  const patch = vi.fn(async (params: calendar_v3.Params$Resource$Events$Patch) => {
    const start = { ...existing.start, ...params.requestBody?.start };
    const end = { ...existing.end, ...params.requestBody?.end };
    if ((start.date && start.dateTime) || (end.date && end.dateTime)) {
      throw Object.assign(new Error("Cannot combine date and dateTime"), { status: 400 });
    }
    return { data: { ...existing, id: params.eventId, ...params.requestBody, start, end } };
  });
  const events = {
    get: vi.fn(async () => ({ data: existing })),
    patch,
  };
  const factory = {
    calendar: vi.fn(async () => ({ events })),
  } as unknown as GoogleApiClientFactory;
  return { client: new GoogleCalendarClient(factory), patch };
}

function patchedBody(patch: PatchMock): calendar_v3.Schema$Event {
  const call = patch.mock.calls[0]?.[0] as calendar_v3.Params$Resource$Events$Patch;
  return call.requestBody as calendar_v3.Schema$Event;
}

describe("GoogleCalendarClient all-day reschedule patch", () => {
  it.each([true, false])(
    "converts existing date representation with patch semantics (all-day=%s)",
    async (allDay) => {
      const { client } = updateEventCapture({
        id: "convert-1",
        start: allDay ? { dateTime: "2026-11-01T00:00:00.000Z" } : { date: "2026-11-01" },
        end: allDay ? { dateTime: "2026-11-03T00:00:00.000Z" } : { date: "2026-11-03" },
      });
      const result = await client.updateEvent({
        accountId: "acct-1",
        eventId: "convert-1",
        timeZone: "America/New_York",
        start: allDay ? "2026-11-01" : "2026-11-01T14:00:00.000Z",
        end: allDay ? "2026-11-03" : "2026-11-01T15:00:00.000Z",
        expectedEtag: '"v1"',
      });
      expect(result.isAllDay).toBe(allDay);
      expect(result.start).toBe(allDay ? "2026-11-01T00:00:00.000Z" : "2026-11-01T14:00:00.000Z");
      expect(result.end).toBe(allDay ? "2026-11-03T00:00:00.000Z" : "2026-11-01T15:00:00.000Z");
    }
  );

  it("keeps the derived end date-only when only the start of an all-day event is patched", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-1",
      start: { date: "2026-06-01" },
      end: { date: "2026-06-03" },
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-1", start: "2026-06-05" });

    const body = patchedBody(patch);
    // Existing span is 2 whole days (Jun 1 -> Jun 3), preserved from the new start.
    expect(body.start?.date).toBe("2026-06-05");
    expect(body.end?.date).toBe("2026-06-07");
    expect(body.start?.dateTime).toBeNull();
    expect(body.end?.dateTime).toBeNull();
  });

  it("keeps the derived start date-only when only the end of an all-day event is patched", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-2",
      start: { date: "2026-06-01" },
      end: { date: "2026-06-03" },
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-2", end: "2026-06-10" });

    const body = patchedBody(patch);
    expect(body.end?.date).toBe("2026-06-10");
    expect(body.start?.date).toBe("2026-06-08");
    expect(body.start?.dateTime).toBeNull();
    expect(body.end?.dateTime).toBeNull();
  });

  it("defaults to a one-day span when the existing all-day duration is unknown", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-3",
      start: { date: "2026-06-01" },
      // No end bound -> span cannot be inferred and must default to one day.
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-3", start: "2026-06-05" });

    const body = patchedBody(patch);
    expect(body.start?.date).toBe("2026-06-05");
    expect(body.end?.date).toBe("2026-06-06");
    expect(body.end?.dateTime).toBeNull();
  });

  it("still derives a timed dateTime end for timed events (unchanged behavior)", async () => {
    const { client, patch } = updateEventCapture({
      id: "timed-1",
      start: { dateTime: "2026-06-01T09:00:00.000Z" },
      end: { dateTime: "2026-06-01T10:00:00.000Z" },
    });

    await client.updateEvent({
      accountId: "acct-1",
      eventId: "timed-1",
      start: "2026-06-05T09:00:00.000Z",
    });

    const body = patchedBody(patch);
    expect(body.start?.dateTime).toBe("2026-06-05T09:00:00.000Z");
    expect(body.end?.dateTime).toBe("2026-06-05T10:00:00.000Z");
    expect(body.start?.date).toBeNull();
    expect(body.end?.date).toBeNull();
  });
});
