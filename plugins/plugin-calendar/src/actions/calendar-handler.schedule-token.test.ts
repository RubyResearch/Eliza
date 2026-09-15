import { describe, expect, it } from "vitest";
import { looksLikeScheduleToken } from "./calendar-handler";

describe("looksLikeScheduleToken", () => {
  it("recognises misfiled clock times, weekdays and dates (live regression)", () => {
    for (const value of [
      "4pm",
      " 4:30 PM ",
      "at 9am",
      "friday",
      "next tuesday",
      "tomorrow",
      "2026-09-18",
      "2026-09-18T16:00",
    ]) {
      expect(looksLikeScheduleToken(value)).toBe(true);
    }
  });

  it("keeps real places and notes", () => {
    for (const value of [
      "Dr. Chen's office",
      "4 Pine St",
      "Friday Harbor Marina",
      "bring the insurance card",
      "Zoom",
    ]) {
      expect(looksLikeScheduleToken(value)).toBe(false);
    }
  });
});
