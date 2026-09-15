import { describe, expect, it } from "vitest";
import { rejectedArgumentForCalendarServiceError } from "./calendar-handler";

describe("rejectedArgumentForCalendarServiceError", () => {
  it("names the planner argument the built-in calendar rejected", () => {
    expect(
      rejectedArgumentForCalendarServiceError(
        "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
      ),
    ).toBe("details.recurrence");
    expect(
      rejectedArgumentForCalendarServiceError(
        "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
      ),
    ).toBe("details.notifyAttendees");
  });

  it("leaves other service errors as ordinary failures", () => {
    expect(
      rejectedArgumentForCalendarServiceError("ELIZA_CALENDAR_NOT_FOUND"),
    ).toBeUndefined();
    expect(rejectedArgumentForCalendarServiceError(undefined)).toBeUndefined();
  });
});
