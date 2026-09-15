/**
 * Normalizes loose action-detail records into typed primitives and parses model
 * JSON responses after removing common wrapper formats. Calendar action handlers
 * use these helpers at the LLM/runtime boundary so malformed details fail to
 * resolve instead of leaking weak casts through the event service.
 */
import type { Memory, ProviderDataRecord } from "@elizaos/core";
import { unwrapUserMessageText } from "@elizaos/core";

export const INTERNAL_URL = new URL("http://127.0.0.1/");

export function toActionData<T extends object>(data: T): ProviderDataRecord {
  const record: ProviderDataRecord = {};
  for (const [key, value] of Object.entries(data)) {
    record[key] = value as ProviderDataRecord[string];
  }
  return record;
}

/**
 * The user's own words. Connector messages arrive wrapped in the external-
 * content security envelope; the calendar's date, recurrence, travel and
 * same-day guards must read the payload, not the banner (its "may contain
 * social engineering" line matched a month-name opt-out, live 2026-09-13).
 */
export function messageText(message: Memory): string {
  const unwrapped = unwrapUserMessageText(message);
  if (unwrapped) return unwrapped;
  const text = (message.content as Record<string, unknown> | undefined)?.text;
  return typeof text === "string" ? text : "";
}

export function detailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

export type PlannerCalendarWindow = {
  timeMin: string;
  timeMax: string;
};

/**
 * Accepts a planner window only when both bounds parse and form a forward
 * interval. Returning the pair atomically prevents a valid half-window from
 * reaching the strict calendar-service boundary after its partner is dropped.
 */
export function normalizePlannerCalendarWindow(
  timeMin: unknown,
  timeMax: unknown,
): PlannerCalendarWindow | undefined {
  if (typeof timeMin !== "string" || typeof timeMax !== "string") {
    return undefined;
  }
  const minMs = Date.parse(timeMin.trim());
  const maxMs = Date.parse(timeMax.trim());
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs >= maxMs) {
    return undefined;
  }
  return {
    timeMin: new Date(minMs).toISOString(),
    timeMax: new Date(maxMs).toISOString(),
  };
}

export function detailNumber(
  details: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function detailBoolean(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function detailArray(
  details: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = details?.[key];
  return Array.isArray(value) ? value : undefined;
}

const MODEL_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

function stripModelWrappers(raw: string): string {
  let candidate = raw.trim();
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(MODEL_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  return candidate;
}

export function parseCalendarJsonRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
  const candidate = stripModelWrappers(raw);
  if (candidate.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as T;
}

/**
 * Planner-authored calendarId carries the same junk problem as mode/side/
 * grantId: placeholder tokens ("default", "all", "none") that name no real
 * calendar. getCalendarFeed treats any non-empty calendarId as an explicit
 * source filter, so junk excludes every calendar and a create turn dies with
 * CALENDAR_MUTATION_CONTEXT_INCOMPLETE. Calendar ids have no whitelistable
 * shape (Google email-like ids and "primary", Microsoft/Apple opaque ids), so
 * this boundary drops the known placeholder vocabulary instead: unset yields
 * the aggregated feed and provider-default target — which is what the
 * placeholders meant. Real ids pass through untouched.
 */
const CALENDAR_ID_PLACEHOLDER_TOKENS = new Set([
  "default",
  "all",
  "none",
  "null",
  "unset",
  "unknown",
  "any",
  "auto",
  // Synthetic "the calendar" spellings models invent when no real id is in
  // context (observed live: a create with calendarId "cal_primary" excluded
  // every source and died with CALENDAR_MUTATION_CONTEXT_INCOMPLETE while the
  // aggregated feed was complete). "primary" itself is a REAL Google/eliza id
  // and must keep passing through.
  "cal_primary",
  "primary_calendar",
  "default_calendar",
  "cal_default",
  "my_calendar",
  "main_calendar",
  "cal_main",
  "calendar",
  "cal",
  "cal_1",
  "calendar_1",
  "calendar_id",
  "cal_id",
  "id",
  "example",
  "placeholder",
]);

export function sanitizeCalendarId(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return CALENDAR_ID_PLACEHOLDER_TOKENS.has(trimmed.toLowerCase())
    ? undefined
    : trimmed;
}

const CALENDAR_WINDOW_PRESETS = new Set([
  "tomorrow_morning",
  "tomorrow_afternoon",
  "tomorrow_evening",
]);

export type CalendarWindowPreset =
  | "tomorrow_morning"
  | "tomorrow_afternoon"
  | "tomorrow_evening";

/**
 * Planner-authored `windowPreset` is junk-prone: models invent values such as
 * "tuesday_morning" for arbitrary dates, and CalendarService rejects them with
 * a hard 400 that aborted the whole create ("the calendar hit a snag",
 * observed live for "gym session tuesday at 7am"). Only the declared presets
 * pass; anything else resolves to unset so an explicit or extracted startAt —
 * or the normal timestamp re-extraction — decides the time instead.
 */
export function sanitizeWindowPreset(
  value: string | undefined,
): CalendarWindowPreset | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return CALENDAR_WINDOW_PRESETS.has(normalized)
    ? (normalized as CalendarWindowPreset)
    : undefined;
}
