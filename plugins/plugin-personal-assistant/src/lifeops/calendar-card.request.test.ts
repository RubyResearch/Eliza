/**
 * Pins the calendar-card request parser: every field of the untrusted owner
 * body is validated once, so a malformed date, time zone, event, lifetime, or
 * privacy mode is an explicit 400-shaped result instead of a throw from the
 * composer, Intl, or the approval queue. Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { parseCalendarCardRequest } from "./calendar-card.js";

const event = {
  id: "evt-1",
  title: "Standup",
  startAt: "2026-03-02T09:00:00.000Z",
  endAt: "2026-03-02T09:30:00.000Z",
  location: "Room 4",
};

const valid = {
  date: "2026-03-02",
  timeZone: "America/New_York",
  privacyMode: "full",
  recipient: "Sam",
  events: [event],
};

describe("parseCalendarCardRequest", () => {
  it("accepts a complete request and normalizes optional fields", () => {
    const parsed = parseCalendarCardRequest({
      ...valid,
      recipient: "  Sam  ",
      recipientEntityId: "entity-9",
      ttlMs: 60_000,
      events: [{ ...event, location: undefined }],
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        channel: "imessage",
        date: "2026-03-02",
        timeZone: "America/New_York",
        privacyMode: "full",
        recipient: "Sam",
        recipientEntityId: "entity-9",
        events: [{ ...event, location: null }],
        ttlMs: 60_000,
      },
    });
  });

  it("defaults the recipient entity and lifetime to null when omitted", () => {
    const parsed = parseCalendarCardRequest(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.recipientEntityId).toBeNull();
    expect(parsed.request.ttlMs).toBeNull();
    expect(parsed.request.events).toEqual([event]);
  });

  it.each([
    [
      { ...valid, channel: "email" },
      "channel must be imessage, telegram, or discord",
    ],
    [null, "Calendar card request must be an object"],
    [[], "Calendar card request must be an object"],
    [
      { ...valid, date: "tomorrow" },
      "date must be a valid YYYY-MM-DD calendar date",
    ],
    [
      { ...valid, date: "2026-02-30" },
      "date must be a valid YYYY-MM-DD calendar date",
    ],
    [
      { ...valid, date: 20260302 },
      "date must be a valid YYYY-MM-DD calendar date",
    ],
    [
      { ...valid, timeZone: "Mars/Olympus" },
      "timeZone must be a valid IANA time zone",
    ],
    [{ ...valid, timeZone: "" }, "timeZone must be a valid IANA time zone"],
    [
      { ...valid, privacyMode: "everything" },
      "privacyMode must be one of full, times_only, busy_only",
    ],
    [{ ...valid, recipient: "   " }, "recipient must be a non-empty string"],
    [
      { ...valid, recipientEntityId: "" },
      "recipientEntityId must be a non-empty string when present",
    ],
    [{ ...valid, events: "none" }, "events must be an array"],
    [{ ...valid, events: [null] }, "events[0] must be an object"],
    [
      { ...valid, events: [{ ...event, id: "" }] },
      "events[0].id must be a non-empty string",
    ],
    [
      { ...valid, events: [event, { ...event, title: 3 }] },
      "events[1].title must be a string",
    ],
    [
      { ...valid, events: [{ ...event, startAt: "soon" }] },
      "events[0].startAt must be a parseable timestamp",
    ],
    [
      { ...valid, events: [{ ...event, endAt: undefined }] },
      "events[0].endAt must be a parseable timestamp",
    ],
    [
      { ...valid, events: [{ ...event, endAt: "2026-03-02T08:00:00.000Z" }] },
      "events[0].endAt must not be before startAt",
    ],
    [
      { ...valid, events: [{ ...event, location: 7 }] },
      "events[0].location must be a string when present",
    ],
    [
      { ...valid, ttlMs: 0 },
      "ttlMs must be a positive integer number of milliseconds",
    ],
    [
      { ...valid, ttlMs: 1.5 },
      "ttlMs must be a positive integer number of milliseconds",
    ],
    [
      { ...valid, ttlMs: "1h" },
      "ttlMs must be a positive integer number of milliseconds",
    ],
  ])("rejects %j", (body, error) => {
    expect(parseCalendarCardRequest(body)).toEqual({ ok: false, error });
  });
});
