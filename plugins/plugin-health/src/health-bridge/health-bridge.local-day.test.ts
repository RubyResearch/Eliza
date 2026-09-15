/**
 * Pins the health bridge's trend window and fixture "today" to the local
 * calendar day of the configured zone (process zone by default), never the UTC
 * day. Deterministic: drives the real `getRecentSummaries`/`getDailySummary`
 * paths on the fixture backend with the clock fixed at 22:30Z and the process
 * zone switched per case; no CLI or network.
 */
import { resolveDefaultTimeZone } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDailySummary, getRecentSummaries } from "./health-bridge.js";

const NOW = "2026-09-13T22:30:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

const CASES = [
  {
    zone: "Asia/Tokyo",
    window: ["2026-09-12", "2026-09-13", "2026-09-14"],
  },
  {
    zone: "America/Los_Angeles",
    window: ["2026-09-11", "2026-09-12", "2026-09-13"],
  },
  {
    zone: "Pacific/Kiritimati",
    window: ["2026-09-12", "2026-09-13", "2026-09-14"],
  },
] as const;

describe("health bridge local calendar day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = ORIGINAL_TZ;
  });

  describe.each(CASES)("TZ=$zone at 22:30Z", ({ zone, window }) => {
    beforeEach(() => {
      process.env.TZ = zone;
      expect(resolveDefaultTimeZone()).toBe(zone);
    });

    it("walks the trend window on local days ending today", async () => {
      const summaries = await getRecentSummaries(3, {
        preferredBackend: "fixture",
        timeZone: zone,
      });
      expect(summaries.map((summary) => summary.date)).toEqual([...window]);
    });

    it("defaults the trend window to the process zone", async () => {
      const summaries = await getRecentSummaries(3, {
        preferredBackend: "fixture",
      });
      expect(summaries.map((summary) => summary.date)).toEqual([...window]);
    });

    it("treats the local today as offset zero for fixture values", async () => {
      const localToday = window[2];
      const today = await getDailySummary(localToday, {
        preferredBackend: "fixture",
        timeZone: zone,
      });
      const yesterday = await getDailySummary(window[1], {
        preferredBackend: "fixture",
        timeZone: zone,
      });
      // Offset zero yields the fixture baseline; the day before is offset -1
      // and carries the "past day" adjustment, so the two must differ.
      expect(today).toMatchObject({ date: localToday, steps: 8420 });
      expect(yesterday.steps).not.toBe(8420);
    });
  });
});
