/** Verifies account-switch date presentation across civil-day, exclusive-end and DST boundaries. */
import { describe, expect, it } from "vitest";
import { formatHandoffEventDate } from "./handoff-event-date.js";

const school = {
  startAt: "2026-09-07T00:00:00.000Z",
  endAt: "2026-09-08T00:00:00.000Z",
  isAllDay: true,
  timezone: "America/Los_Angeles",
};

describe("account-switch event dates", () => {
  it("keeps the school civil date in western and eastern zones", () => {
    for (const timezone of [
      "America/Los_Angeles",
      "America/New_York",
      "Asia/Tokyo",
    ]) {
      expect(formatHandoffEventDate({ ...school, timezone })).toBe(
        "Sep 7, 2026 · All day",
      );
    }
  });
  it("shows the final included day of a multi-day school break", () => {
    expect(
      formatHandoffEventDate({ ...school, endAt: "2026-09-10T00:00:00.000Z" }),
    ).toBe("Sep 7, 2026 – Sep 9, 2026 · All day");
  });
  it("distinguishes repeated fall-back hours by their actual offset", () => {
    const result = formatHandoffEventDate({
      startAt: "2026-11-01T05:30:00Z",
      endAt: "2026-11-01T06:30:00Z",
      isAllDay: false,
      timezone: "America/New_York",
    });
    expect(result).toContain("1:30 AM EDT");
    expect(result).toContain("1:30 AM EST");
  });
  it("marks invalid dates and zones unavailable", () => {
    expect(formatHandoffEventDate({ ...school, startAt: "invalid" })).toBe(
      "Date unavailable",
    );
    expect(
      formatHandoffEventDate({
        ...school,
        isAllDay: false,
        timezone: "Invalid/Zone",
      }),
    ).toBe("Date unavailable");
    expect(formatHandoffEventDate({ ...school, endAt: school.startAt })).toBe(
      "Date unavailable",
    );
  });
});
