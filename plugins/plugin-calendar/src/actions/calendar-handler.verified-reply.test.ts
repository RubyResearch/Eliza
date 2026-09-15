/**
 * Deterministic coverage for the settled-receipt self-verification: a built-in
 * create/update/delete whose applied event provably matches the user's own
 * words yields the verified reply the runtime delivers without the evaluator
 * model call; every other shape yields null and keeps the evaluator.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseStatedClockTimes,
  verifyAppliedCalendarMutation,
} from "./calendar-handler";

/** Wednesday 2026-09-16, 09:00 America/New_York. */
const NOW = new Date("2026-09-16T13:00:00.000Z");
const ZONE = "America/New_York";

function event(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:evt-1",
    externalId: "evt-1",
    agentId: "agent-1",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title: "Tailor Appointment",
    description: "",
    location: "",
    status: "confirmed",
    // Friday 18 Sep 2026, 4:00–5:00 PM EDT.
    startAt: "2026-09-18T20:00:00.000Z",
    endAt: "2026-09-18T21:00:00.000Z",
    isAllDay: false,
    timezone: ZONE,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: '"eliza-1"', version: 1 },
    syncedAt: "2026-09-16T13:00:00.000Z",
    updatedAt: "2026-09-16T13:00:00.000Z",
    grantId: "eliza-calendar",
    ...overrides,
  };
}

/** The target before a move: Friday 18 Sep 2026, 3:00–4:00 PM EDT. */
const PREVIOUS = {
  startAt: "2026-09-18T19:00:00.000Z",
  endAt: "2026-09-18T20:00:00.000Z",
};

describe("parseStatedClockTimes", () => {
  it("reads one stated time in its common spellings", () => {
    for (const [text, hour, minute] of [
      ["friday at 3pm", 15, 0],
      ["at 4:30 PM", 16, 30],
      ["4 p.m. tomorrow", 16, 0],
      ["12am tonight", 0, 0],
      ["12pm", 12, 0],
      ["noon", 12, 0],
      ["around midnight", 0, 0],
      ["at 16:00", 16, 0],
      ["09:30 on friday", 9, 30],
    ] as const) {
      expect(parseStatedClockTimes(text), text).toEqual({
        kind: "one",
        start: { hour, minute },
      });
    }
  });

  it("reads a range, the first time inheriting the second's meridiem", () => {
    expect(parseStatedClockTimes("friday 3-5pm")).toEqual({
      kind: "one",
      start: { hour: 15, minute: 0 },
      end: { hour: 17, minute: 0 },
    });
    expect(parseStatedClockTimes("from 11am to 1:30pm")).toEqual({
      kind: "one",
      start: { hour: 11, minute: 0 },
      end: { hour: 13, minute: 30 },
    });
  });

  it("treats a bare number, an ambiguous clock, or no time as none", () => {
    for (const text of ["move it to 4", "at 3:30", "friday", ""]) {
      expect(parseStatedClockTimes(text), text).toEqual({ kind: "none" });
    }
  });

  it("treats several distinct times or an impossible one as unverifiable", () => {
    for (const text of [
      "the 3pm dentist and the 5pm call",
      "3pm, then 4pm",
      "at 13pm",
      "3-5pm and 7pm",
    ]) {
      expect(parseStatedClockTimes(text), text).toEqual({ kind: "several" });
    }
  });
});

describe("verifyAppliedCalendarMutation", () => {
  beforeEach(() => {
    // Only Date is faked: the stated-day helpers read the wall clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies a create whose applied start is the stated weekday and time", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment friday at 3pm",
        event: event({
          title: "Dentist appointment",
          startAt: "2026-09-18T19:00:00.000Z",
          endAt: "2026-09-18T20:00:00.000Z",
        }),
        now: NOW,
      }),
    ).toBe("Created “Dentist appointment” for Friday, Sep 18 at 3pm EDT.");
  });

  it("verifies a move whose applied start is the stated destination (live shape)", () => {
    // Live 2026-09-14: "move notary appointment to friday 4pm" paid an
    // 11.2K-token evaluator call to confirm a start the handler can check.
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my tailor appointment to friday at 4pm",
        event: event(),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBe("Moved “Tailor Appointment” to Friday, Sep 18 at 4pm EDT.");
  });

  it("reads an update's destination clause, not the source time", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my 3pm tailor appointment to 4pm",
        event: event(),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBe("Moved “Tailor Appointment” to Friday, Sep 18 at 4pm EDT.");
  });

  it("does not verify when the applied time differs from the stated one", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my tailor appointment to friday at 4pm",
        event: event({
          startAt: "2026-09-18T21:00:00.000Z",
          endAt: "2026-09-18T22:00:00.000Z",
        }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment friday at 3pm",
        event: event({ title: "Dentist appointment" }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does not verify when the applied day differs from the stated one", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment saturday at 4pm",
        event: event({ title: "Dentist appointment" }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does not verify a message without a stated time", () => {
    for (const requestText of [
      "move my tailor appointment to friday",
      "move my tailor appointment to 4",
      "reschedule the tailor",
    ]) {
      expect(
        verifyAppliedCalendarMutation({
          operation: "update",
          requestText,
          event: event(),
          previous: PREVIOUS,
          now: NOW,
        }),
        requestText,
      ).toBeNull();
    }
  });

  it("does not verify a message naming several events, times or days", () => {
    for (const requestText of [
      "add a dentist friday at 3pm and a haircut saturday at 5pm",
      "move the tailor to friday 4pm and the dentist to 5pm",
    ]) {
      expect(
        verifyAppliedCalendarMutation({
          operation: "create",
          requestText,
          event: event(),
          now: NOW,
        }),
        requestText,
      ).toBeNull();
    }
  });

  it("does not verify when a recurrence, guests, or other unshown details are involved", () => {
    const requestText = "move my tailor appointment to friday at 4pm";
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({ recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"] }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({ recurringEventId: "series-1" }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({
          attendees: [
            {
              email: "sam@acme.co",
              displayName: "Sam",
              responseStatus: "needsAction",
              self: false,
              organizer: false,
              optional: false,
            },
          ],
        }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event(),
        previous: PREVIOUS,
        now: NOW,
        carriesUnshownDetails: true,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment friday at 4pm",
        event: event({ title: "Dentist appointment", isAllDay: true }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does not verify a connected-provider event or one without a usable zone", () => {
    const requestText = "move my tailor appointment to friday at 4pm";
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({ provider: "google", grantId: "connector-account:a" }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({ timezone: null }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText,
        event: event({ timezone: null }),
        previous: PREVIOUS,
        fallbackTimeZone: ZONE,
        now: NOW,
      }),
    ).toBe("Moved “Tailor Appointment” to Friday, Sep 18 at 4pm EDT.");
  });

  it("keeps the duration check on a move and honors a stated range", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my tailor appointment to friday at 4pm",
        event: event({ endAt: "2026-09-18T22:00:00.000Z" }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my tailor appointment to friday 4-6pm",
        event: event({ endAt: "2026-09-18T22:00:00.000Z" }),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBe("Moved “Tailor Appointment” to Friday, Sep 18 at 4pm EDT.");
    expect(
      verifyAppliedCalendarMutation({
        operation: "update",
        requestText: "move my tailor appointment to friday 4-6pm",
        event: event(),
        previous: PREVIOUS,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("requires a create without a stated day to land today or tomorrow", () => {
    const dentist = event({
      title: "Dentist appointment",
      startAt: "2026-09-17T19:00:00.000Z",
      endAt: "2026-09-17T20:00:00.000Z",
    });
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment at 3pm",
        event: dentist,
        now: NOW,
      }),
    ).toBe(
      "Created “Dentist appointment” for tomorrow, Thursday, Sep 17 at 3pm EDT.",
    );
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment at 4pm",
        event: event({ title: "Dentist appointment" }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("names today and tomorrow the way the user does", () => {
    // "schedule a haircut tomorrow at 10am": the Stage-1 intent says
    // "tomorrow", so the verified sentence must too for the runtime's
    // intent-coverage gate to accept it.
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "schedule a haircut tomorrow at 10am",
        event: event({
          title: "Haircut",
          startAt: "2026-09-17T14:00:00.000Z",
          endAt: "2026-09-17T14:30:00.000Z",
        }),
        now: NOW,
      }),
    ).toBe("Created “Haircut” for tomorrow, Thursday, Sep 17 at 10am EDT.");
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel today's haircut",
        event: event({
          title: "Haircut",
          startAt: "2026-09-16T15:00:00.000Z",
          endAt: "2026-09-16T15:30:00.000Z",
        }),
        titleHint: "haircut",
        now: NOW,
      }),
    ).toBe(
      "Deleted “Haircut” (today, Wednesday, Sep 16 at 11am EDT) from your calendar.",
    );
  });

  it("spells minutes and a different year in the reply", () => {
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment friday at 3:30pm",
        event: event({
          title: "Dentist appointment",
          startAt: "2026-09-18T19:30:00.000Z",
          endAt: "2026-09-18T20:00:00.000Z",
        }),
        now: NOW,
      }),
    ).toBe("Created “Dentist appointment” for Friday, Sep 18 at 3:30pm EDT.");
    expect(
      verifyAppliedCalendarMutation({
        operation: "create",
        requestText: "add a dentist appointment on 2027-01-08 at 3pm",
        event: event({
          title: "Dentist appointment",
          startAt: "2027-01-08T20:00:00.000Z",
          endAt: "2027-01-08T21:00:00.000Z",
        }),
        now: NOW,
      }),
    ).toBe("Created “Dentist appointment” for Friday, Jan 8, 2027 at 3pm EST.");
  });

  it("verifies a delete of the one event whose title the user named", () => {
    const haircut = event({
      title: "Haircut with Sam",
      startAt: "2026-09-18T15:00:00.000Z",
      endAt: "2026-09-18T15:30:00.000Z",
    });
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my haircut on friday",
        event: haircut,
        titleHint: "haircut",
        now: NOW,
      }),
    ).toBe(
      "Deleted “Haircut with Sam” (Friday, Sep 18 at 11am EDT) from your calendar.",
    );
    // Two deleted events, a hint the title does not carry, a hint the user
    // never said, a stated day or time that is not the event's, or no hint.
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my haircuts",
        event: haircut,
        titleHint: "haircut",
        appliedCount: 2,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my dentist",
        event: haircut,
        titleHint: "dentist",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel that appointment",
        event: haircut,
        titleHint: "haircut",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my haircut on saturday",
        event: haircut,
        titleHint: "haircut",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my 2pm haircut",
        event: haircut,
        titleHint: "haircut",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifyAppliedCalendarMutation({
        operation: "delete",
        requestText: "cancel my haircut",
        event: haircut,
        now: NOW,
      }),
    ).toBeNull();
  });
});
