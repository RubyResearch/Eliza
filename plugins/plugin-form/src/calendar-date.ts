/**
 * Normalizes form date answers as calendar days, without interpreting a
 * date-only answer as an instant in the host timezone. Unsupported and
 * yearless text stays invalid rather than becoming a different saved day.
 */

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, index) => [name, index + 1]),
);
for (const [name, month] of [...MONTHS]) MONTHS.set(name.slice(0, 3), month);
MONTHS.set("sept", 9);

function calendarDay(
  year: number,
  month: number,
  day: number,
): string | undefined {
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const instant = new Date(`${iso}T00:00:00.000Z`);
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() + 1 !== month ||
    instant.getUTCDate() !== day
  ) {
    return undefined;
  }
  return iso;
}

/** Accept explicit ISO, US numeric, and English month-name dates with a year. */
export function parseCalendarDate(value: string): string | undefined {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const yearFirst = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (yearFirst) {
    return calendarDay(
      Number(yearFirst[1]),
      Number(yearFirst[2]),
      Number(yearFirst[3]),
    );
  }

  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (numeric) {
    return calendarDay(
      Number(numeric[3]),
      Number(numeric[1]),
      Number(numeric[2]),
    );
  }

  const named =
    /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{1,2}),? (\d{4})$/i.exec(
      text,
    );
  if (named) {
    const month = MONTHS.get(named[1]?.toLowerCase() ?? "");
    if (month) return calendarDay(Number(named[3]), month, Number(named[2]));
  }

  const dayFirst =
    /^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{4})$/i.exec(
      text,
    );
  if (dayFirst) {
    const month = MONTHS.get(dayFirst[2]?.toLowerCase() ?? "");
    if (month)
      return calendarDay(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  return undefined;
}

/** Render the named day using the viewer's locale, never the host's UTC offset. */
export function formatCalendarDate(value: string): string | undefined {
  const iso = parseCalendarDate(value);
  if (!iso) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00.000Z`));
}
