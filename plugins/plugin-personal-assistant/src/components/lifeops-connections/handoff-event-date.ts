/** Formats account-switch event dates without shifting all-day civil dates through the viewer's zone. */
import type { LifeOpsCalendarEvent } from "@elizaos/shared";

type EventDates = Pick<
  LifeOpsCalendarEvent,
  "startAt" | "endAt" | "isAllDay" | "timezone"
>;

export function formatHandoffEventDate(
  event: EventDates,
  locale = "en-US",
): string {
  const start = new Date(
    event.isAllDay ? `${event.startAt.split("T")[0]}T00:00:00Z` : event.startAt,
  );
  const end = new Date(
    event.isAllDay ? `${event.endAt.split("T")[0]}T00:00:00Z` : event.endAt,
  );
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start
  ) {
    return "Date unavailable";
  }
  try {
    if (event.isAllDay) {
      const format = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      // Calendar all-day end dates are exclusive; display the last included day.
      const lastDay = new Date(end.getTime() - 86_400_000);
      return `${format.format(start)}${lastDay.getTime() === start.getTime() ? "" : ` – ${format.format(lastDay)}`} · All day`;
    }
    const format = new Intl.DateTimeFormat(locale, {
      timeZone: event.timezone ?? "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `${format.format(start)} – ${format.format(end)}`;
  } catch (error) {
    // error-policy:J4 Invalid persisted timezones render an explicit unavailable date.
    if (error instanceof RangeError) return "Date unavailable";
    throw error;
  }
}
