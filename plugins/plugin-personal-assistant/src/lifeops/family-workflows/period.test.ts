/** Exercises monthly packet selection and real timezone conversion at DST and year boundaries. */
import { describe, expect, it } from "vitest";
import {
  familyPacketCalendarWindow,
  nextFamilyPacketPeriod,
  selectedFamilyPacketPeriod,
} from "./period.js";

describe("family packet calendar period", () => {
  it("queries the selected leap-year month and December rollover", () => {
    expect(
      familyPacketCalendarWindow(selectedFamilyPacketPeriod("2028-02")),
    ).toEqual({
      timeMin: "2028-02-01T05:00:00.000Z",
      timeMax: "2028-03-01T05:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(
      familyPacketCalendarWindow(selectedFamilyPacketPeriod("2026-12")),
    ).toEqual({
      timeMin: "2026-12-01T05:00:00.000Z",
      timeMax: "2027-01-01T05:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it.each([
    "2026-00",
    "2026-13",
    "0000-01",
    "2026-1",
    "9999-12",
    "not-a-month",
  ])(
    "rejects an invalid selected month %s before querying calendars",
    (key) => {
      expect(() => selectedFamilyPacketPeriod(key)).toThrow(
        "Select a valid month",
      );
    },
  );
  it.each([
    [
      "2026-10-15T12:00:00Z",
      "2026-11",
      "2026-11-01T04:00:00.000Z",
      "2026-12-01T05:00:00.000Z",
    ],
    [
      "2026-02-15T12:00:00Z",
      "2026-03",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
    ],
    [
      "2026-12-15T12:00:00Z",
      "2027-01",
      "2027-01-01T05:00:00.000Z",
      "2027-02-01T05:00:00.000Z",
    ],
    [
      "2026-10-01T02:00:00Z",
      "2026-10",
      "2026-10-01T04:00:00.000Z",
      "2026-11-01T04:00:00.000Z",
    ],
  ])(
    "queries the complete next local month from %s",
    (now, key, timeMin, timeMax) => {
      const period = nextFamilyPacketPeriod(new Date(now));
      expect(period.key).toBe(key);
      expect(familyPacketCalendarWindow(period)).toEqual({
        timeMin,
        timeMax,
        timeZone: "America/New_York",
      });
    },
  );
});
