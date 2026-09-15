/**
 * Deterministic coverage for attendee sanitization at the planner-output
 * boundary, before strict calendar-service validation.
 */

import { describe, expect, it } from "vitest";
import {
  attendeeEmailAccepted,
  normalizeCalendarAttendees,
} from "./calendar-handler.ts";

describe("normalizeCalendarAttendees (planner-arg sanitization)", () => {
  it("drops a planner-invented bare-name attendee instead of failing the create (live regression)", () => {
    const out = normalizeCalendarAttendees({
      attendees: [{ email: "dana", displayName: "Dana", optional: false }],
    });
    expect(out).toBeUndefined();
  });

  it("keeps valid-email attendees and drops invalid ones from a mixed list", () => {
    const out = normalizeCalendarAttendees({
      attendees: [
        { email: "dana", displayName: "Dana" },
        { email: "sam@acme.co", displayName: "Sam" },
        "marco",
        "polo@acme.co",
      ],
    });
    expect(out).toEqual([
      { email: "sam@acme.co", displayName: "Sam" },
      { email: "polo@acme.co" },
    ]);
  });

  it("drops guests on reserved documentation domains the planner fabricates (live regression)", () => {
    // "add a vet appointment friday at 3pm" named nobody; the planner still
    // emitted sam@example.com, and the follow-up move then 400'd on the
    // built-in calendar's attendee-notification boundary.
    expect(
      normalizeCalendarAttendees({
        attendees: [
          { email: "sam@example.com", displayName: "Sam" },
          "guest@Example.ORG",
          "qa@team.test",
          "dev@localhost",
        ],
      }),
    ).toBeUndefined();
    expect(attendeeEmailAccepted("sam@example.com")).toBe(false);
    expect(attendeeEmailAccepted("sam@examples.com")).toBe(true);
    expect(attendeeEmailAccepted("sam@acme.co")).toBe(true);
  });

  it("returns undefined when the details carry no attendees", () => {
    expect(normalizeCalendarAttendees({})).toBeUndefined();
    expect(normalizeCalendarAttendees(undefined)).toBeUndefined();
  });
});
