/**
 * Deterministic coverage for the attendee-notification guard: the planner
 * stamps `notifyAttendees: true` onto ordinary mutations, and the built-in
 * calendar has no mail path, so the flag only reaches a provider that can act
 * on it and built-in replies state that nobody was emailed.
 */
import { describe, expect, it } from "vitest";
import {
  builtInNotifyNote,
  shouldNotifyAttendees,
} from "./calendar-handler.ts";

const guest = { email: "sam@acme.co", displayName: "Sam" };

describe("shouldNotifyAttendees", () => {
  it("never forwards the flag to the built-in calendar, even with guests (live regression)", () => {
    // "move my vet appointment to friday at 4pm" arrived with notifyAttendees
    // on a built-in event carrying a planner-fabricated guest and 400'd.
    expect(
      shouldNotifyAttendees(
        { notifyAttendees: true },
        { provider: "eliza", attendees: [guest] },
      ),
    ).toBe(false);
  });

  it("forwards the flag only when a connected provider has someone to notify", () => {
    expect(
      shouldNotifyAttendees(
        { notifyAttendees: true },
        { provider: "google", attendees: [guest] },
      ),
    ).toBe(true);
    expect(
      shouldNotifyAttendees(
        { notifyAttendees: true },
        { provider: "google", attendees: [] },
      ),
    ).toBe(false);
    expect(
      shouldNotifyAttendees({}, { provider: "google", attendees: [guest] }),
    ).toBe(false);
  });
});

describe("builtInNotifyNote", () => {
  it("states that nobody was emailed only when notifications were asked for on an event with guests", () => {
    expect(
      builtInNotifyNote({ notifyAttendees: true }, { attendees: [guest] }),
    ).toBe(
      " The built-in calendar can't email attendees, so nobody was notified.",
    );
    expect(
      builtInNotifyNote({ notifyAttendees: true }, { attendees: [] }),
    ).toBe("");
    expect(builtInNotifyNote({}, { attendees: [guest] })).toBe("");
  });
});
