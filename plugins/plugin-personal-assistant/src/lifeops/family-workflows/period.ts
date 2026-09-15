/** Resolves next-month family packet periods and calendar query instants using the household timezone. */
import { ElizaError } from "@elizaos/core/errors";
import type { FamilyPacketPeriod } from "../family-coordination/index.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "../time.js";

/** Resolves an explicitly selected civil month without consulting the current date. */
export function selectedFamilyPacketPeriod(
  key: string,
  timeZone = "America/New_York",
): FamilyPacketPeriod {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(key) || key === "9999-12") {
    throw new ElizaError("Select a valid month in YYYY-MM format", {
      code: "FAMILY_PACKET_PERIOD_INVALID",
    });
  }
  const [year, month] = key.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    key,
    startsOn: `${key}-01`,
    endsOnExclusive: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
    timeZone,
  };
}

export function nextFamilyPacketPeriod(
  now: Date,
  timeZone = "America/New_York",
): FamilyPacketPeriod {
  const local = getZonedDateParts(now, timeZone);
  const start = new Date(Date.UTC(local.year, local.month, 1));
  const end = new Date(Date.UTC(local.year, local.month + 1, 1));
  const startsOn = start.toISOString().split("T")[0];
  return {
    key: startsOn.substring(0, 7),
    startsOn,
    endsOnExclusive: end.toISOString().split("T")[0],
    timeZone,
  };
}

export function familyPacketCalendarWindow(period: FamilyPacketPeriod): {
  timeMin: string;
  timeMax: string;
  timeZone: string;
} {
  const midnight = (date: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    return buildUtcDateFromLocalParts(period.timeZone, {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
    }).toISOString();
  };
  return {
    timeMin: midnight(period.startsOn),
    timeMax: midnight(period.endsOnExclusive),
    timeZone: period.timeZone,
  };
}
