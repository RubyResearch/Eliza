import { describe, expect, it } from "vitest";
import { resolveUpdateTimeRange } from "./calendar-handler";

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
