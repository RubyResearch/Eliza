import type { StateData } from "../../types";

/**
 * Grounding for stated dates and clock times. The CURRENT_TIME provider puts
 * the user's wall-clock time in the prompt with an explicit "answer from this
 * block only" instruction, and small models still occasionally invent a date
 * (live 2026-09-07 "2:16 pm EST"; live 2026-09-11 "Sunday, November 22, 2026
 * at 5:01:28 PM EST" against a block reading "Friday, September 11, 2026 at
 * 11:18:30 AM EDT"). When the user asked what time or day it is, a reply
 * that names a date, weekday or clock time the provider did not observe is
 * ungrounded, and the provider's own rendering is the complete answer.
 */

const TIME_QUESTION_PATTERN =
	/\b(?:what(?:'s|s| is)?\s+(?:the\s+)?(?:current\s+|local\s+|today'?s\s+)?(?:time|day|date)\b|time is it\b|day is it\b|date is it\b|current (?:time|date)\b|day of the week\b|today'?s date\b)/i;

const MONTH_NAMES = [
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
];

const WEEKDAY_NAMES = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

const MONTH_DAY_PATTERN =
	/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi;
const CLOCK_PATTERN =
	/\b(\d{1,2})(?::(\d{2}))(?::\d{2})?\s*(AM|PM|a\.m\.|p\.m\.)/gi;
const WEEKDAY_PATTERN =
	/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi;

const CLOCK_TOLERANCE_MINUTES = 10;

export interface ObservedCurrentTime {
	humanReadable: string;
	/** Local calendar date, `YYYY-MM-DD`. */
	date: string;
	iso: string;
	timeZone: string;
	dayOfWeek?: string;
}

function readString(record: unknown, key: string): string | undefined {
	if (!record || typeof record !== "object") return undefined;
	const value = (record as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** The CURRENT_TIME provider's observation for this turn, if it ran. */
export function observedCurrentTime(
	providers: StateData["providers"] | undefined,
): ObservedCurrentTime | undefined {
	const entry = providers?.CURRENT_TIME as
		| { data?: unknown; values?: unknown }
		| undefined;
	if (!entry) return undefined;
	const humanReadable = readString(entry.data, "humanReadable");
	const date =
		readString(entry.data, "date") ?? readString(entry.values, "currentDate");
	const iso =
		readString(entry.data, "iso") ?? readString(entry.values, "currentTime");
	const timeZone =
		readString(entry.data, "timeZone") ?? readString(entry.values, "timeZone");
	if (!humanReadable || !date || !iso || !timeZone) return undefined;
	return {
		humanReadable,
		date,
		iso,
		timeZone,
		dayOfWeek:
			readString(entry.data, "dayOfWeek") ??
			readString(entry.values, "dayOfWeek"),
	};
}

export function requestAsksCurrentTime(request: string | undefined): boolean {
	return typeof request === "string" && TIME_QUESTION_PATTERN.test(request);
}

function localParts(observed: ObservedCurrentTime): {
	month: number;
	day: number;
	year: number;
	minuteOfDay: number;
	weekday: number;
} | null {
	const instant = new Date(observed.iso);
	if (!Number.isFinite(instant.getTime())) return null;
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone: observed.timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "long",
		}).formatToParts(instant);
	} catch {
		return null;
	}
	const read = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? "";
	const weekday = WEEKDAY_NAMES.indexOf(read("weekday").toLowerCase());
	return {
		month: Number(read("month")),
		day: Number(read("day")),
		year: Number(read("year")),
		minuteOfDay: Number(read("hour")) * 60 + Number(read("minute")),
		weekday,
	};
}

/**
 * True when the user asked for the current time or date and the reply names
 * a calendar date, weekday or clock time that does not match the provider's
 * observation. Replies without such statements are not judged here.
 */
export function statedTimeIsUngrounded(args: {
	reply: string;
	request?: string;
	providers?: StateData["providers"];
}): boolean {
	if (!requestAsksCurrentTime(args.request)) return false;
	const observed = observedCurrentTime(args.providers);
	if (!observed) return false;
	const local = localParts(observed);
	if (!local) return false;
	const reply = args.reply;
	for (const match of reply.matchAll(MONTH_DAY_PATTERN)) {
		const month = MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1;
		const day = Number(match[2]);
		const year = match[3] ? Number(match[3]) : undefined;
		if (month !== local.month || day !== local.day) return true;
		if (year !== undefined && year !== local.year) return true;
	}
	for (const match of reply.matchAll(WEEKDAY_PATTERN)) {
		if (WEEKDAY_NAMES.indexOf(match[1].toLowerCase()) !== local.weekday)
			return true;
	}
	for (const match of reply.matchAll(CLOCK_PATTERN)) {
		const hour12 = Number(match[1]) % 12;
		const minute = Number(match[2] ?? "0");
		const pm = /^p/i.test(match[3]);
		const stated = hour12 * 60 + minute + (pm ? 12 * 60 : 0);
		const drift = Math.abs(stated - local.minuteOfDay);
		if (Math.min(drift, 24 * 60 - drift) > CLOCK_TOLERANCE_MINUTES) return true;
	}
	return false;
}

/** The complete, provider-observed answer to a current-time question. */
export function groundedCurrentTimeReply(
	providers: StateData["providers"] | undefined,
): string | undefined {
	const observed = observedCurrentTime(providers);
	return observed ? `It's ${observed.humanReadable}.` : undefined;
}
