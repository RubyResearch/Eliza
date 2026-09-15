import { describe, expect, it } from "vitest";
import {
  resolveUpdateTimeRange,
  snapWeekdayMoveToTargetDay,
} from "./calendar-handler";

const target = {
  startAt: "2026-09-11T19:00:00.000Z", // 3:00 PM America/New_York (EDT)
  endAt: "2026-09-11T20:00:00.000Z", // 4:00 PM
};

describe("resolveUpdateTimeRange", () => {
  it("keeps the event duration when only a new local start arrives", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-11T16:00:00",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T17:00:00" });
  });

  it("ignores the extractor's end beside the planner's start and keeps the duration (live regression)", () => {
    // 2026-09-14: "move my chiropractor appointment to friday at 4pm" arrived
    // with the planner's start 16:00 and no end; the re-extraction supplied
    // the event's old 16:00 end and the service rejected end <= start.
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-11T16:00:00",
        extractedStart: "2026-09-11T16:00:00",
        extractedEnd: "2026-09-11T16:00:00",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T17:00:00" });
  });

  it("derives the end from the stored duration when an explicit end does not follow the start", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-11T16:00:00",
        explicitEnd: "2026-09-11T15:30:00",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T17:00:00" });
  });

  it("still pairs an extracted end with an extracted start", () => {
    expect(
      resolveUpdateTimeRange({
        extractedStart: "2026-09-11T16:00:00",
        extractedEnd: "2026-09-11T16:45:00",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T16:45:00" });
  });

  it("spells the derived end absolutely for an absolute start", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-11T20:00:00.000Z",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({
      startAt: "2026-09-11T20:00:00.000Z",
      endAt: "2026-09-11T21:00:00.000Z",
    });
  });

  it("carries the duration across a DST boundary on the wall clock", () => {
    // 1 Nov 2026 is the fall-back day in America/New_York; wall-clock math
    // must land the end one hour of local time after the start.
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-11-01T01:30:00",
        target: {
          startAt: "2026-10-31T13:00:00.000Z",
          endAt: "2026-10-31T14:00:00.000Z",
        },
        timeZone: "America/New_York",
      }).endAt,
    ).toMatch(/^2026-11-01T0[12]:30:00$/);
  });

  it("prefers the planner's explicit end and the extracted start as fallbacks", () => {
    expect(
      resolveUpdateTimeRange({
        extractedStart: "2026-09-11T16:00:00",
        explicitEnd: "2026-09-11T16:30:00",
        target,
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T16:30:00" });
  });

  it("passes an end-only or empty update through unchanged", () => {
    expect(
      resolveUpdateTimeRange({ explicitEnd: "2026-09-11T17:00:00", target }),
    ).toEqual({ startAt: undefined, endAt: "2026-09-11T17:00:00" });
    expect(resolveUpdateTimeRange({ target })).toEqual({
      startAt: undefined,
      endAt: undefined,
    });
  });

  it("leaves a start alone when the stored event has no usable duration", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-11T16:00:00",
        target: {
          startAt: "2026-09-11T19:00:00.000Z",
          endAt: "2026-09-11T19:00:00.000Z",
        },
        timeZone: "America/New_York",
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: undefined });
  });
});

describe("snapWeekdayMoveToTargetDay", () => {
  // Fri 11 Sep 2026, 3:00 PM America/New_York; asked at 10:15 PM that night.
  const lateFriday = new Date("2026-09-12T02:15:00.000Z");
  const saturdayMorning = new Date("2026-09-12T14:00:00.000Z");

  it("keeps a same-weekday move on the event's own day while that day lasts (live regression)", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-18T16:00:00",
        target,
        timeZone: "America/New_York",
        requestText: "move my vet appointment to friday at 4pm",
        now: lateFriday,
      }),
    ).toEqual({ startAt: "2026-09-11T16:00:00", endAt: "2026-09-11T17:00:00" });
    expect(
      snapWeekdayMoveToTargetDay({
        requestText: "move it to fri 4pm",
        startAt: "2026-09-18T20:00:00.000Z",
        endAt: "2026-09-18T21:00:00.000Z",
        target,
        timeZone: "America/New_York",
        now: lateFriday,
      }),
    ).toEqual({
      startAt: "2026-09-11T20:00:00.000Z",
      endAt: "2026-09-11T21:00:00.000Z",
    });
  });

  it("leaves an explicit next week, a month, a numeric date, or another weekday as sent", () => {
    const base = {
      startAt: "2026-09-18T16:00:00",
      target,
      timeZone: "America/New_York",
      now: lateFriday,
    };
    for (const requestText of [
      "move it to next friday at 4pm",
      "move it to friday september 18 at 4pm",
      "move it to 9/18 at 4pm",
      "move it to a week from friday at 4pm",
    ]) {
      expect(snapWeekdayMoveToTargetDay({ ...base, requestText }).startAt).toBe(
        "2026-09-18T16:00:00",
      );
    }
    expect(
      snapWeekdayMoveToTargetDay({
        ...base,
        startAt: "2026-09-14T16:00:00",
        requestText: "move it to monday at 4pm",
      }).startAt,
    ).toBe("2026-09-14T16:00:00");
  });

  it("stops snapping once the event's day is over", () => {
    expect(
      snapWeekdayMoveToTargetDay({
        requestText: "move my vet appointment to friday at 4pm",
        startAt: "2026-09-18T16:00:00",
        target,
        timeZone: "America/New_York",
        now: saturdayMorning,
      }).startAt,
    ).toBe("2026-09-18T16:00:00");
  });
});
