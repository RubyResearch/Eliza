/**
 * Factory for the `CALENDAR` assistant action and its LLM-backed handler.
 *
 * `createCalendarActionRunner` wires the host-injected dependencies (the model
 * runner and calendar-service access) and returns the `CALENDAR` action.
 * `extractCalendarPlanWithLlm` turns a natural-language request plus recent
 * conversation into a structured `CalendarLlmPlan` (subaction, time window,
 * search queries), and the handler executes that plan against `CalendarService`
 * — read feed, next event, search, create/update/delete events, trip windows —
 * providing receipt-bound evidence to the planner evaluator for its reply.
 * `plugin-lifeops` consumes this as the
 * calendar assistant action.
 */
import { createHash } from "node:crypto";
import type {
  Action,
  ActionExample,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  describeUserReference,
  normalizeEffectReceipt,
  resolveOptimizedPromptForRuntime,
  unwrapUserMessageText,
  userReferenceLogView,
} from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared";
import {
  selectUserAuthorizedRecurrence,
  textStatesExplicitRecurrence,
} from "@elizaos/shared";
import { isAppleCalendarGrant } from "../apple-calendar.js";
import { CALENDAR_DETAILS_PARAMETER_SCHEMA } from "../calendar-action-schema.js";
import { normalizeCalendarDateTimeInTimeZone } from "../internal/calendar-normalize.js";
import {
  CALENDAR_TIME_ZONE_ALIASES,
  isValidTimeZone,
  resolveDefaultTimeZone,
} from "../internal/constants.js";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  INTERNAL_URL,
  messageText,
  normalizePlannerCalendarWindow,
  parseCalendarJsonRecord,
  sanitizeCalendarId,
  sanitizeWindowPreset,
  toActionData,
} from "../internal/detail.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_PROVIDER,
} from "../internal/eliza-calendar.js";
import { basicEmailValid } from "../internal/email.js";
import { CalendarServiceError } from "../internal/errors.js";
import {
  formatCalendarEventDateTime,
  formatCalendarFeed,
  formatNextEventContext,
} from "../internal/format.js";
import { GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX } from "../internal/google-delegates.js";
import {
  describeRecurrence,
  normalizeRecurrenceScope,
  recurrenceLinesFrom,
  recurringEventIdFrom,
} from "../internal/recurrence.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "../internal/time.js";
import { isMicrosoftCalendarGrantId } from "../microsoft/accounts.js";
import { CalendarService } from "../service/CalendarService.js";
import type {
  CalendarActionDeps,
  CalendarModelCallArgs,
  CalendarMutationApprovalResult,
  CalendarTravelBufferResult,
  CalendarTravelIntent,
} from "./deps.js";
import { CALENDAR_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

export { CALENDAR_PLAN_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

/**
 * Host-supplied dependencies, set once when the calendar action is built via
 * {@link createCalendarActionRunner}. The CALENDAR action is registered exactly
 * once per plugin instance, so a module-level holder is the right seam: it
 * keeps the ~40 internal handler functions from each having to thread a `deps`
 * parameter, without leaking the host (LifeOps) into this package's imports.
 */
let injectedDeps: CalendarActionDeps | null = null;

function deps(): CalendarActionDeps {
  if (!injectedDeps) {
    throw new Error(
      "[calendar] calendar action handler invoked before createCalendarActionRunner() supplied dependencies",
    );
  }
  return injectedDeps;
}

function runLifeOpsTextModel(
  args: CalendarModelCallArgs,
): Promise<string | null> {
  return deps().runTextModel(args);
}

function runLifeOpsJsonModel<
  T extends Record<string, unknown> = Record<string, unknown>,
>(args: CalendarModelCallArgs) {
  return deps().runJsonModel<T>(args);
}

function collectRecentConversationTexts(args: {
  runtime: IAgentRuntime;
  message?: Memory;
  state: State | undefined;
  /** @deprecated Complete conversation context is always returned. */
  limit?: number;
}): Promise<string[]> {
  return deps().recentConversationTexts(args);
}

/**
 * Resolve the calendar domain service. Mirrors the prior `new LifeOpsService`
 * construction — the 7 calendar methods (`getCalendarFeed`,
 * `getNextCalendarEventContext`, `createCalendarEvent`, `updateCalendarEvent`,
 * `deleteCalendarEvent`, …) are identical on `CalendarService`.
 */
function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service) {
    throw new CalendarServiceError(
      503,
      "Calendar service is not available.",
      "CALENDAR_SERVICE_UNAVAILABLE",
    );
  }
  return service;
}

function requireCalendarMutationGateway() {
  const gateway = deps().mutationGateway;
  if (!gateway) {
    throw new CalendarServiceError(
      503,
      "Calendar changes require owner approval, but the approval gateway is unavailable.",
      "CALENDAR_APPROVAL_GATEWAY_UNAVAILABLE",
    );
  }
  return gateway;
}

function requireCompleteFreshCalendarFeed(
  feed: LifeOpsCalendarFeed,
  operation: "create" | "update" | "delete",
): LifeOpsCalendarFeed {
  if (
    feed.state !== "complete" ||
    feed.sources.some((source) => source.status !== "fresh")
  ) {
    throw new CalendarServiceError(
      503,
      `Calendar ${operation} is blocked because one or more requested calendar sources are incomplete or unavailable.`,
      "CALENDAR_MUTATION_CONTEXT_INCOMPLETE",
    );
  }
  return feed;
}

// Planner-authored `details` records are junk-prone input: the planner fills
// every schema key, and the connector-scope hints (`mode`, `side`, `grantId`)
// have no legitimate planner-visible source unless copied verbatim from a
// provider-rendered grant. CalendarService enum-validates these fields with a
// hard 400 — correct for its HTTP routes, fatal for a chat turn: live
// regression 2026-08-09 had feed reads failing CALENDAR_SERVICE_400 because
// the planner filled `mode:"read"` and `grantId:"primary"`. The action
// boundary therefore accepts only recognizable values and drops the rest, so
// placeholder junk cannot abort the read the user asked for.
function connectorModeDetail(
  details: Record<string, unknown> | undefined,
): "local" | "remote" | "cloud_managed" | undefined {
  const value = detailString(details, "mode");
  return value === "local" || value === "remote" || value === "cloud_managed"
    ? value
    : undefined;
}

function connectorSideDetail(
  details: Record<string, unknown> | undefined,
): "owner" | "agent" | undefined {
  const value = detailString(details, "side");
  return value === "owner" || value === "agent" ? value : undefined;
}

// Mutation lookups must stay unscoped when the planner omits grantId: the
// aggregated feed already includes the built-in Eliza source alongside every
// connected provider, so defaulting the lookup to one grant would hide
// external events (and their busy windows) from update/delete/create flows.
// Only values shaped like a real grant id pass through — junk like "primary"
// or "all" would otherwise scope discovery to a nonexistent grant and turn a
// full-feed read into a fabricated-account provider call.
function connectorGrantIdDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const value = detailString(details, "grantId");
  if (!value) return undefined;
  return isAppleCalendarGrant(value) ||
    isMicrosoftCalendarGrantId(value) ||
    value === ELIZA_CALENDAR_GRANT_ID ||
    value.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? value
    : undefined;
}

// Placeholder filtering lives in sanitizeCalendarId (internal/detail.ts); it
// must guard every path a planner-authored calendarId can travel — both the
// direct details read here and the fallbackRequest carry-over in
// buildCreateEventRequest, which replays an earlier planner request and can
// smuggle the same junk back in.
function calendarIdDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  return sanitizeCalendarId(detailString(details, "calendarId"));
}

function plannerWindowDetail(
  details: Record<string, unknown> | undefined,
): { timeMin: string; timeMax: string } | undefined {
  return normalizePlannerCalendarWindow(details?.timeMin, details?.timeMax);
}

// Whether the planner supplied a window we can actually search with. This has
// to key off the NORMALIZED pair, not raw presence: an unusable window (one
// bound, unparseable, reversed) that still counted as "provided" would send an
// event lookup down the 30-day search default instead of buildWideLookupRange
// (-365d..+5y), so update/delete-by-title for an event two months out would
// silently resolve to "not found".
function plannerWindowUsable(
  details: Record<string, unknown> | undefined,
  llmPlan: CalendarLlmPlan,
): boolean {
  return Boolean(
    plannerWindowDetail(details) ??
      normalizePlannerCalendarWindow(llmPlan.timeMin, llmPlan.timeMax),
  );
}

type CreateEventTravelIntent = CalendarTravelIntent;

type CalendarSubaction =
  | "feed"
  | "next_event"
  | "search_events"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "trip_window";

const CALENDAR_SUBACTION_VALUES: readonly CalendarSubaction[] = [
  "feed",
  "next_event",
  "search_events",
  "create_event",
  "update_event",
  "delete_event",
  "trip_window",
];

type RankedCalendarSearchCandidate = {
  event: LifeOpsCalendarEvent;
  score: number;
  matchedQueries: string[];
};

type CreateEventCalendarContext = {
  calendarTimeZone: string;
  feed: LifeOpsCalendarFeed;
};

export type CalendarLlmPlan = {
  subaction: CalendarSubaction | null;
  queries: string[];
  response?: string;
  shouldAct?: boolean | null;
  title?: string;
  tripLocation?: string;
  timeMin?: string;
  timeMax?: string;
  windowLabel?: string;
};

const MIN_CREATE_EVENT_DURATION_MINUTES = 15;
type CalendarReadSubaction =
  | "feed"
  | "next_event"
  | "search_events"
  | "trip_window"
  | null;
type CalendarLookupReadSubaction = "next_event" | "search_events";
type CalendarMutationSubaction =
  | "create_event"
  | "update_event"
  | "delete_event";

type CalendarActionParams = {
  subaction?: CalendarSubaction;
  intent?: string;
  title?: string;
  query?: string;
  queries?: string[];
  details?: Record<string, unknown>;
};

const PARAMETER_DOC_NOISE_PATTERN =
  /\b(?:actions?|params?|parameters?|query\?:string|subaction\?:string|details\?:object|required parameter|supported keys include|may include:|match against titles|structured calendar arguments|structured data when needed|boolean when)\b|\b\w+\?:\w+\b/i;

// Tool planners sometimes fill omitted structured controls with their schema
// key (or the next comma-led key fragment). Filter only fields that route or
// constrain an operation. User-authored title/query/description/location data
// intentionally bypasses this heuristic because those exact strings are valid.
const PLANNER_CONTROL_DETAIL_KEYS = new Set([
  "calendarId",
  "eventId",
  "grantId",
  "label",
  "mode",
  "recurrenceScope",
  "side",
  "startAt",
  "endAt",
  "timeMin",
  "timeMax",
  "timeZone",
  "windowPreset",
]);
const PLANNER_KEY_FRAGMENT_PATTERN = /^,\s*[A-Za-z_][A-Za-z0-9_-]*\s*:?$/;

const I18N_LOCALES = ["en", "zh-CN", "ko", "es", "pt", "vi", "tl"];

function buildIntlMonthMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let month = 0; month < 12; month++) {
      const date = new Date(2024, month, 15);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { month: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = month + 1;
      }
    }
  }
  return map;
}

function buildIntlWeekdayMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(2024, 0, 7 + dow);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { weekday: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = dow;
      }
    }
  }
  return map;
}

const MONTH_MAP: Record<string, number> = buildIntlMonthMap();
const WEEKDAY_MAP: Record<string, number> = buildIntlWeekdayMap();

const MONTH_NAMES_SORTED = Object.keys(MONTH_MAP).sort(
  (a, b) => b.length - a.length,
);
const MONTH_NAME_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "i",
);

const WEEKDAY_NAMES_SORTED = Object.keys(WEEKDAY_MAP).sort(
  (a, b) => b.length - a.length,
);
const WEEKDAY_NAME_PATTERN = new RegExp(
  `\\b(?:(this|next)\\s+)?(${WEEKDAY_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
const CALENDAR_DETAIL_ALIASES = {
  calendarId: ["calendarid", "calendar_id"],
  timeMin: ["timemin", "time_min"],
  timeMax: ["timemax", "time_max"],
  timeZone: ["timezone", "time_zone"],
  forceSync: ["forcesync", "force_sync"],
  windowDays: ["windowdays", "window_days"],
  startAt: ["startat", "start_at", "start", "start_time", "starttime"],
  endAt: ["endat", "end_at", "end", "end_time", "endtime"],
  durationMinutes: ["durationminutes", "duration_minutes"],
  windowPreset: ["windowpreset", "window_preset"],
  eventId: [
    "eventid",
    "event_id",
    "externaleventid",
    "external_event_id",
    "googleeventid",
    "google_event_id",
  ],
  newTitle: ["newtitle", "new_title", "renameto", "rename_to"],
  oldTitle: ["oldtitle", "old_title"],
  description: ["desc", "summary", "body"],
  location: ["place", "venue"],
  recurrence: [
    "rrule",
    "recurrencerule",
    "recurrence_rule",
    "repeat",
    "repeats",
    "repeatrule",
    "repeat_rule",
  ],
  recurrenceScope: [
    "recurrencescope",
    "recurrence_scope",
    "applyto",
    "apply_to",
    "editscope",
    "edit_scope",
  ],
  travelOriginAddress: [
    "traveloriginaddress",
    "travel_origin_address",
    "travelorigin",
    "travel_origin",
    "originaddress",
    "origin_address",
    "departureaddress",
    "departure_address",
    "fromaddress",
    "from_address",
  ],
} as const;

/** Deterministic "just this occurrence" phrasing across mutation requests. */
const RECURRENCE_SCOPE_INSTANCE_PATTERN =
  /\b(?:just|only)\s+(?:this|that)(?:\s+(?:one|time|occurrence|instance|event|meeting|week))?\b|\bthis\s+(?:one|occurrence|instance)\s+only\b|\bsingle\s+occurrence\b/i;

/** Deterministic split-at-occurrence phrasing across mutation requests. */
const RECURRENCE_SCOPE_THIS_AND_FOLLOWING_PATTERN =
  /\b(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting|[a-z0-9_-]+))?\s+(?:and|&)\s+(?:(?:all|every)\s+)?(?:following|future|everything\s+after)(?:\s+(?:events|occurrences|instances|ones))?\b|\bfrom\s+(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting))?\s+(?:forward|onwards?|on)\b|\bstarting\s+(?:with|at)\s+(?:this|that)(?:\s+(?:one|occurrence|instance|event|meeting))?\b/i;

/** Deterministic "the whole series" phrasing across mutation requests. */
const RECURRENCE_SCOPE_SERIES_PATTERN =
  /\b(?:whole|entire|full)\s+series\b|\bthe\s+series\b|\ball\s+(?:occurrences|instances|of\s+them)\b|\bevery\s+(?:occurrence|instance|single\s+one)\b|\bstop\s+(?:it\s+)?(?:from\s+)?(?:repeating|recurring)\b|\bcancel\s+the\s+recurring\b/i;

/**
 * Planner-authored `recurrenceScope` at the action boundary: recognized values
 * normalize, anything else means "the user did not specify". The strict
 * normalizer's fail-closed 400 is for API callers; here the value is
 * model-emitted, and junk in it (observed as fragments of neighboring key
 * names) must degrade to unset — the same contract this file already applies
 * to planner-authored calendarId, windows, mode, side, and grantId — so a
 * mutation turn falls back to the user's own phrasing instead of dying.
 */
function lenientRecurrenceScope(
  value: unknown,
): LifeOpsCalendarRecurrenceScope | null {
  try {
    return normalizeRecurrenceScope(value) ?? null;
  } catch {
    // error-policy:J3 model-emitted debris is "not specified"; scope intent
    // falls back to explicit message phrasing below.
    return null;
  }
}

/**
 * Structural resolution of one, following, or whole-series intent: explicit
 * `recurrenceScope` detail first, then unambiguous message phrasing. Returns
 * null when the intent stays ambiguous — the caller must ask instead of
 * mutating.
 */
export function resolveRecurrenceScopeIntent(args: {
  details: Record<string, unknown> | undefined;
  fallbackDetails?: Record<string, unknown>;
  text: string;
}): LifeOpsCalendarRecurrenceScope | null {
  const explicit =
    lenientRecurrenceScope(detailString(args.details, "recurrenceScope")) ??
    lenientRecurrenceScope(
      detailString(args.fallbackDetails, "recurrenceScope"),
    );
  if (explicit) {
    return explicit;
  }
  const matchesInstance = RECURRENCE_SCOPE_INSTANCE_PATTERN.test(args.text);
  const matchesThisAndFollowing =
    RECURRENCE_SCOPE_THIS_AND_FOLLOWING_PATTERN.test(args.text);
  const matchesSeries = RECURRENCE_SCOPE_SERIES_PATTERN.test(args.text);
  const matches = [
    matchesInstance,
    matchesThisAndFollowing,
    matchesSeries,
  ].filter(Boolean).length;
  if (matches !== 1) {
    return null;
  }
  if (matchesInstance) return "instance";
  return matchesThisAndFollowing ? "this_and_following" : "series";
}

function isRecurringCalendarEvent(event: LifeOpsCalendarEvent | null): boolean {
  return Boolean(recurringEventIdFrom(event) || recurrenceLinesFrom(event));
}

/**
 * An RFC 5545 recurrence line, by shape. The planner smears whatever string it
 * has on hand into unrelated fields — a plain "add grindlewald standup on
 * friday at 10am" arrived with the TITLE in `recurrence`, and `parseRecurrenceRule`
 * threw `Invalid recurrence rule: malformed part "grindlewald standup"`, failing
 * the whole create for a repetition the user never asked for (live 2026-08-14).
 *
 * Validation downstream is correct and stays; the job here is to not hand it
 * debris. Same stance as the recurrenceScope guard: a junk value means the
 * field was never set, not that the request is invalid.
 */
function looksLikeRecurrenceLine(line: string): boolean {
  return (
    /^(?:RRULE|RDATE|EXDATE|EXRULE)[:;]/i.test(line) || /FREQ=/i.test(line)
  );
}

function detailRecurrenceLines(
  details: Record<string, unknown> | undefined,
  key = "recurrence",
): string[] | undefined {
  if (!details) {
    return undefined;
  }
  const value = details[key];
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((line): line is string => typeof line === "string")
        : [];
  const lines = raw
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && looksLikeRecurrenceLine(line));
  return lines.length > 0 ? lines : undefined;
}

function buildRecurrenceScopeClarification(args: {
  action: "update" | "delete";
  event: LifeOpsCalendarEvent;
}): string {
  const description =
    describeRecurrence(recurrenceLinesFrom(args.event)) ??
    "on a repeating schedule";
  const verb = args.action === "update" ? "change" : "delete";
  return `"${args.event.title}" repeats ${description}. should i ${verb} just this occurrence, this and every following occurrence, or the whole series?`;
}

function normalizeCalendarSubaction(value: unknown): CalendarSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "feed":
    case "next_event":
    case "search_events":
    case "create_event":
    case "update_event":
    case "delete_event":
    case "trip_window":
      return normalized;
    default:
      return null;
  }
}

function buildCalendarPlanFromParsed(
  parsed: Record<string, unknown>,
): CalendarLlmPlan | null {
  const subaction = normalizeCalendarSubaction(parsed.subaction);
  const shouldAct =
    normalizeShouldAct(parsed.shouldAct) ?? (subaction ? true : null);
  if (shouldAct === null) {
    return null;
  }

  if (shouldAct && subaction === null) {
    return null;
  }

  const tripLocation =
    typeof parsed.tripLocation === "string" &&
    parsed.tripLocation.trim().length > 0
      ? parsed.tripLocation.trim()
      : undefined;

  const rawQueries: Array<string | undefined> = [];
  if (typeof parsed.queries === "string" && parsed.queries.trim().length > 0) {
    for (const q of parsed.queries.split(/\s{0,256}\|\|\s{0,256}/)) {
      if (q.trim().length > 0) rawQueries.push(q.trim());
    }
  } else if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") rawQueries.push(value);
    }
  }
  if (typeof parsed.query === "string") rawQueries.push(parsed.query);
  if (typeof parsed.query1 === "string") rawQueries.push(parsed.query1);
  if (typeof parsed.query2 === "string") rawQueries.push(parsed.query2);
  if (typeof parsed.query3 === "string") rawQueries.push(parsed.query3);
  if (tripLocation) rawQueries.push(tripLocation);

  return {
    subaction,
    queries: dedupeCalendarQueries(rawQueries),
    response: normalizePlannerResponse(parsed.response),
    shouldAct,
    title:
      typeof parsed.title === "string" && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : undefined,
    tripLocation,
    timeMin: normalizeIsoDateTime(parsed.timeMin),
    timeMax: normalizeIsoDateTime(parsed.timeMax),
    windowLabel: normalizeWindowLabel(parsed.windowLabel ?? parsed.label),
  };
}

function formatCalendarPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "none";
    }
    return value
      .map(
        (entry, index) =>
          `item ${index + 1}: ${formatCalendarPromptValue(entry)}`,
      )
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "none";
    }
    return entries
      .map(([key, entry]) => `${key}: ${formatCalendarPromptValue(entry)}`)
      .join("\n");
  }
  return String(value);
}

function buildCalendarPlanRepairPrompt(args: {
  currentMessage: string;
  intent: string;
  recentConversation: string;
  rawResponse: string;
  timeZone: string;
  nowIso: string;
  localNow: string;
}): string {
  return [
    "Your last reply for the calendar planner was invalid or used the wrong schema.",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-action",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false, otherwise empty or null",
    "  queries: array or ||-delimited string of up to 3 search queries",
    "  title: optional event title",
    "  tripLocation: optional trip location",
    "  timeMin: optional ISO 8601 datetime",
    "  timeMax: optional ISO 8601 datetime",
    "  windowLabel: optional natural-language window label",
    "",
    "Use ONLY these exact subaction literals:",
    `  ${CALENDAR_SUBACTION_VALUES.join(", ")}, or null`,
    "Never invent synonyms such as edit_event, modify_event, reschedule_event, move_event, cancel_event, remove_event, agenda, or itinerary_window.",
    "Map rename/reschedule/move/edit requests for an existing event to update_event.",
    "Map delete/remove/cancel requests for an existing event to delete_event.",
    "The user may speak in any language.",
    "",
    `Current timezone: ${args.timeZone}`,
    `Current local datetime: ${args.localNow}`,
    `Current ISO datetime: ${args.nowIso}`,
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Previous invalid output:\n${args.rawResponse}`,
  ].join("\n");
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildCalendarReplyOnlyFallback(
  subaction: CalendarSubaction | null,
): string {
  switch (subaction) {
    case "create_event":
      return "What event do you want to add, and when should it happen?";
    case "search_events":
    case "trip_window":
      return "What calendar event or trip do you want me to look up?";
    case "next_event":
    case "feed":
      return "Do you want today's schedule, your next event, or a specific event?";
    case "update_event":
      return "Which calendar event do you want to change, and what should change?";
    case "delete_event":
      return "Which calendar event do you want to delete?";
    default:
      return "What do you want to do on your calendar — check your schedule, find an event, or create one?";
  }
}

function normalizeCalendarReadSubaction(value: unknown): CalendarReadSubaction {
  if (
    value === "feed" ||
    value === "next_event" ||
    value === "search_events" ||
    value === "trip_window"
  ) {
    return value;
  }
  return null;
}

function normalizeCalendarLookupReadSubaction(
  value: unknown,
): CalendarLookupReadSubaction | null {
  if (value === "next_event" || value === "search_events") {
    return value;
  }
  return null;
}

function normalizeCalendarMutationSubaction(
  value: unknown,
): CalendarMutationSubaction | null {
  if (
    value === "create_event" ||
    value === "update_event" ||
    value === "delete_event"
  ) {
    return value;
  }
  return null;
}

function normalizeCalendarReadResolution(
  parsed: Record<string, unknown> | null | undefined,
): { subaction: CalendarReadSubaction; tripLocation?: string } | null {
  if (!parsed) {
    return null;
  }
  const subaction = normalizeCalendarReadSubaction(parsed.subaction);
  const tripLocation =
    typeof parsed.tripLocation === "string" &&
    parsed.tripLocation.trim().length > 0
      ? parsed.tripLocation.trim()
      : undefined;
  return { subaction, tripLocation };
}

function shouldDisambiguateCalendarReadPlan(
  plan: CalendarLlmPlan | null,
): boolean {
  if (plan === null) {
    return true;
  }
  return (
    plan.subaction === null ||
    plan.subaction === "feed" ||
    plan.subaction === "next_event" ||
    plan.subaction === "search_events"
  );
}

const CALENDAR_READ_DISAMBIGUATION_RULES = [
  "If the request combines a time window with a specific attendee, title, flight, appointment, or keyword, choose search_events, not feed.",
  "If the request asks what is happening while the user is in a place, choose trip_window, not search_events.",
  "If the request asks for the next or upcoming single meeting or appointment, choose next_event.",
  "If the request asks for a schedule, agenda, or list of events over a time window, choose feed.",
] as const;

const CALENDAR_MUTATION_INTENT_PATTERN =
  /\b(?:add|book|cancel|change|clear|create|delete|edit|move|put|remove|rename|reschedule|reserve|set\s+up|update)\b|\bschedule\s+(?:a|an|the|my|with|for|meeting|appointment|call|event|block|lunch|dinner)\b/i;
const CALENDAR_BROAD_FEED_PATTERN =
  /\b(?:agenda|week ahead)\b|\b(?:show|list|what(?:'s| is)).*(?:calendar|schedule|agenda)\b|\bwhat do i have (?:today|tomorrow|this|on)\b/i;
const CALENDAR_NEXT_EVENT_PATTERN =
  /\b(?:next|upcoming|nearest)\s+(?:appointment|event|meeting)\b|\bwhat(?:'s| is) my next\b/i;

function isSafeReadOnlyCalendarPlan(
  plan: CalendarLlmPlan | null,
  currentMessage: string,
  intent: string,
): boolean {
  if (!plan || plan.shouldAct === false || !plan.subaction) {
    return false;
  }
  const text = `${currentMessage}\n${intent}`;
  if (CALENDAR_MUTATION_INTENT_PATTERN.test(text)) {
    return false;
  }

  switch (plan.subaction) {
    case "feed":
      return CALENDAR_BROAD_FEED_PATTERN.test(text);
    case "next_event":
      return CALENDAR_NEXT_EVENT_PATTERN.test(text);
    case "search_events":
      return plan.queries.length > 0;
    case "trip_window":
      return Boolean(plan.tripLocation || plan.queries.length > 0);
    default:
      return false;
  }
}

async function disambiguateCalendarReadPlanWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarSubaction | null;
}): Promise<{
  subaction: CalendarReadSubaction;
  tripLocation?: string;
} | null> {
  const prompt = [
    "Resolve this calendar read intent.",
    "The user may speak in any language.",
    "Choose exactly one subaction: feed, next_event, search_events, trip_window, or null.",
    "feed means a schedule or agenda view over today, tomorrow, this week, or another time window.",
    "next_event means only the single next upcoming meeting or appointment.",
    "search_events means find calendar events by title, attendee, location, date, or keyword, including flights and appointments.",
    "trip_window means show what is happening while the user is in a place or during a trip/stay in that place.",
    ...CALENDAR_READ_DISAMBIGUATION_RULES,
    "Use null only when the request is not asking for a calendar read lookup.",
    "If you choose trip_window, also return tripLocation when the place is recoverable from the request or recent conversation.",
    "",
    "Examples:",
    "request: What's on my calendar today?",
    "subaction: feed",
    "",
    "request: What's my next meeting?",
    "subaction: next_event",
    "",
    "request: find my return flight",
    "subaction: search_events",
    "",
    "request: 東京にいる間、何がありますか？",
    "subaction: trip_window",
    "tripLocation: 東京",
    "",
    "request: Can you help me with my calendar?",
    "subaction: null",
    "",
    "Return JSON only as a single object with exactly these fields:",
    "  subaction: feed, next_event, search_events, trip_window, or null",
    "  tripLocation: optional string",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current planner candidate:\n${args.candidateSubaction ?? "null"}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_read_intent",
    failureMessage: "Calendar read disambiguation model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarReadResolution(result?.parsed);
}

async function resolveCalendarLookupBoundaryWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarLookupReadSubaction;
}): Promise<CalendarLookupReadSubaction | null> {
  const prompt = [
    "Resolve this calendar lookup intent.",
    "The user may speak in any language.",
    "Choose exactly one subaction: next_event or search_events.",
    "next_event means the user wants only the single nearest upcoming meeting, appointment, or event.",
    "search_events means the user wants to find matching calendar events by title, attendee, place, trip, keyword, or date.",
    CALENDAR_READ_DISAMBIGUATION_RULES[2],
    "If the request contains a specific attendee, title, flight, dentist, place, date constraint, or other lookup key, choose search_events, even when it also names a time window like today, tomorrow, or this week.",
    "",
    "Examples:",
    "request: What's my next meeting?",
    "subaction: next_event",
    "",
    "request: meetings with my colleague this week",
    "subaction: search_events",
    "",
    "request: 帰りの便を探して",
    "subaction: search_events",
    "",
    "Return JSON only as a single object with exactly this field:",
    "  subaction: next_event or search_events",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current candidate:\n${args.candidateSubaction}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_lookup_boundary",
    failureMessage: "Calendar lookup boundary model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarLookupReadSubaction(result?.parsed?.subaction);
}

async function resolveCalendarMutationBoundaryWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  candidateSubaction: CalendarSubaction | null;
}): Promise<CalendarMutationSubaction | null> {
  const prompt = [
    "Resolve whether this calendar request is a mutation.",
    "The user may speak in any language.",
    "Choose exactly one subaction: create_event, update_event, delete_event, or null.",
    "create_event means schedule, add, book, or put a new event on the calendar.",
    "update_event means rename, reschedule, move, or otherwise edit an existing event.",
    "delete_event means delete, cancel, remove, or clear an existing event.",
    "Use null when the request is only reading the calendar, searching events, discussing plans, or asking for general help.",
    "Prefer create_event when the user gives a time/date and asks to add or schedule a meeting or appointment, regardless of language.",
    "",
    "Examples:",
    "request: Schedule a meeting with Alex at 3pm tomorrow",
    "subaction: create_event",
    "",
    "request: Reschedule the dentist to Friday",
    "subaction: update_event",
    "",
    "request: Delete the team meeting tomorrow",
    "subaction: delete_event",
    "",
    "request: 今日の予定は何ですか？",
    "subaction: null",
    "",
    "Return JSON only as a single object with exactly this field:",
    "  subaction: create_event, update_event, delete_event, or null",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${args.recentConversation}`,
    `Current candidate:\n${args.candidateSubaction ?? "null"}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.resolve_mutation_boundary",
    failureMessage: "Calendar mutation boundary model call failed",
    source: "action:calendar",
  });
  return normalizeCalendarMutationSubaction(result?.parsed?.subaction);
}

async function finalizeCalendarPlan(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string;
  plan: CalendarLlmPlan | null;
}): Promise<CalendarLlmPlan> {
  const { runtime, currentMessage, intent, recentConversation, plan } = args;
  if (plan?.shouldAct === false) {
    return plan;
  }
  const safeReadOnlyPlan = isSafeReadOnlyCalendarPlan(
    plan,
    currentMessage,
    intent,
  );
  if (
    !safeReadOnlyPlan &&
    plan?.subaction !== "create_event" &&
    plan?.subaction !== "update_event" &&
    plan?.subaction !== "delete_event"
  ) {
    const mutationSubaction = await resolveCalendarMutationBoundaryWithLlm({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      candidateSubaction: plan?.subaction ?? null,
    });
    if (mutationSubaction) {
      return {
        ...(plan ?? {
          queries: [],
          shouldAct: null,
        }),
        subaction: mutationSubaction,
        shouldAct: true,
        response: undefined,
      };
    }
  }

  if (safeReadOnlyPlan && plan) {
    return plan;
  }

  if (!shouldDisambiguateCalendarReadPlan(plan)) {
    return (
      plan ?? {
        subaction: null,
        queries: [],
        shouldAct: null,
      }
    );
  }

  const resolvedReadPlan = await disambiguateCalendarReadPlanWithLlm({
    runtime,
    currentMessage,
    intent,
    recentConversation,
    candidateSubaction: plan?.subaction ?? null,
  });

  if (resolvedReadPlan === null || resolvedReadPlan.subaction === null) {
    return (
      plan ?? {
        subaction: null,
        queries: [],
        shouldAct: null,
      }
    );
  }

  let finalReadSubaction = resolvedReadPlan.subaction;
  if (
    finalReadSubaction === "next_event" ||
    finalReadSubaction === "search_events"
  ) {
    const boundarySubaction = await resolveCalendarLookupBoundaryWithLlm({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      candidateSubaction: finalReadSubaction,
    });
    if (boundarySubaction) {
      finalReadSubaction = boundarySubaction;
    }
  }

  if (plan) {
    return {
      ...plan,
      subaction: finalReadSubaction,
      tripLocation: resolvedReadPlan.tripLocation ?? plan.tripLocation,
      queries: dedupeCalendarQueries([
        ...plan.queries,
        resolvedReadPlan.tripLocation,
      ]),
      shouldAct: true,
      response: undefined,
    };
  }

  return {
    subaction: finalReadSubaction,
    queries: dedupeCalendarQueries([resolvedReadPlan.tripLocation]),
    shouldAct: true,
    tripLocation: resolvedReadPlan.tripLocation,
  };
}

/**
 * Whether notifying attendees is meaningful for this event at all.
 *
 * The outer planner stamps `notifyAttendees: true` onto ordinary mutations —
 * "cancel my zorblax checkup" arrived with it set, on a solo event with no
 * attendees. The built-in calendar has no mail path and rejects the flag with a
 * 400, so a plain cancel died on a field the user never asked for and the reply
 * claimed the event could not be found (live capture 2026-08-14).
 *
 * Same shape as the recurrenceScope guard beside it: honor the flag only when
 * the resolved target can actually act on it. Notifying nobody is a no-op, not
 * a conflict.
 */
function shouldNotifyAttendees(
  details: Record<string, unknown> | undefined,
  targetEvent: { attendees?: unknown } | undefined,
): boolean {
  if (detailBoolean(details, "notifyAttendees") !== true) return false;
  const attendees = targetEvent?.attendees;
  return Array.isArray(attendees) && attendees.length > 0;
}

function buildCalendarServiceErrorFallback(
  error: CalendarServiceError,
  intent: string,
): string {
  const normalized = normalizeText(error.message);
  if (error.code === "CALENDAR_APPROVAL_GATEWAY_UNAVAILABLE") {
    return "Calendar changes are unavailable because the owner-approval gateway is not running. I did not change the calendar.";
  }
  // A permanent capability boundary, not a transient failure: the built-in
  // calendar has no recurrence engine. The generic copy invited a retry that
  // can only fail again ("couldn't add that weekly standup … try again." —
  // live capture), so name the boundary and the one action that lifts it.
  // Reached only when the event really does have attendees; a spurious flag on
  // a solo event is dropped before the service call (see shouldNotifyAttendees).
  if (error.code === "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED") {
    return "The built-in calendar can't email the other attendees, so I left that one alone. Connect Google Calendar and I'll send the update, or say go ahead without notifying anyone.";
  }
  if (error.code === "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED") {
    return "Repeating events need a connected calendar — the built-in one only holds single events. Connect Google Calendar and I'll set up the recurring one, or I can add a single event now.";
  }
  if (
    error.code === "CALENDAR_MUTATION_CONTEXT_INCOMPLETE" ||
    error.code === "CALENDAR_MUTATION_CONTEXT_UNAVAILABLE"
  ) {
    return "I could not verify a complete, fresh view of every requested calendar source, so I did not queue or make a calendar change.";
  }
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'")
  ) {
    return `I couldn't pin down the event time from "${intent}". Tell me the date and time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("startat is required") ||
    normalized.includes("windowpreset is not provided")
  ) {
    return "I still need the time for that event. Tell me when it should happen.";
  }
  if (normalized.includes("endat must be later than startat")) {
    return "That end time lands before the start. Give me the date and time again and I'll fix it.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "Calendar is rate-limited right now. Try again in a bit.";
  }
  if (
    error.status === 409 &&
    normalized.includes("apple calendar") &&
    (normalized.includes("attendee") ||
      normalized.includes("invitee") ||
      normalized.includes("invited meeting"))
  ) {
    return "Apple Calendar can't create or edit invited meetings from here. Connect Google Calendar for invites, or remove the attendees and I'll create it locally.";
  }
  return "I couldn't finish that calendar change yet. Tell me the event and timing again, and I'll try it a different way.";
}

function isAppleCalendarPermissionError(error: CalendarServiceError): boolean {
  return (
    error.status === 403 &&
    normalizeText(error.message).includes("apple calendar permission")
  );
}

function buildAppleCalendarPermissionRequestText(
  subaction: CalendarSubaction | null,
): string {
  const feature =
    subaction === "create_event"
      ? "lifeops.calendar.create"
      : subaction === "update_event"
        ? "lifeops.calendar.update"
        : subaction === "delete_event"
          ? "lifeops.calendar.delete"
          : "lifeops.calendar.read";
  const reason =
    subaction === "create_event"
      ? "I need Apple Calendar access to add that event."
      : subaction === "update_event"
        ? "I need Apple Calendar access to update that event."
        : subaction === "delete_event"
          ? "I need Apple Calendar access to delete that event."
          : "I need Apple Calendar access to read your schedule.";
  return [
    reason,
    "```json",
    JSON.stringify({
      action: "permission_request",
      reasoning:
        "native Apple Calendar access is required for this LifeOps calendar action",
      permission: "calendar",
      reason,
      feature,
      fallback_offered: false,
    }),
    "```",
  ].join("\n");
}

// titleHint comes from model extraction over the (possibly envelope-wrapped)
// message, so it can be an arbitrary blob — describeUserReference quotes it
// only when name-shaped and falls back to a neutral noun otherwise. Exported
// for regression tests.
export function buildCalendarEventDisambiguationFallback(args: {
  action: "update" | "delete";
  candidates: LifeOpsCalendarEvent[];
  titleHint?: string;
  /**
   * Zone the candidate times are listed in. Each event otherwise renders in its
   * own provider zone, so one question mixed "11am pdt" with "1pm utc" (live
   * capture) and the owner could not tell which appointment was earlier. An
   * all-day event keeps its own zone: its value is a calendar date, and
   * re-reading it elsewhere can shift the day.
   */
  timeZone?: string;
}): string {
  const previewLines = args.candidates.map((candidate) => {
    const when = formatCalendarEventDateTime(candidate, {
      includeTimeZoneName: true,
      ...(args.timeZone && !candidate.isAllDay
        ? { timeZone: args.timeZone }
        : {}),
    });
    return `- ${candidate.title} (${when})`;
  });
  const intro = args.titleHint
    ? `I found multiple events matching ${describeUserReference(args.titleHint, "that event")}.`
    : "I found multiple matching calendar events.";
  return [
    intro,
    ...previewLines,
    `Tell me which one to ${args.action} by giving the title and date/time.`,
  ].join("\n");
}

// Same blob hazard as the disambiguation intro: the hint is model-extracted
// and must never be echoed verbatim when it is not name-shaped. Exported for
// regression tests.
export function buildCalendarEventNotFoundFallback(
  action: "update" | "delete",
  titleHint: string | undefined,
): string {
  return titleHint
    ? `i couldn't find an event matching ${describeUserReference(titleHint, "that event")} in that window.`
    : `i couldn't find any events to ${action} in that window. give me a title or a date.`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function wordCount(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }
  return normalized.split(" ").filter(Boolean).length;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function tokenVariants(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const variants = new Set([normalized]);
  if (normalized.endsWith("ies") && normalized.length > 3) {
    variants.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("es") && normalized.length > 4) {
    variants.add(normalized.slice(0, -2));
  }
  if (
    normalized.endsWith("s") &&
    !normalized.endsWith("ss") &&
    normalized.length > 3
  ) {
    variants.add(normalized.slice(0, -1));
  }
  return [...variants];
}

function tokenizeForSearch(value: string): string[] {
  return [...new Set(tokenize(value).flatMap((token) => tokenVariants(token)))];
}

function normalizeCalendarSearchQueryValue(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (PARAMETER_DOC_NOISE_PATTERN.test(value)) {
    return undefined;
  }

  const cleaned = normalizeText(value)
    .replace(/\b(?:actions?|params?|parameters?)\b[:;]*/g, "")
    .replace(
      /\b\w{1,128}\?:\w{1,128}(?:\s{1,32}\[[^\]]{1,256}\])?\s{0,32}-\s{0,32}/g,
      " ",
    )
    .replace(/\bsupported keys include\b.*$/g, "")
    .replace(/\bmatch against titles\b.*$/g, "")
    .replace(/\bstructured calendar arguments\b.*$/g, "")
    .replace(/[;:,]+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();

  if (
    !cleaned ||
    ["calendar", "schedule", "event", "events"].includes(cleaned) ||
    cleaned.length > 160 ||
    PARAMETER_DOC_NOISE_PATTERN.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function dedupeCalendarQueries(queries: Array<string | undefined>): string[] {
  const normalized = queries
    .map((query) => normalizeCalendarSearchQueryValue(query))
    .filter((query): query is string => Boolean(query));
  return [...new Set(normalized)];
}

function normalizeCalendarDetails(
  details: Record<string, unknown> | undefined,
  paramsTitleCandidates: Array<string | undefined> = [],
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const aliasMap = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CALENDAR_DETAIL_ALIASES)) {
    aliasMap.set(normalizeLookupKey(canonical), canonical);
    for (const alias of aliases) {
      aliasMap.set(normalizeLookupKey(alias), canonical);
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const canonical = aliasMap.get(normalizeLookupKey(key)) ?? key;
    if (
      typeof value === "string" &&
      PLANNER_CONTROL_DETAIL_KEYS.has(canonical)
    ) {
      const trimmed = value.trim();
      if (
        trimmed.toLowerCase() === "unknown" ||
        PLANNER_KEY_FRAGMENT_PATTERN.test(trimmed) ||
        normalizeLookupKey(trimmed) === normalizeLookupKey(canonical)
      ) {
        continue;
      }
    }
    normalized[key] = value;
  }

  for (const [key, value] of Object.entries(normalized)) {
    const canonical = aliasMap.get(normalizeLookupKey(key));
    if (!canonical) {
      continue;
    }
    if (normalized[canonical] === undefined) {
      normalized[canonical] = value;
    }
  }

  // Planner junk screen for external-id fields: the model routinely slugs the
  // event TITLE into every id alias it can see (`eventId`/`googleEventId`/
  // `externalEventId` all = "claim_probe_two" for title "claim probe two").
  // A present eventId routes the operation to the external-connector lookup,
  // which then failed the whole turn with "Google Calendar is not connected"
  // for a locally-stored event (observed live). An id that normalizes to the
  // same key as the title/query in the SAME args is the title, not an id —
  // drop it so title resolution owns the lookup.
  const eventIdValue = normalized.eventId;
  if (typeof eventIdValue === "string" && eventIdValue.trim()) {
    const idKey = normalizeLookupKey(eventIdValue);
    const titleKeys = [
      normalized.title,
      normalized.query,
      normalized.oldTitle,
      ...paramsTitleCandidates,
    ]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => normalizeLookupKey(candidate));
    if (idKey && titleKeys.includes(idKey)) {
      delete normalized.eventId;
    }
  }

  return normalized;
}

/** Blank model placeholders are omissions; clearing is a distinct operation. */
function calendarUpdateTextField(
  details: Record<string, unknown> | undefined,
  extracted: Record<string, unknown>,
  field: "description" | "location",
): string | undefined {
  for (const source of [details, extracted]) {
    const value = detailString(source, field);
    const clear =
      Array.isArray(source?.clearFields) && source.clearFields.includes(field);
    if (clear && value !== undefined) {
      throw new CalendarServiceError(
        400,
        `An event update cannot both replace and clear ${field}.`,
        "CALENDAR_UPDATE_FIELD_CONFLICT",
      );
    }
    if (clear) return "";
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseStateLine(line: string): { role: string; text: string } {
  const trimmed = line.trim();
  const timestampedMatch = trimmed.match(
    /^\d{1,2}:\d{2}\s+\([^)]+\)\s+\[[^\]]+\]\s+(\S+)\s*:\s*(.*)/,
  );
  if (timestampedMatch) {
    const role = timestampedMatch[1];
    const text = timestampedMatch[2];
    if (!role || text === undefined) {
      return { role: "", text: trimmed };
    }
    return {
      role: role.toLowerCase(),
      text: text.trim(),
    };
  }

  const simpleMatch = trimmed.match(
    /^(user|assistant|system|owner|admin|\S+)\s*:\s*(.*)/i,
  );
  if (simpleMatch) {
    const role = simpleMatch[1];
    const text = simpleMatch[2];
    if (!role || text === undefined) {
      return { role: "", text: trimmed };
    }
    return {
      role: role.toLowerCase(),
      text: text.trim(),
    };
  }

  return { role: "", text: trimmed };
}

function planningConversationLines(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;
  const raw =
    typeof values?.recentMessages === "string"
      ? values.recentMessages
      : typeof stateRecord.text === "string"
        ? stateRecord.text
        : "";
  if (!raw) {
    return [];
  }

  return raw
    .split(/\n+/)
    .map((line) => parseStateLine(line))
    .filter((line) => line.role.length > 0 && line.text.length > 0)
    .map((line) => `${line.role}: ${line.text}`);
}

function resolveCalendarIntentInput(
  paramsIntent: string | undefined,
  message: Parameters<typeof messageText>[0],
): string {
  return paramsIntent?.trim() || messageText(message).trim();
}

function resolveStructuredCalendarSubaction(
  params: CalendarActionParams,
  details: Record<string, unknown> | undefined,
): CalendarSubaction | null {
  if (detailString(details, "eventId")) {
    if (
      detailString(details, "newTitle") ||
      detailString(details, "title") ||
      detailString(details, "startAt") ||
      detailString(details, "endAt") ||
      detailString(details, "description") ||
      detailString(details, "location")
    ) {
      return "update_event";
    }
    return "delete_event";
  }

  if (
    createStartDetail(details) ||
    createEndDetail(details) ||
    detailString(details, "windowPreset") ||
    detailNumber(details, "durationMinutes") ||
    params.title ||
    detailString(details, "title")
  ) {
    return "create_event";
  }

  if (
    params.query ||
    detailString(details, "query") ||
    (params.queries?.length ?? 0) > 0 ||
    (detailArray(details, "queries")?.length ?? 0) > 0 ||
    plannerWindowDetail(details)
  ) {
    return "search_events";
  }

  return null;
}

/**
 * Small spelled-out cardinals so everyday/child/elderly phrasing like "in two
 * days" or "a week from today" resolves deterministically, not just digits.
 */
const RELATIVE_NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function relativeCountToNumber(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return RELATIVE_NUMBER_WORDS[token] ?? null;
}

/**
 * Resolve common relative-date phrasing to a day offset from today, or null.
 * Handles "today", "tomorrow", "yesterday", "day after tomorrow",
 * "day before yesterday", "in N days/weeks", and "N days/weeks from now|today"
 * (#8795). These are everyday phrasings the calendar action's own examples use
 * (e.g. "Schedule a meeting with Alex at 3pm tomorrow") that the deterministic
 * resolver previously returned null for, forcing an avoidable LLM round-trip.
 *
 * Multi-word and count patterns are checked before the bare "today"/"tomorrow"
 * words so "3 days from today" is +3, not 0.
 */
function parseRelativeDayOffset(text: string): number | null {
  if (/\bday after tomorrow\b/.test(text)) return 2;
  if (/\bday before yesterday\b/.test(text)) return -2;

  const inMatch = text.match(
    /\bin (\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?)\b/,
  );
  if (inMatch?.[1] && inMatch[2]) {
    const count = relativeCountToNumber(inMatch[1]);
    if (count !== null) {
      return inMatch[2].startsWith("week") ? count * 7 : count;
    }
  }

  const fromNowMatch = text.match(
    /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?) from (?:now|today)\b/,
  );
  if (fromNowMatch?.[1] && fromNowMatch[2]) {
    const count = relativeCountToNumber(fromNowMatch[1]);
    if (count !== null) {
      return fromNowMatch[2].startsWith("week") ? count * 7 : count;
    }
  }

  if (/\btomorrow\b/.test(text)) return 1;
  if (/\byesterday\b/.test(text)) return -1;
  if (/\btoday\b/.test(text)) return 0;
  return null;
}

export function parseExplicitLocalDate(
  value: string,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  const normalized = normalizeText(value);
  const localToday = getZonedDateParts(new Date(), timeZone);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const monthNameMatch = normalized.match(MONTH_NAME_PATTERN);
  if (monthNameMatch) {
    const monthName = monthNameMatch[1];
    if (!monthName) {
      return null;
    }
    const month = MONTH_MAP[normalizeLookupKey(monthName)];
    if (month === undefined) {
      return null;
    }
    return {
      year: monthNameMatch[3] ? Number(monthNameMatch[3]) : localToday.year,
      month,
      day: Number(monthNameMatch[2]),
    };
  }

  const numericMatch = normalized.match(
    /\b(\d{1,2})([/-])(\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const yearRaw = numericMatch[4];
    const parsedYear =
      yearRaw === undefined
        ? localToday.year
        : yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw);
    const month = Number(numericMatch[1]);
    const day = Number(numericMatch[3]);
    // A year-less dash pair alongside a named weekday ("friday 3-5") is a
    // wall-clock time range, not a date — let the weekday branch below win
    // (#21941).
    const yearlessDashTimeRange =
      yearRaw === undefined &&
      numericMatch[2] === "-" &&
      WEEKDAY_NAME_PATTERN.test(normalized);
    // Range-check and round-trip through Date.UTC so impossible dates
    // (month 25, Feb 30) fall through to the later branches instead of
    // rolling over (#21941).
    const dCand = new Date(0);
    dCand.setUTCFullYear(parsedYear, month - 1, day);
    const candidate = dCand;
    const isRealDate =
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31 &&
      candidate.getUTCFullYear() === parsedYear &&
      candidate.getUTCMonth() + 1 === month &&
      candidate.getUTCDate() === day;
    if (isRealDate && !yearlessDashTimeRange) {
      return {
        year: parsedYear,
        month,
        day,
      };
    }
  }

  const weekdayMatch = normalized.match(WEEKDAY_NAME_PATTERN);
  if (weekdayMatch) {
    const qualifier = normalizeLookupKey(weekdayMatch[1] ?? "");
    const weekdayKey = normalizeLookupKey(weekdayMatch[2] ?? "");
    const targetWeekday = WEEKDAY_MAP[weekdayKey];
    if (targetWeekday !== undefined) {
      const dCur = new Date(0);
      dCur.setUTCFullYear(
        localToday.year,
        Math.max(0, localToday.month - 1),
        localToday.day,
      );
      dCur.setUTCHours(12, 0, 0, 0);
      const currentWeekday = dCur.getUTCDay();
      let delta = (targetWeekday - currentWeekday + 7) % 7;
      if (qualifier === "next") {
        delta = delta === 0 ? 7 : delta + 7;
      }
      return addDaysToLocalDate(
        {
          year: localToday.year,
          month: localToday.month,
          day: localToday.day,
        },
        delta,
      );
    }
  }

  // Relative-date phrasing fallback ("tomorrow", "in 2 days", "a week from
  // today", …) — checked after the specific date patterns so e.g. an ISO date
  // still wins (#8795).
  const relativeOffset = parseRelativeDayOffset(normalized);
  if (relativeOffset !== null) {
    return addDaysToLocalDate(
      {
        year: localToday.year,
        month: localToday.month,
        day: localToday.day,
      },
      relativeOffset,
    );
  }

  return null;
}

/**
 * A planner-supplied zone only when it names a real IANA zone (aliases such
 * as "pst" accepted). Planner junk ("user's timezone", "[REDACTED]") resolves
 * to undefined so callers fall back instead of letting CalendarService reject
 * the whole request with a 400.
 */
function plannerRequestedTimeZone(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const requested = detailString(details, "timeZone");
  if (!requested) return undefined;
  const normalized =
    CALENDAR_TIME_ZONE_ALIASES[requested.toLowerCase()] ?? requested;
  return isValidTimeZone(normalized) ? normalized : undefined;
}

function resolveCalendarTimeZone(
  details: Record<string, unknown> | undefined,
  fallbackTimeZone: string = resolveDefaultTimeZone(),
): string {
  return plannerRequestedTimeZone(details) ?? fallbackTimeZone;
}

/**
 * The zone calendar work defaults to when the planner supplies none: the
 * agent's configured `TIMEZONE` (the same setting the runtime clock provider
 * reports as the agent zone), else the host zone. Live 2026-09-05 the host was
 * UTC while the owner and the clock provider were in Pacific time, so "tuesday
 * at 7am" was extracted, stored and rendered in UTC and one intent produced a
 * 7 AM and a 2 PM event.
 */
function configuredCalendarTimeZone(runtime: IAgentRuntime): string | null {
  const configured =
    typeof runtime.getSetting === "function"
      ? runtime.getSetting("TIMEZONE")
      : undefined;
  return typeof configured === "string" &&
    configured.trim().length > 0 &&
    isValidTimeZone(configured.trim())
    ? configured.trim()
    : null;
}

function resolveConfiguredCalendarTimeZone(runtime: IAgentRuntime): string {
  return configuredCalendarTimeZone(runtime) ?? resolveDefaultTimeZone();
}

type LocalDateOnly = Pick<
  ReturnType<typeof getZonedDateParts>,
  "year" | "month" | "day"
>;

function getLocalTodayDate(timeZone: string): LocalDateOnly {
  const localNow = getZonedDateParts(new Date(), timeZone);
  return {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
}

function buildLocalDateRange(
  timeZone: string,
  startDate: LocalDateOnly,
  endDateExclusive: LocalDateOnly,
  options?: {
    startHour?: number;
    startMinute?: number;
    endHour?: number;
    endMinute?: number;
  },
): { timeMin: string; timeMax: string } {
  return {
    timeMin: buildUtcDateFromLocalParts(timeZone, {
      year: startDate.year,
      month: startDate.month,
      day: startDate.day,
      hour: options?.startHour ?? 0,
      minute: options?.startMinute ?? 0,
      second: 0,
    }).toISOString(),
    timeMax: buildUtcDateFromLocalParts(timeZone, {
      year: endDateExclusive.year,
      month: endDateExclusive.month,
      day: endDateExclusive.day,
      hour: options?.endHour ?? 0,
      minute: options?.endMinute ?? 0,
      second: 0,
    }).toISOString(),
  };
}

function buildLocalDayRange(
  timeZone: string,
  startOffsetDays: number,
  endOffsetDaysExclusive: number,
): { timeMin: string; timeMax: string } {
  const localToday = getLocalTodayDate(timeZone);
  return buildLocalDateRange(
    timeZone,
    addDaysToLocalDate(localToday, startOffsetDays),
    addDaysToLocalDate(localToday, endOffsetDaysExclusive),
  );
}

function formatExplicitCalendarDateLabel(args: {
  date: LocalDateOnly;
  timeZone: string;
}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: args.timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(
    buildUtcDateFromLocalParts(args.timeZone, {
      year: args.date.year,
      month: args.date.month,
      day: args.date.day,
      hour: 12,
      minute: 0,
      second: 0,
    }),
  );
}

function resolveExplicitCalendarDateWindow(
  intent: string,
  timeZone: string,
): { timeMin: string; timeMax: string; label: string } | null {
  const explicitDate = parseExplicitLocalDate(intent, timeZone);
  if (!explicitDate) {
    return null;
  }
  return {
    ...buildLocalDateRange(
      timeZone,
      explicitDate,
      addDaysToLocalDate(explicitDate, 1),
    ),
    label: `on ${formatExplicitCalendarDateLabel({
      date: explicitDate,
      timeZone,
    })}`,
  };
}

function compareLocalDates(left: LocalDateOnly, right: LocalDateOnly): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }
  if (left.month !== right.month) {
    return left.month - right.month;
  }
  return left.day - right.day;
}

/**
 * A day word in a mutation request plays one of two roles: it says WHICH event
 * ("cancel my haircut on friday") or, for an update only, WHERE the event is
 * going ("move my haircut to friday 2pm"). Only the first role identifies a
 * target, and English marks the second with a "to" head, so an update's
 * target-scoped text stops at the first such marker. A delete has no
 * destination, so all of its text is target-scoped.
 *
 * Dropping too much only costs a narrowing opportunity (the handler falls back
 * to asking, today's behavior); keeping a destination date would retarget the
 * mutation, so the split is deliberately eager.
 */
const CALENDAR_DESTINATION_CLAUSE_PATTERN = /\bto\b/i;

function resolveTargetScopedText(
  action: "update" | "delete",
  text: string,
): string {
  if (action === "delete") {
    return text;
  }
  const marker = text.search(CALENDAR_DESTINATION_CLAUSE_PATTERN);
  return marker === -1 ? text : text.slice(0, marker);
}

/**
 * The target calendar day in the caller's authority-ordered text, or null when
 * no target date is stated. An update's destination date is never a target.
 *
 * Live symptom: "cancel my haircut on friday" and "change my haircut on
 * saturday to 2pm" both answered "found two haircuts … which one?" even though
 * the user's own words selected exactly one. The mutation branches look events
 * up across a −1y…+5y window whenever the planner emits no timeMin/timeMax, and
 * candidates were then filtered by fuzzy title alone, so the stated day — which
 * the read path already resolves deterministically via
 * `resolveExplicitCalendarDateWindow` — never reached target resolution.
 */
function resolveStatedTargetLocalDate(args: {
  action: "update" | "delete";
  texts: (string | undefined)[];
  timeZone: string;
}): LocalDateOnly | null {
  for (const text of args.texts) {
    if (!text || text.trim().length === 0) {
      continue;
    }
    const scoped = resolveTargetScopedText(args.action, text);
    const parsed = parseExplicitLocalDate(scoped, args.timeZone);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function calendarEventLocalDate(
  event: LifeOpsCalendarEvent,
  timeZone: string,
): LocalDateOnly {
  // An all-day event carries a calendar date rather than an instant (see the
  // all-day occurrence identity in CalendarService), so reading it in another
  // zone can shift it a day; timed events are compared in the requester's zone
  // because that is the frame the user said "friday" in.
  const readZone = (event.isAllDay ? event.timezone : "") || timeZone;
  const parts = getZonedDateParts(new Date(event.startAt), readZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Planner title hints are often richer than the stored title: the model folds
 * the date and time it was given into `query` ("Gym session September 8 2026
 * 7:00" for "Gym session"), so requiring the title to contain the hint reported
 * an existing event as not found. Match a complete normalized phrase in either
 * direction, preserving word order and every character, including one-letter
 * identifiers. Search-ranking tokenization is deliberately too lossy here.
 */
export function calendarTitleMatchesHint(title: string, hint: string): boolean {
  const normalizedTitle = normalizeText(title);
  const normalizedHint = normalizeText(hint);
  if (!normalizedTitle || !normalizedHint) {
    return false;
  }
  return (
    ` ${normalizedTitle} `.includes(` ${normalizedHint} `) ||
    ` ${normalizedHint} `.includes(` ${normalizedTitle} `)
  );
}

/**
 * Update/delete target lookup must honor both title identity and the stated
 * target day, even when only one title matches. A date mismatch is not
 * permission to mutate a different day's event. Destination-only dates on an
 * update never identify its target, including when echoed into the query.
 */
export function resolveCalendarMutationCandidates(args: {
  action: "update" | "delete";
  events: LifeOpsCalendarEvent[];
  titleHint: string | undefined;
  texts: (string | undefined)[];
  timeZone: string;
  /** Model-authored `details.date`, so a contradiction only it causes can be told apart from one the user stated. */
  explicitDate?: string;
  /** Target text with the planner's date field excluded by provenance. */
  nonPlannerDateTexts?: (string | undefined)[];
}): LifeOpsCalendarEvent[] {
  const titleHint = args.titleHint;
  const byTitle = titleHint
    ? args.events.filter((event) =>
        calendarTitleMatchesHint(event.title, titleHint),
      )
    : args.events;
  if (byTitle.length === 0) {
    return byTitle;
  }
  const hasDestinationClause = args.texts.some(
    (text) => text && resolveTargetScopedText(args.action, text) !== text,
  );
  const statedDate = resolveStatedTargetLocalDate({
    action: args.action,
    texts: args.texts,
    timeZone: args.timeZone,
  });
  const queryDate =
    !statedDate && titleHint
      ? parseExplicitLocalDate(titleHint, args.timeZone)
      : null;
  // User target dates outrank the query. A destination-bearing update does
  // not establish whether a query date identifies the source or destination:
  // never use it to choose among several events, nor ignore a contradiction
  // with the only matching event. Let the existing no-match/ambiguity paths
  // ask the model to clarify instead of risking a different day's mutation.
  const constrainedDate =
    statedDate ??
    (hasDestinationClause && byTitle.length > 1 ? null : queryDate);
  if (!constrainedDate) {
    return byTitle;
  }
  const onDate = byTitle.filter(
    (event) =>
      compareLocalDates(
        calendarEventLocalDate(event, args.timeZone),
        constrainedDate,
      ) === 0,
  );
  if (
    onDate.length === 0 &&
    byTitle.length === 1 &&
    titleHint?.trim() &&
    args.explicitDate &&
    args.nonPlannerDateTexts
  ) {
    // The only date came from the planner's `details.date` and it contradicts
    // the single event carrying the requested title. The user's own words name
    // no day, so the title identifies the target and the detail was a
    // mis-resolved weekday. A day the user
    // stated, or several title matches, still take the strict paths above.
    const userStatedDate = resolveStatedTargetLocalDate({
      action: args.action,
      texts: args.nonPlannerDateTexts,
      timeZone: args.timeZone,
    });
    if (!userStatedDate) return byTitle;
  }
  return onDate;
}

function resolveCreateEventCalendarTimeZone(
  details: Record<string, unknown> | undefined,
  feed: LifeOpsCalendarFeed | null | undefined,
  fallbackTimeZone: string,
  configuredTimeZone: string | null = null,
): string {
  const explicitTimeZone = plannerRequestedTimeZone(details);
  if (explicitTimeZone) {
    return explicitTimeZone;
  }
  // The agent's configured zone is the owner's zone and outranks the
  // event-majority vote below. Live 2026-09-05 the built-in calendar held
  // only UTC-stamped events from earlier host-zone creates, so the vote kept
  // re-electing UTC for every new event even after TIMEZONE was configured.
  if (configuredTimeZone) {
    return configuredTimeZone;
  }

  const counts = new Map<string, number>();
  for (const event of feed?.events ?? []) {
    const eventTimeZone =
      typeof event.timezone === "string" ? event.timezone.trim() : "";
    if (!eventTimeZone) {
      continue;
    }
    counts.set(eventTimeZone, (counts.get(eventTimeZone) ?? 0) + 1);
  }

  let winner = fallbackTimeZone;
  let winnerCount = 0;
  for (const [timeZone, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = timeZone;
      winnerCount = count;
    }
  }
  return winner;
}

function formatCreateEventCalendarContext(
  context: CreateEventCalendarContext | null,
): string {
  if (!context) {
    return "(calendar context unavailable)";
  }

  const lines = [
    `Calendar timezone: ${context.calendarTimeZone}`,
    `Context window: ${context.feed.timeMin} to ${context.feed.timeMax}`,
  ];

  if (context.feed.events.length === 0) {
    lines.push("(no upcoming events in the next 2 weeks)");
    return lines.join("\n");
  }

  for (const event of context.feed.events) {
    const when = event.isAllDay
      ? formatCalendarMoment(event)
      : formatCalendarEventDateTime(event, {
          includeTimeZoneName: true,
          includeYear: true,
        });
    lines.push(
      `- ${when} — ${event.title}${event.location ? ` @ ${event.location}` : ""}`,
    );
  }
  return lines.join("\n");
}

// Fallback default duration when neither the user nor the LLM supplies one.
// Specialization (personal vs work vs prep) is now handled by the LLM during
// inferCreateEventDetails — never by English keyword regex.
function resolveSuggestedCreateEventDurationMinutes(): number {
  return 60;
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function overlapsBusyWindow(
  startMinute: number,
  durationMinutes: number,
  busyWindows: Array<{ startMinute: number; endMinute: number }>,
): boolean {
  const endMinute = startMinute + durationMinutes;
  return busyWindows.some(
    (window) =>
      startMinute < window.endMinute && endMinute > window.startMinute,
  );
}

function busyWindowsForLocalDate(
  events: LifeOpsCalendarEvent[],
  targetDate: LocalDateOnly,
  timeZone: string,
): Array<{ startMinute: number; endMinute: number }> {
  const windows: Array<{ startMinute: number; endMinute: number }> = [];

  for (const event of events) {
    if (event.isAllDay) {
      continue;
    }
    const start = getZonedDateParts(new Date(event.startAt), timeZone);
    const end = getZonedDateParts(new Date(event.endAt), timeZone);
    const startDate = { year: start.year, month: start.month, day: start.day };
    const endDate = { year: end.year, month: end.month, day: end.day };

    if (
      compareLocalDates(endDate, targetDate) < 0 ||
      compareLocalDates(startDate, targetDate) > 0
    ) {
      continue;
    }

    const startMinute =
      compareLocalDates(startDate, targetDate) < 0
        ? 0
        : start.hour * 60 + start.minute;
    const endMinute =
      compareLocalDates(endDate, targetDate) > 0
        ? 24 * 60
        : Math.max(startMinute + 1, end.hour * 60 + end.minute);

    windows.push({ startMinute, endMinute });
  }

  return windows.sort((left, right) => left.startMinute - right.startMinute);
}

// Preferred slot ordering for tentative event scheduling. Locale-agnostic:
// weekdays prefer mid-morning through evening, weekends prefer late morning
// and afternoon. Specific category preferences (personal vs work) are now
// supplied by the LLM via inferCreateEventDetails — not by English regex.
function resolvePreferredCreateEventMinutes(
  targetDate: LocalDateOnly,
): number[] {
  const weekday = getWeekdayForLocalDate(targetDate);
  return weekday === 0 || weekday === 6
    ? [10 * 60, 13 * 60, 18 * 60]
    : [9 * 60, 11 * 60, 14 * 60, 16 * 60, 19 * 60];
}

function chooseSuggestedCreateEventMinute(args: {
  busyWindows: Array<{ startMinute: number; endMinute: number }>;
  preferredMinutes: number[];
  durationMinutes: number;
}): number | null {
  for (const minute of args.preferredMinutes) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  const latestEnd = Math.max(
    0,
    ...args.busyWindows.map((window) => window.endMinute),
  );
  const afterLastEvent = roundUpToStep(latestEnd + 15, 15);
  if (
    afterLastEvent + args.durationMinutes <= 22 * 60 &&
    !overlapsBusyWindow(afterLastEvent, args.durationMinutes, args.busyWindows)
  ) {
    return afterLastEvent;
  }

  for (let minute = 8 * 60; minute <= 21 * 60; minute += 30) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  return null;
}

/**
 * The calendar day the user themselves named for a NEW event outranks the
 * planner's date arithmetic. Live symptom: "put coffee with dana on my
 * calendar sunday at 10am", asked on a Saturday, arrived with a startAt on
 * Monday — the model's weekday math slipped while the user's own word did
 * not. When the message (or intent) parses to an explicit local date and the
 * resolved start lands on a different local day, shift start and end onto the
 * stated day, preserving wall-clock time and duration. No stated date, or a
 * matching one, changes nothing — a correct planner is a no-op here.
 */
/**
 * The schema advertises `start`/`end` beside `startAt`/`endAt` (live 2026-09-05
 * the planner used `start`); every create read accepts both spellings so a
 * valid planner time is executed instead of re-extracted from prose.
 */
const OFFSET_OR_UTC_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Wall-clock `YYYY-MM-DDTHH:mm:ss` of `date` in `timeZone`. */
function formatLocalDateTimeInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}:${read("second")}`;
}

/**
 * Absolute instant of a planner datetime. Strings carrying `Z` or an offset
 * are absolute already; a bare local datetime is read in `timeZone` (one
 * correction pass handles the zone's offset at that wall-clock time).
 */
function parseDateTimeInZone(value: string, timeZone: string): Date | null {
  const trimmed = value.trim();
  if (OFFSET_OR_UTC_SUFFIX_PATTERN.test(trimmed)) {
    const absolute = new Date(trimmed);
    return Number.isFinite(absolute.getTime()) ? absolute : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      trimmed,
    );
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
  );
  let guess = new Date(asUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    const local = formatLocalDateTimeInZone(guess, timeZone);
    const localAsUtc = Date.parse(`${local}Z`);
    if (!Number.isFinite(localAsUtc)) return null;
    const drift = localAsUtc - asUtc;
    if (drift === 0) break;
    guess = new Date(guess.getTime() - drift);
  }
  return Number.isFinite(guess.getTime()) ? guess : null;
}

/**
 * Time range for an update. A new start without a new end keeps the event's
 * current duration (live 2026-09-10: "move my dentist appointment to friday at
 * 4pm" arrived as `start` only, the stored 3–4 pm event kept its 4 pm end, and
 * the service rejected the zero-length range). The derived end is spelled like
 * the start it follows: absolute for `Z`/offset starts, wall-clock in
 * `timeZone` otherwise. Every other combination passes through unchanged and
 * the service keeps validating end-after-start.
 */
export function resolveUpdateTimeRange(args: {
  explicitStart?: string;
  explicitEnd?: string;
  extractedStart?: string;
  extractedEnd?: string;
  target: { startAt: string; endAt: string };
  timeZone?: string;
}): { startAt?: string; endAt?: string } {
  const startAt = args.explicitStart ?? args.extractedStart;
  const endAt = args.explicitEnd ?? args.extractedEnd;
  if (!startAt || endAt) return { startAt, endAt };
  const durationMs =
    Date.parse(args.target.endAt) - Date.parse(args.target.startAt);
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    return { startAt, endAt };
  const timeZone = args.timeZone?.trim() || "UTC";
  const start = parseDateTimeInZone(startAt, timeZone);
  if (!start) return { startAt, endAt };
  const end = new Date(start.getTime() + durationMs);
  return {
    startAt,
    endAt: OFFSET_OR_UTC_SUFFIX_PATTERN.test(startAt.trim())
      ? end.toISOString()
      : formatLocalDateTimeInZone(end, timeZone),
  };
}

function createStartDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  return detailString(details, "startAt") ?? detailString(details, "start");
}

function createEndDetail(
  details: Record<string, unknown> | undefined,
): string | undefined {
  return detailString(details, "endAt") ?? detailString(details, "end");
}

const DATE_SEGMENT_SPLIT_PATTERN =
  /\s*(?:,|;|\band\b|\bthen\b|\bplus\b|\balso\b|\bas well as\b)\s*/i;

function distinctStatedLocalDates(
  text: string,
  timeZone: string,
): LocalDateOnly[] {
  const dates: LocalDateOnly[] = [];
  for (const segment of text.split(DATE_SEGMENT_SPLIT_PATTERN)) {
    if (segment.trim().length === 0) continue;
    const parsed = parseExplicitLocalDate(segment, timeZone);
    if (parsed && !dates.some((d) => compareLocalDates(d, parsed) === 0)) {
      dates.push(parsed);
    }
  }
  return dates;
}

/**
 * The date the user stated for THIS create. The message is authoritative when
 * it names one date; when it names several (one message, several events —
 * live 2026-09-05 "pottery class saturday … and a haircut sunday" put the
 * haircut on Saturday), the planner's per-event intent decides which one this
 * create is for.
 */
function resolveStatedCreateDate(args: {
  currentMessage: string;
  intent: string;
  timeZone: string;
}): LocalDateOnly | null {
  const messageDates = distinctStatedLocalDates(
    args.currentMessage,
    args.timeZone,
  );
  const intentDate = parseExplicitLocalDate(args.intent, args.timeZone);
  if (messageDates.length >= 2) {
    return intentDate ?? messageDates[0] ?? null;
  }
  return messageDates[0] ?? intentDate;
}

/**
 * Texts consulted, in order, for the stated day of an update/delete target.
 * Single-day message: the user's words first, then the planner's per-target
 * intent, then the planner's `date` detail — planner weekday arithmetic is not
 * trusted over the user's words (live 23:33: "sunday" arrived as the 7th).
 * Message naming several days (one message, several targets — live 22:44
 * "the yoga class on thursday, the pottery class on saturday and the haircut
 * on sunday" constrained every target to Thursday): the per-target intent
 * first, then the planner's `date` detail (its only per-target narrowing when
 * it sent no intent — live 00:16 the dentist on Friday was missed because the
 * message's first day, Thursday, was applied), then the message. An intent
 * that merely echoes the whole message carries no per-target information and
 * is skipped.
 */
function mutationTargetTexts(args: {
  details: Record<string, unknown> | undefined;
  currentMessage: string;
  intent: string;
  timeZone: string;
  excludePlannerDate?: boolean;
}): (string | undefined)[] {
  const explicitDate = args.excludePlannerDate
    ? undefined
    : detailString(args.details, "date");
  const message = args.currentMessage.trim();
  const intent =
    args.intent.trim() && args.intent.trim() !== message
      ? args.intent.trim()
      : undefined;
  const messageNamesSeveralDays =
    distinctStatedLocalDates(message, args.timeZone).length >= 2;
  return messageNamesSeveralDays
    ? [intent, explicitDate, message]
    : [message, intent, explicitDate];
}

const PAST_START_GRACE_MS = 5 * 60 * 1000;
const EXPLICIT_DATE_TOKEN_PATTERN =
  /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/;

function namesBareWeekday(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    WEEKDAY_NAME_PATTERN.test(normalized) &&
    !EXPLICIT_DATE_TOKEN_PATTERN.test(normalized) &&
    !MONTH_NAME_PATTERN.test(normalized)
  );
}

/**
 * A create whose start has already passed is not executed silently and is not
 * reinterpreted: "saturday at 10am" said on Saturday afternoon (live
 * 2026-09-05) most likely means next Saturday, but only the user can say so.
 * The action pauses with the facts and, when the user named a bare weekday,
 * the same wall-clock time one week later as the suggestion. The planner may
 * set `allowPast` when the user explicitly wants a past time recorded.
 */
function resolvePastStartClarification(args: {
  request: CreateLifeOpsCalendarEventRequest;
  details: Record<string, unknown> | undefined;
  title: string;
  currentMessage: string;
  intent: string;
  timeZone: string;
  now: Date;
}): { facts: string; suggestedStartAt?: string } | null {
  if (detailBoolean(args.details, "allowPast") === true) return null;
  if (args.request.allDay || !args.request.startAt) return null;
  const startMs = Date.parse(args.request.startAt);
  if (
    !Number.isFinite(startMs) ||
    startMs >= args.now.getTime() - PAST_START_GRACE_MS
  ) {
    return null;
  }
  const startText = formatCalendarEventDateTime(
    { startAt: args.request.startAt, timezone: args.timeZone },
    { includeTimeZoneName: true },
  );
  if (
    !namesBareWeekday(args.intent) &&
    !namesBareWeekday(args.currentMessage)
  ) {
    return {
      facts: `“${args.title}” at ${startText} has already passed, so nothing was created. Ask which date the user wants.`,
    };
  }
  const parts = getZonedDateParts(new Date(startMs), args.timeZone);
  const nextWeek = addDaysToLocalDate(
    { year: parts.year, month: parts.month, day: parts.day },
    7,
  );
  const suggestedStartAt = buildUtcDateFromLocalParts(args.timeZone, {
    year: nextWeek.year,
    month: nextWeek.month,
    day: nextWeek.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }).toISOString();
  const suggestedText = formatCalendarEventDateTime(
    { startAt: suggestedStartAt, timezone: args.timeZone },
    { includeTimeZoneName: true },
  );
  return {
    facts: `“${args.title}” at ${startText} has already passed, so nothing was created. The same time next week is ${suggestedText}; ask whether to schedule it then or on another date.`,
    suggestedStartAt,
  };
}

function applyStatedDateToCreateRequest(args: {
  request: CreateLifeOpsCalendarEventRequest;
  currentMessage: string;
  intent: string;
  timeZone: string;
}): { corrected: boolean; fromLocalDate?: string; toLocalDate?: string } {
  const startAtIso = args.request.startAt;
  if (!startAtIso) {
    return { corrected: false };
  }
  const startDate = new Date(startAtIso);
  if (Number.isNaN(startDate.getTime())) {
    return { corrected: false };
  }
  const stated = resolveStatedCreateDate({
    currentMessage: args.currentMessage,
    intent: args.intent,
    timeZone: args.timeZone,
  });
  if (!stated) {
    return { corrected: false };
  }
  const startParts = getZonedDateParts(startDate, args.timeZone);
  if (
    startParts.year === stated.year &&
    startParts.month === stated.month &&
    startParts.day === stated.day
  ) {
    return { corrected: false };
  }
  const shifted = buildUtcDateFromLocalParts(args.timeZone, {
    year: stated.year,
    month: stated.month,
    day: stated.day,
    hour: startParts.hour,
    minute: startParts.minute,
    second: startParts.second,
  });
  const deltaMs = shifted.getTime() - startDate.getTime();
  args.request.startAt = shifted.toISOString();
  if (typeof args.request.endAt === "string") {
    const endDate = new Date(args.request.endAt);
    if (!Number.isNaN(endDate.getTime())) {
      args.request.endAt = new Date(endDate.getTime() + deltaMs).toISOString();
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    corrected: true,
    fromLocalDate: `${startParts.year}-${pad(startParts.month)}-${pad(startParts.day)}`,
    toLocalDate: `${stated.year}-${pad(stated.month)}-${pad(stated.day)}`,
  };
}

/**
 * Pin the create zone on the request and express every planner timestamp as
 * an instant in that zone: offset-less values are the owner's wall time,
 * values with a "Z" or numeric offset already name an instant. The service
 * stores this zone on the event, so later reads render in it too. Bound
 * validation (end after start) stays with the service so the planner receives
 * structured guidance instead of an invented duration.
 */
function anchorCreateRequestToTimeZone(
  request: CreateLifeOpsCalendarEventRequest,
  timeZone: string,
): void {
  request.timeZone = timeZone;
  if (request.startAt) {
    request.startAt = normalizeCalendarDateTimeInTimeZone(
      request.startAt,
      "startAt",
      timeZone,
    );
  }
  if (request.endAt) {
    request.endAt = normalizeCalendarDateTimeInTimeZone(
      request.endAt,
      "endAt",
      timeZone,
    );
  }
}

function suggestCreateEventStartAt(args: {
  currentMessage: string;
  intent: string;
  title: string;
  calendarContext: CreateEventCalendarContext | null;
}): { startAt: string; timeZone: string } | null {
  if (!args.calendarContext) {
    return null;
  }

  const targetDate = resolveStatedCreateDate({
    currentMessage: args.currentMessage,
    intent: args.intent,
    timeZone: args.calendarContext.calendarTimeZone,
  });
  if (!targetDate) {
    return null;
  }

  const durationMinutes = resolveSuggestedCreateEventDurationMinutes();
  const busyWindows = busyWindowsForLocalDate(
    args.calendarContext.feed.events,
    targetDate,
    args.calendarContext.calendarTimeZone,
  );
  const startMinute = chooseSuggestedCreateEventMinute({
    busyWindows,
    preferredMinutes: resolvePreferredCreateEventMinutes(targetDate),
    durationMinutes,
  });
  if (startMinute === null) {
    return null;
  }

  return {
    startAt: buildUtcDateFromLocalParts(args.calendarContext.calendarTimeZone, {
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
      second: 0,
    }).toISOString(),
    timeZone: args.calendarContext.calendarTimeZone,
  };
}

async function loadCreateEventCalendarContext(
  service: CalendarService,
  details: Record<string, unknown> | undefined,
  hasCalendarRead: boolean,
  fallbackTimeZone: string = resolveDefaultTimeZone(),
  configuredTimeZone: string | null = null,
): Promise<CreateEventCalendarContext | null> {
  if (!hasCalendarRead) {
    return null;
  }

  const requestTimeZone = resolveCalendarTimeZone(details, fallbackTimeZone);
  const feed = await service.getCalendarFeed(INTERNAL_URL, {
    includeHiddenCalendars: true,
    mode: connectorModeDetail(details),
    side: connectorSideDetail(details),
    grantId: connectorGrantIdDetail(details),
    calendarId: calendarIdDetail(details),
    timeZone: requestTimeZone,
    forceSync: true,
    ...buildLocalDayRange(requestTimeZone, 0, 14),
  });

  if (!feed || !Array.isArray(feed.events)) {
    return null;
  }

  return {
    calendarTimeZone: resolveCreateEventCalendarTimeZone(
      details,
      feed,
      requestTimeZone,
      configuredTimeZone,
    ),
    feed,
  };
}

function normalizeIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeWindowLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : undefined;
}

function utcDateOnly(value: Date): LocalDateOnly {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function isUtcStartOfDay(value: Date): boolean {
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

function isUtcEndOfDay(value: Date): boolean {
  return (
    value.getUTCHours() === 23 &&
    value.getUTCMinutes() === 59 &&
    value.getUTCSeconds() === 59
  );
}

function resolveCalendarLlmLocalDateWindow(
  timeMin: string,
  timeMax: string,
  timeZone: string,
): { timeMin: string; timeMax: string } | null {
  const start = new Date(timeMin);
  const end = new Date(timeMax);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  if (!isUtcStartOfDay(start)) {
    return null;
  }

  const startDate = utcDateOnly(start);
  const endExclusiveDate = isUtcStartOfDay(end)
    ? utcDateOnly(end)
    : isUtcEndOfDay(end)
      ? addDaysToLocalDate(utcDateOnly(end), 1)
      : null;
  if (!endExclusiveDate) {
    return null;
  }
  if (compareLocalDates(endExclusiveDate, startDate) <= 0) {
    return null;
  }
  return buildLocalDateRange(timeZone, startDate, endExclusiveDate);
}

function resolveCalendarLlmWindow(
  timeZone: string,
  llmPlan: CalendarLlmPlan | undefined,
): { timeMin: string; timeMax: string; label: string } | null {
  const window = normalizePlannerCalendarWindow(
    llmPlan?.timeMin,
    llmPlan?.timeMax,
  );
  if (!window) {
    return null;
  }
  const { timeMin, timeMax } = window;

  const minMs = Date.parse(timeMin);
  const maxMs = Date.parse(timeMax);
  const spanMs = maxMs - minMs;
  if (
    !Number.isFinite(spanMs) ||
    spanMs <= 0 ||
    spanMs > 370 * 24 * 60 * 60 * 1000
  ) {
    return null;
  }

  return {
    ...(resolveCalendarLlmLocalDateWindow(timeMin, timeMax, timeZone) ?? {
      timeMin,
      timeMax,
    }),
    label:
      normalizeWindowLabel(llmPlan?.windowLabel) ?? "for the requested window",
  };
}

// Wide window used by update_event / delete_event lookups when the user
// gave no time hint. Reaches 1 year back and 5 years forward — far enough
// to find an upcoming birthday or a recent past meeting without scanning the
// entire account.
function buildWideLookupRange(timeZone: string): {
  timeMin: string;
  timeMax: string;
} {
  return buildLocalDayRange(timeZone, -365, 365 * 5);
}

function resolveCalendarWindow(
  intent: string,
  details: Record<string, unknown> | undefined,
  forSearch: boolean,
  llmPlan?: CalendarLlmPlan,
  fallbackTimeZone: string = resolveDefaultTimeZone(),
): {
  request: GetLifeOpsCalendarFeedRequest;
  label: string;
  explicitWindow: boolean;
} {
  const plannerWindow = plannerWindowDetail(details);
  const calendarId = calendarIdDetail(details);
  const timeZone = resolveCalendarTimeZone(details, fallbackTimeZone);
  const forceSync = detailBoolean(details, "forceSync");
  if (plannerWindow) {
    return {
      request: {
        calendarId,
        ...plannerWindow,
        timeZone,
        forceSync,
      },
      label: detailString(details, "label") ?? "for the requested window",
      explicitWindow: true,
    };
  }

  const llmWindow = resolveCalendarLlmWindow(timeZone, llmPlan);
  if (llmWindow) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: llmWindow.timeMin,
        timeMax: llmWindow.timeMax,
      },
      label: llmWindow.label,
      explicitWindow: true,
    };
  }

  const explicitDateWindow = resolveExplicitCalendarDateWindow(
    intent,
    timeZone,
  );
  if (explicitDateWindow) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: explicitDateWindow.timeMin,
        timeMax: explicitDateWindow.timeMax,
      },
      label: explicitDateWindow.label,
      explicitWindow: true,
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  if (forSearch) {
    const days = windowDays && windowDays > 0 ? Math.min(windowDays, 90) : 30;
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 0, days),
      },
      label: `across the next ${days} days`,
      explicitWindow: false,
    };
  }

  return {
    request: {
      calendarId,
      timeZone,
      forceSync,
      ...buildLocalDayRange(timeZone, 0, 1),
    },
    label: "today",
    explicitWindow: false,
  };
}

function resolveTripWindowRequest(
  details: Record<string, unknown> | undefined,
  llmPlan?: CalendarLlmPlan,
  fallbackTimeZone: string = resolveDefaultTimeZone(),
): GetLifeOpsCalendarFeedRequest {
  const plannerWindow = plannerWindowDetail(details);
  const calendarId = calendarIdDetail(details);
  const timeZone = resolveCalendarTimeZone(details, fallbackTimeZone);
  const forceSync = detailBoolean(details, "forceSync");

  if (plannerWindow) {
    return {
      calendarId,
      ...plannerWindow,
      timeZone,
      forceSync,
    };
  }

  const llmWindow = resolveCalendarLlmWindow(timeZone, llmPlan);
  if (llmWindow) {
    return {
      calendarId,
      timeZone,
      forceSync,
      timeMin: llmWindow.timeMin,
      timeMax: llmWindow.timeMax,
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  const days = windowDays && windowDays > 0 ? Math.min(windowDays, 120) : 60;
  return {
    calendarId,
    timeZone,
    forceSync,
    ...buildLocalDayRange(timeZone, 0, days),
  };
}

function eventDateSearchTerms(event: LifeOpsCalendarEvent): Set<string> {
  const formatter = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      ...options,
    }).format(new Date(event.startAt));

  const monthLong = normalizeText(
    formatter({ month: "long" }).replace(/\./g, ""),
  );
  const monthShort = normalizeText(
    formatter({ month: "short" }).replace(/\./g, ""),
  );
  const weekdayLong = normalizeText(formatter({ weekday: "long" }));
  const weekdayShort = normalizeText(formatter({ weekday: "short" }));
  const day = formatter({ day: "numeric" });
  const dayPadded = day.padStart(2, "0");
  const monthNumeric = formatter({ month: "numeric" });
  const monthPadded = monthNumeric.padStart(2, "0");
  const year = formatter({ year: "numeric" });

  return new Set(
    [
      `${monthLong} ${day}`,
      `${monthLong} ${day} ${year}`,
      `${monthShort} ${day}`,
      `${monthShort} ${day} ${year}`,
      `${weekdayLong} ${monthLong} ${day}`,
      `${weekdayShort} ${monthShort} ${day}`,
      `${monthNumeric}/${day}`,
      `${monthNumeric}/${dayPadded}`,
      `${monthPadded}/${day}`,
      `${monthPadded}/${dayPadded}`,
      `${year}-${monthPadded}-${dayPadded}`,
      weekdayLong,
      weekdayShort,
    ].map((term) => normalizeText(term)),
  );
}

function formatCalendarLocalDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function buildCalendarLocalDateAnchors(now: Date, timeZone: string): string {
  const localDateParts = getZonedDateParts(now, timeZone);
  const localDate = {
    year: localDateParts.year,
    month: localDateParts.month,
    day: localDateParts.day,
  };
  return [
    `yesterday = ${formatCalendarLocalDate(addDaysToLocalDate(localDate, -1))}`,
    `today = ${formatCalendarLocalDate(localDate)}`,
    `tomorrow = ${formatCalendarLocalDate(addDaysToLocalDate(localDate, 1))}`,
  ].join(", ");
}

export async function extractCalendarPlanWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  timeZone = resolveDefaultTimeZone(),
): Promise<CalendarLlmPlan> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const localNow = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const localDateAnchors = buildCalendarLocalDateAnchors(now, timeZone);
  const instructions = resolveOptimizedPromptForRuntime(
    runtime,
    "calendar_extract",
    CALENDAR_PLAN_INSTRUCTIONS,
  );
  const prompt = [
    instructions,
    "",
    `Current timezone: ${timeZone}`,
    `LOCAL DATE ANCHORS (authoritative — IGNORE UTC day for date arithmetic): ${localDateAnchors}.`,
    `Current local datetime: ${localNow}`,
    `Current ISO datetime (informational only — do NOT use for 'today/tomorrow/yesterday'): ${nowIso}`,
    "When the user says 'today', 'tomorrow', 'yesterday', or similar, resolve the calendar day from the LOCAL DATE ANCHORS above (not from the UTC datetime) and build timeMin/timeMax as a full local-day window in the current timezone.",
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  const parseResponse = (raw: string): CalendarLlmPlan | null => {
    const parsed = parseCalendarJsonRecord<Record<string, unknown>>(raw);
    return parsed ? buildCalendarPlanFromParsed(parsed) : null;
  };

  const plannerResult = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.plan",
    purpose: "calendar_extract",
    failureMessage: "Calendar action planning model call failed",
    source: "action:calendar",
  });
  if (!plannerResult) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  const parsedPlan = plannerResult.parsed
    ? buildCalendarPlanFromParsed(plannerResult.parsed)
    : null;
  if (parsedPlan) {
    return finalizeCalendarPlan({
      runtime,
      currentMessage,
      intent,
      recentConversation,
      plan: parsedPlan,
    });
  }

  const repairResult = await runLifeOpsTextModel({
    runtime,
    prompt: buildCalendarPlanRepairPrompt({
      currentMessage,
      intent,
      recentConversation,
      rawResponse: plannerResult.rawResponse,
      timeZone,
      nowIso,
      localNow,
    }),
    actionType: "lifeops.calendar.plan_repair",
    purpose: "calendar_extract",
    failureMessage: "Calendar action repair model call failed",
    source: "action:calendar",
  });
  if (repairResult === null) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }
  return finalizeCalendarPlan({
    runtime,
    currentMessage,
    intent,
    recentConversation,
    plan: parseResponse(repairResult),
  });
}

function resolveCalendarSearchQueries(args: {
  explicitQueries: Array<string | undefined>;
  llmPlan?: CalendarLlmPlan;
  fallbackQueries?: Array<string | undefined>;
}): string[] {
  return dedupeCalendarQueries([
    ...args.explicitQueries,
    ...(args.llmPlan?.queries ?? []),
    ...(args.fallbackQueries ?? []),
  ]);
}

async function inferCalendarSearchQueriesWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  llmPlan?: CalendarLlmPlan;
}): Promise<string[]> {
  const currentMessage = messageText(args.message).trim();
  const recentConversation = formatCreateEventRecentConversation(args.state);
  const prompt = [
    "Extract up to 3 short calendar search queries for a calendar lookup request.",
    "The user may speak in any language.",
    "Return JSON only as a single object with exactly this field:",
    "  queries: array of up to 3 short strings",
    "Prefer noun phrases and exact dates that would help match calendar event titles, descriptions, locations, attendees, or travel itineraries.",
    "When the request is about a flight or travel itinerary, include the travel phrase and destination if present.",
    "When the request asks what event is on a specific date, include the date itself as a query, for example april 19 or 2026-04-19.",
    "If nothing usable can be extracted, return an empty array.",
    "",
    'Example: {"queries":["flight to denver","denver"]}',
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Current planner output:\n${formatCalendarPromptValue(args.llmPlan ?? null)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "lifeops.calendar.extract_search_queries",
    failureMessage: "Calendar search-query extraction model call failed",
    source: "action:calendar",
  });
  const parsed = result?.parsed;
  if (!parsed) {
    return [];
  }

  const rawQueries: string[] = [];
  if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") {
        rawQueries.push(value);
      }
    }
  } else if (
    typeof parsed.queries === "string" &&
    parsed.queries.trim().length > 0
  ) {
    rawQueries.push(...parsed.queries.split(/\s{0,256}\|\|\s{0,256}/));
  }

  return dedupeCalendarQueries(rawQueries);
}

function normalizeIsShortPreparationFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

function resolveCreateEventDurationMinutes(args: {
  explicitDuration: number | undefined;
  extractedDuration: number | undefined;
  isShortPreparation: boolean;
  hasExplicitEndAt: boolean;
  hasExplicitWindowPreset: boolean;
  hasExplicitStartAt: boolean;
}): number | undefined {
  const {
    explicitDuration,
    extractedDuration,
    isShortPreparation,
    hasExplicitEndAt,
    hasExplicitWindowPreset,
    hasExplicitStartAt,
  } = args;

  if (
    typeof explicitDuration === "number" &&
    Number.isFinite(explicitDuration)
  ) {
    return explicitDuration > 0 ? explicitDuration : undefined;
  }
  if (
    typeof extractedDuration === "number" &&
    Number.isFinite(extractedDuration)
  ) {
    if (extractedDuration > 0) {
      return extractedDuration;
    }
    if (isShortPreparation && (hasExplicitStartAt || hasExplicitWindowPreset)) {
      return MIN_CREATE_EVENT_DURATION_MINUTES;
    }
    return undefined;
  }
  if (
    !hasExplicitEndAt &&
    isShortPreparation &&
    (hasExplicitStartAt || hasExplicitWindowPreset)
  ) {
    return MIN_CREATE_EVENT_DURATION_MINUTES;
  }
  return undefined;
}

/**
 * True when authoritative user-authored text states a repeating cadence.
 * Delegates to the shared explicit-recurrence markers — repetition words only,
 * never planner/assistant prose or time-of-day window phrases, which appear in
 * one-shot asks ("dentist tomorrow in the morning") and must not open the gate.
 */
export function intentStatesRecurrence(
  ...texts: ReadonlyArray<string | null | undefined>
): boolean {
  return textStatesExplicitRecurrence(...texts);
}

type CreateEventRequestBuildArgs = {
  details: Record<string, unknown> | undefined;
  extractedDetails: Record<string, unknown>;
  explicitTitle: string | undefined;
  inferredTitle: string | undefined;
  fallbackRequest?: CreateLifeOpsCalendarEventRequest;
  preferExtractedDetails?: boolean;
  /**
   * Authoritative user-authored text for the recurrence guard. Planner intent,
   * structured details, and assistant/system history must never authorize an
   * RRULE the current user did not request.
   */
  recurrenceGuardTexts?: ReadonlyArray<string | null | undefined>;
};

type CreateEventRequestBuildResult = {
  title: string | undefined;
  resolvedStartAt: string | undefined;
  resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  request: CreateLifeOpsCalendarEventRequest;
  travelIntent: CreateEventTravelIntent | null;
};

function parseCreateEventDurationValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickCreateEventStringField(
  args: CreateEventRequestBuildArgs,
  key: string,
): string | undefined {
  const explicit = detailString(args.details, key);
  const extracted = detailString(args.extractedDetails, key);
  const fallback =
    args.fallbackRequest &&
    typeof args.fallbackRequest[
      key as keyof CreateLifeOpsCalendarEventRequest
    ] === "string"
      ? (args.fallbackRequest[
          key as keyof CreateLifeOpsCalendarEventRequest
        ] as string)
      : undefined;
  return args.preferExtractedDetails
    ? (extracted ?? explicit ?? fallback)
    : (explicit ?? extracted ?? fallback);
}

export function buildCreateEventRequest(
  args: CreateEventRequestBuildArgs,
): CreateEventRequestBuildResult {
  const extractedTitle = detailString(args.extractedDetails, "title");
  const title = args.preferExtractedDetails
    ? (extractedTitle ??
      args.explicitTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle)
    : (args.explicitTitle ??
      extractedTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle);

  const explicitStartAt = createStartDetail(args.details);
  const explicitEndAt = createEndDetail(args.details);
  const explicitWindowPreset = sanitizeWindowPreset(
    detailString(args.details, "windowPreset"),
  );
  const extractedStartAt = detailString(args.extractedDetails, "startAt");
  const extractedEndAt = detailString(args.extractedDetails, "endAt");
  const extractedWindowPreset = sanitizeWindowPreset(
    detailString(args.extractedDetails, "windowPreset"),
  );

  let resolvedStartAt: string | undefined;
  let resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  if (args.preferExtractedDetails && extractedStartAt) {
    resolvedStartAt = extractedStartAt;
    resolvedWindowPreset = undefined;
  } else if (args.preferExtractedDetails && extractedWindowPreset) {
    resolvedStartAt = undefined;
    resolvedWindowPreset = extractedWindowPreset;
  } else {
    resolvedStartAt =
      explicitStartAt ?? extractedStartAt ?? args.fallbackRequest?.startAt;
    resolvedWindowPreset = resolvedStartAt
      ? undefined
      : (explicitWindowPreset ??
        extractedWindowPreset ??
        args.fallbackRequest?.windowPreset);
  }

  const rawEndAt =
    args.preferExtractedDetails &&
    (extractedStartAt || extractedWindowPreset) &&
    !extractedEndAt
      ? undefined
      : args.preferExtractedDetails
        ? (extractedEndAt ?? explicitEndAt ?? args.fallbackRequest?.endAt)
        : (explicitEndAt ?? extractedEndAt ?? args.fallbackRequest?.endAt);

  const explicitDuration = detailNumber(args.details, "durationMinutes");
  const extractedDuration = parseCreateEventDurationValue(
    args.extractedDetails.durationMinutes,
  );
  const fallbackDuration = args.fallbackRequest?.durationMinutes;

  const durationMinutes = resolveCreateEventDurationMinutes({
    explicitDuration: explicitDuration,
    extractedDuration,
    isShortPreparation: normalizeIsShortPreparationFlag(
      args.extractedDetails.isShortPreparation,
    ),
    hasExplicitEndAt: Boolean(rawEndAt),
    hasExplicitWindowPreset: Boolean(resolvedWindowPreset),
    hasExplicitStartAt: Boolean(resolvedStartAt),
  });
  const resolvedDurationMinutes =
    explicitDuration !== undefined || extractedDuration !== undefined
      ? durationMinutes
      : fallbackDuration;
  const travelIntent =
    injectedDeps?.travelBuffer?.resolveTravelIntent({
      details: args.details,
      extractedDetails: args.extractedDetails,
    }) ?? null;

  const explicitRecurrence = detailRecurrenceLines(args.details);
  // The extraction model routinely infers weekly recurrence from
  // cadence-flavored event nouns ("standup monday at 10am" →
  // RRULE:FREQ=WEEKLY;BYDAY=MO) even though the user asked for one event; on
  // the built-in calendar that hard-400s (ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED)
  // and the turn lectures about providers instead of creating the event.
  // Every recurrence source here is model-authored: `details` comes from the
  // outer planner, `extractedDetails` from the domain extractor, and fallback
  // requests from an earlier model-built attempt. Gate all of them on current
  // authoritative user text so planner disagreement cannot create recurrence.
  const extractedRecurrence = detailRecurrenceLines(args.extractedDetails);
  const recurrence = selectUserAuthorizedRecurrence(
    args.recurrenceGuardTexts ?? [],
    args.preferExtractedDetails
      ? [
          extractedRecurrence,
          explicitRecurrence,
          args.fallbackRequest?.recurrence,
        ]
      : [
          explicitRecurrence,
          extractedRecurrence,
          args.fallbackRequest?.recurrence,
        ],
  );

  return {
    title,
    resolvedStartAt,
    resolvedWindowPreset,
    travelIntent,
    request: {
      mode: connectorModeDetail(args.details) ?? args.fallbackRequest?.mode,
      side: connectorSideDetail(args.details) ?? args.fallbackRequest?.side,
      grantId: connectorGrantIdDetail(args.details),
      calendarId:
        calendarIdDetail(args.details) ??
        sanitizeCalendarId(args.fallbackRequest?.calendarId),
      title: title ?? "",
      description:
        pickCreateEventStringField(args, "description") ??
        args.fallbackRequest?.description,
      location:
        pickCreateEventStringField(args, "location") ??
        args.fallbackRequest?.location,
      startAt: resolvedStartAt,
      endAt: rawEndAt ?? args.fallbackRequest?.endAt,
      timeZone:
        pickCreateEventStringField(args, "timeZone") ??
        args.fallbackRequest?.timeZone,
      durationMinutes: resolvedDurationMinutes,
      windowPreset: resolvedWindowPreset,
      attendees:
        normalizeCalendarAttendees(args.details) ??
        args.fallbackRequest?.attendees,
      recurrence,
    },
  };
}

function formatCreateEventRecentConversation(state: State | undefined): string {
  const conversation = planningConversationLines(state).join("\n").trim();
  return conversation.length > 0 ? conversation : "(none)";
}

function formatUpdateEventTargetContext(
  event: LifeOpsCalendarEvent | null,
): string {
  if (!event) {
    return "(unknown)";
  }
  const attendees = event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  const recurring = isRecurringCalendarEvent(event);
  return [
    `title: ${event.title}`,
    `startAt: ${event.startAt}`,
    `endAt: ${event.endAt}`,
    `timeZone: ${event.timezone ?? ""}`,
    `formattedStart: ${formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    })}`,
    `location: ${event.location}`,
    `description: ${event.description}`,
    `attendees: ${attendees}`,
    `recurring: ${recurring ? "yes" : "no"}`,
    ...(recurring
      ? [
          `recurrenceDescription: ${
            describeRecurrence(recurrenceLinesFrom(event)) ?? "(unknown rule)"
          }`,
        ]
      : []),
  ].join("\n");
}

async function inferCreateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  calendarContext: CreateEventCalendarContext | null,
  fallbackTimeZone = resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  // Anchor the LLM in the present so relative phrases ("tomorrow", "next
  // friday", "april 15") and explicit-but-yearless dates resolve to the
  // correct ISO datetime instead of guessing or returning empty.
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const calendarTimeZone =
    calendarContext?.calendarTimeZone ?? fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const localDateAnchors = buildCalendarLocalDateAnchors(now, timeZone);
  const prompt = [
    "Extract calendar event creation fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "Treat the latest user request as authoritative, but recover missing event subject, date, or location from earlier turns when needed.",
    "If the current request is a follow-up, recover the event subject from recent conversation and apply new timing or location constraints from the current request.",
    "Use the calendar context below to ground any timing guess.",
    "Preserve names and places in their original language or script when useful.",
    "Return JSON only as a single object. No prose. Omit optional fields that have no source in the request or conversation; do not invent values to fill them. Preserve literal user-provided titles, descriptions, and locations.",
    "If a start time or window is implied but duration is not explicit, infer a reasonable positive duration.",
    "For short prep or reminder blocks, use at least 15 minutes instead of 0.",
    "Set isShortPreparation=true when the event is a brief prep/reminder/leave-for/get-ready block (any language) where 15 minutes is the right default.",
    "When the user gives a concrete day or date without an exact time-of-day, use the calendar context to infer a plausible open startAt in the calendar timezone. Avoid obvious overlaps with nearby events. If the calendar context is unavailable or the timing is ambiguous, leave startAt empty.",
    "Only use windowPreset for explicit 'tomorrow morning|afternoon|evening' phrasing — never as a fallback for arbitrary dates.",
    "If the user asks for travel time, commute time, or a buffer from a place, capture the origin separately as travelOriginAddress.",
    "Omit travelOriginAddress unless the request explicitly names the origin or departure place.",
    "When the user asks for a repeating event (every day, every week, every two weeks, weekdays, every month, etc.), emit the matching RFC 5545 RRULE in recurrence. Use BYDAY for weekly day selection, INTERVAL for every-N spacing, and COUNT or UNTIL only when the user bounds the repetition. Leave recurrence empty for one-off events.",
    "",
    "title: event title",
    "description: optional description",
    "location: optional location",
    "startAt: RFC 3339 datetime if explicit or resolvable from a date phrase; include the numeric UTC offset that represents the requested wall-clock time in the calendar timezone",
    "endAt: RFC 3339 datetime if explicit; use the same offset rules as startAt",
    "durationMinutes: number if implied",
    "windowPreset: tomorrow_morning|tomorrow_afternoon|tomorrow_evening",
    "timeZone: IANA timezone if stated",
    "recurrence: RFC 5545 RRULE string, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO or RRULE:FREQ=DAILY;COUNT=10, only for repeating events",
    "travelOriginAddress: optional origin address for travel-time calculation",
    "isShortPreparation: true|false",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `LOCAL DATE ANCHORS (authoritative — IGNORE UTC day for date arithmetic): ${localDateAnchors}.`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime (informational only — do NOT use for 'today/tomorrow/yesterday'): ${nowIso}`,
    "Resolve relative dates from the LOCAL DATE ANCHORS. Preserve the requested local clock time: for 9am in America/Los_Angeles emit 09:00 with the applicable -07:00/-08:00 offset, never 09:00Z. Use Z only when the calendar timezone is UTC.",
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Calendar context:\n${formatCreateEventCalendarContext(calendarContext)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.extract_create_event",
    failureMessage: "Calendar create-event extraction model call failed",
    source: "action:calendar",
  });
  return result?.parsed ?? {};
}

async function inferUpdateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  targetEvent: LifeOpsCalendarEvent | null,
  fallbackTimeZone = targetEvent?.timezone ?? resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event update fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "The current event below is the source of truth for unchanged fields.",
    "Only return fields the user is actually changing. Omit unchanged or unknown fields entirely; do not fill them with empty strings or null.",
    "To remove an existing description or location, include its field name in clearFields only when the user explicitly requests that removal. Never use clearFields for unchanged, unknown, or omitted fields. Do not also return a replacement value for a field being cleared.",
    "If the user asks to move or reschedule the event, compute absolute ISO datetimes for the updated startAt and endAt using the current event as context.",
    "If the user gives a relative shift like later, earlier, push back, or move forward, apply it to the current event timing.",
    "Unless the user explicitly changes the timezone, preserve the current event timezone.",
    "If the user only renames the event, omit startAt, endAt, location, description, and timeZone.",
    "When the current event is part of a recurring series, set recurrenceScope to instance for only this occurrence, this_and_following for this occurrence and every later one, series for every occurrence including earlier ones, and omit it when the user does not say.",
    "Only set recurrence when the user changes how the event repeats (e.g. switch to weekly, stop after 5 times).",
    "Return JSON only as a single object. No prose.",
    "",
    "title: new event title if changed",
    "description: updated description if changed",
    "location: updated location if changed",
    'clearFields: optional array containing "description" and/or "location" only for fields the user explicitly wants removed',
    "startAt: updated ISO datetime if changed",
    "endAt: updated ISO datetime if changed",
    "timeZone: IANA timezone if changed or needed to interpret the update",
    "recurrence: RFC 5545 RRULE string only when the repetition itself changes",
    "recurrenceScope: instance|this_and_following|series only when the current event is recurring and the user says which",
    "",
    `Current timezone: ${timeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${recentConversation}`,
    `Current event:\n${formatUpdateEventTargetContext(targetEvent)}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime,
    prompt,
    actionType: "lifeops.calendar.extract_update_event",
    failureMessage: "Calendar update-event extraction model call failed",
    source: "action:calendar",
  });
  return result?.parsed ?? {};
}

function scoreCalendarEvent(
  event: LifeOpsCalendarEvent,
  query: string,
): number {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(event.title);
  const description = normalizeText(event.description);
  const location = normalizeText(event.location);
  const attendees = event.attendees
    .flatMap((attendee) => [attendee.displayName ?? "", attendee.email ?? ""])
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
  let score = 0;

  const queryVariants = [
    ...new Set([normalizedQuery, ...tokenVariants(normalizedQuery)]),
  ];
  if (queryVariants.some((variant) => title === variant)) {
    score += 100;
  } else if (
    queryVariants.some(
      (variant) => variant.length > 0 && title.includes(variant),
    )
  ) {
    score += 75;
  }

  if (
    queryVariants.some(
      (variant) => variant.length > 0 && description.includes(variant),
    )
  ) {
    score += 35;
  }
  if (
    queryVariants.some(
      (variant) => variant.length > 0 && location.includes(variant),
    )
  ) {
    score += 30;
  }
  if (
    attendees.some((value) =>
      queryVariants.some(
        (variant) => variant.length > 0 && value.includes(variant),
      ),
    )
  ) {
    score += 25;
  }

  const queryTokens = tokenizeForSearch(normalizedQuery);
  if (queryTokens.length > 0) {
    const titleTokens = new Set(tokenizeForSearch(title));
    const descriptionTokens = new Set(tokenizeForSearch(description));
    const locationTokens = new Set(tokenizeForSearch(location));
    const attendeeTokens = attendees.flatMap((value) =>
      tokenizeForSearch(value),
    );
    const attendeeTokenSet = new Set(attendeeTokens);

    score += queryTokens.filter((token) => titleTokens.has(token)).length * 12;
    score +=
      queryTokens.filter((token) => descriptionTokens.has(token)).length * 8;
    score +=
      queryTokens.filter((token) => locationTokens.has(token)).length * 14;
    score +=
      queryTokens.filter((token) => attendeeTokenSet.has(token)).length * 8;
  }

  // (Earlier revisions added an English-only "return/back/home" boost and a
  // counter-penalty against generic flight/travel/trip events. Token matching
  // above already covers any language; the boost was multilingual-hostile and
  // produced wrong results when the user said the equivalent in another
  // language. The grounded LLM disambiguation step picks the right match
  // when token scores are tied.)

  const dateTerms = eventDateSearchTerms(event);
  if (
    [...dateTerms].some(
      (term) =>
        term === normalizedQuery ||
        normalizedQuery.includes(term) ||
        term.includes(normalizedQuery),
    )
  ) {
    score += 90;
  }
  const dateTokens = new Set(
    [...dateTerms].flatMap((term) => tokenizeForSearch(term)),
  );
  score += queryTokens.filter((token) => dateTokens.has(token)).length * 10;

  return score;
}

function shouldGroundCalendarSearchWithLlm(
  query: string,
  rankedEvents: RankedCalendarSearchCandidate[],
): boolean {
  const strongestScore = rankedEvents[0]?.score ?? 0;
  if (strongestScore <= 0) {
    return false;
  }
  if (strongestScore >= 72) {
    return false;
  }
  return wordCount(query) >= 2 || rankedEvents.length > 1;
}

function normalizeCalendarMatchIdsFromValue(
  value: unknown,
  allowedIds: Set<string>,
): string[] {
  const rawIds: string[] = [];
  if (typeof value === "string") {
    for (const token of value.split(
      /\s{0,256}\|\|\s{0,256}|\s{0,256},\s{0,256}|\s{1,256}/,
    )) {
      if (token.trim().length > 0) {
        rawIds.push(token.trim());
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        rawIds.push(item.trim());
      }
    }
  }
  return [...new Set(rawIds.filter((id) => allowedIds.has(id)))];
}

function extractCalendarGroundedMatchIds(
  rawResponse: string,
  allowedIds: Set<string>,
): string[] | null {
  const parsed = parseCalendarJsonRecord<Record<string, unknown>>(rawResponse);
  if (!parsed) {
    return null;
  }

  const possibleKeys = [
    "matchIds",
    "matches",
    "ids",
    "matchId",
    "matchId1",
    "matchId2",
    "matchId3",
  ] as const;
  const sawExplicitMatchField = possibleKeys.some((key) => key in parsed);
  if (!sawExplicitMatchField) {
    return null;
  }

  const ids = possibleKeys.flatMap((key) =>
    normalizeCalendarMatchIdsFromValue(parsed[key], allowedIds),
  );
  return [...new Set(ids)];
}

function formatCalendarCandidateForGrounding(
  candidate: RankedCalendarSearchCandidate,
): string {
  const attendees = candidate.event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  return [
    `id: ${candidate.event.id}`,
    `score: ${candidate.score}`,
    `title: ${candidate.event.title}`,
    `startAt: ${candidate.event.startAt}`,
    `location: ${candidate.event.location}`,
    `description: ${candidate.event.description}`,
    `attendees: ${attendees}`,
  ].join("\n");
}

async function groundCalendarSearchMatchesWithLlm(
  runtime: IAgentRuntime,
  state: State | undefined,
  intent: string,
  queries: string[],
  candidates: RankedCalendarSearchCandidate[],
): Promise<string[] | null> {
  if (candidates.length === 0) {
    return [];
  }

  const recentConversation = formatCreateEventRecentConversation(state);
  const allowedIds = new Set(candidates.map((candidate) => candidate.event.id));
  const prompt = [
    "Decide which candidate calendar events directly match the user's request.",
    "Be strict.",
    "Return NO matches when the candidate only shares a generic time window or vague travel context.",
    "If the request names a person, company, topic, or event name, only match candidates that explicitly mention that subject in the title, description, location, or attendees.",
    "Flights only count when the request is actually about flights/travel, or the flight text explicitly mentions the named subject.",
    "Return JSON only as a single object. No prose. No hidden reasoning.",
    "Return matchIds as an array of ids.",
    "",
    'Example: {"matchIds":["evt_1","evt_2"],"reason":""}',
    "",
    `Resolved intent:\n${intent}`,
    `Search queries:\n${queries.join(" || ")}`,
    `Recent conversation:\n${recentConversation}`,
    "",
    "Candidates:",
    ...candidates.map(
      (candidate, index) =>
        `candidate ${index + 1}\n${formatCalendarCandidateForGrounding(candidate)}`,
    ),
  ].join("\n");

  const rawResponse = await runLifeOpsTextModel({
    runtime,
    prompt,
    actionType: "lifeops.calendar.ground_search_matches",
    failureMessage: "Calendar search grounding model call failed",
    source: "action:calendar",
  });
  return rawResponse === null
    ? null
    : extractCalendarGroundedMatchIds(rawResponse, allowedIds);
}

function buildCalendarGroundingCandidates(
  events: LifeOpsCalendarEvent[],
): RankedCalendarSearchCandidate[] {
  return events.map((event, index) => ({
    event,
    score: Math.max(1, 24 - index),
    matchedQueries: [],
  }));
}

function eventStartMs(event: LifeOpsCalendarEvent): number {
  return Date.parse(event.startAt);
}

function eventEndMs(event: LifeOpsCalendarEvent): number {
  const parsed = Date.parse(event.endAt);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return eventStartMs(event);
}

function resolveTripWindowEvents(
  events: LifeOpsCalendarEvent[],
  location: string,
): LifeOpsCalendarEvent[] | null {
  // Trip-window anchoring is driven entirely by location-token matching via
  // scoreCalendarEvent. The previous English-only "travel keyword" boost
  // (flight/hotel/airbnb/...) was multilingual-hostile; the LLM trip_window
  // planner already supplies a location, so location matching alone is enough.
  const anchors = events
    .map((event) => ({
      event,
      score: scoreCalendarEvent(event, location),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) => eventStartMs(left.event) - eventStartMs(right.event),
    );

  if (anchors.length === 0) {
    return null;
  }

  const windowStart = Math.min(
    ...anchors.map((candidate) => eventStartMs(candidate.event)),
  );
  const windowEnd = Math.max(
    ...anchors.map((candidate) => eventEndMs(candidate.event)),
  );

  return events
    .filter(
      (event) =>
        eventEndMs(event) >= windowStart && eventStartMs(event) <= windowEnd,
    )
    .sort((left, right) => eventStartMs(left) - eventStartMs(right));
}

function formatCalendarMoment(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      month: "short",
      day: "numeric",
    }).format(new Date(event.startAt));
  }
  return formatCalendarEventDateTime(event);
}

function formatTripWindowResults(
  events: LifeOpsCalendarEvent[],
  location: string,
): string {
  if (events.length === 0) {
    return `I couldn't find any upcoming calendar events while you're in ${location}.`;
  }

  const lines = [`Here's what's on your calendar while you're in ${location}:`];
  for (const event of events) {
    lines.push(`- ${formatCalendarMoment(event)}: **${event.title}**`);
  }
  return lines.join("\n");
}

// The query may be a raw user message or an LLM-extracted phrase — either can
// be a multi-line blob, so echoes go through describeUserReference. Exported
// for regression tests.
export function formatCalendarSearchResults(
  events: LifeOpsCalendarEvent[],
  query: string,
  label: string,
): string {
  const queryEcho = describeUserReference(query, "that request");
  if (events.length === 0) {
    return `No calendar events matched ${queryEcho} ${label}.`;
  }
  if (events.length === 1) {
    const event = events.at(0);
    if (!event) {
      return `No calendar events matched ${queryEcho} ${label}.`;
    }
    // Keep the internal event label generic. The existing planner evaluator
    // uses these facts and receipts to choose the final natural phrasing.
    return `Your matching calendar event is **${event.title}** (${formatCalendarMoment(event)}).`;
  }
  const lines = [
    `Found ${events.length} calendar event${events.length === 1 ? "" : "s"} for ${queryEcho} ${label}:`,
  ];
  for (const event of events) {
    const when = event.isAllDay
      ? "all day"
      : formatCalendarEventDateTime(event);
    lines.push(`- **${event.title}** (${when})`);
    if (event.location) {
      lines.push(`  Location: ${event.location}`);
    }
    if (event.description) {
      lines.push(`  ${event.description}`);
    }
  }
  return lines.join("\n");
}

export function normalizeCalendarAttendees(
  details: Record<string, unknown> | undefined,
): CreateLifeOpsCalendarEventAttendee[] | undefined {
  const attendees = detailArray(details, "attendees");
  if (!attendees) {
    return undefined;
  }
  const mapped: Array<CreateLifeOpsCalendarEventAttendee | null> =
    attendees.map((attendee) => {
      if (typeof attendee === "string") {
        const email = attendee.trim();
        return basicEmailValid(email) ? { email } : null;
      }
      if (
        !attendee ||
        typeof attendee !== "object" ||
        Array.isArray(attendee)
      ) {
        return null;
      }
      const record = attendee as Record<string, unknown>;
      const email =
        typeof record.email === "string" && basicEmailValid(record.email.trim())
          ? record.email.trim()
          : null;
      if (!email) {
        return null;
      }
      return {
        email,
        displayName:
          typeof record.displayName === "string" &&
          record.displayName.trim().length > 0
            ? record.displayName.trim()
            : undefined,
        optional:
          typeof record.optional === "boolean" ? record.optional : undefined,
      };
    });
  const normalized = mapped.filter(
    (attendee): attendee is CreateLifeOpsCalendarEventAttendee =>
      attendee !== null,
  );
  return normalized.length > 0 ? normalized : undefined;
}

type CalendarEffectIdentityValue = string | number | boolean | null;

function calendarEffectId(
  namespace: string,
  values: readonly CalendarEffectIdentityValue[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex");
  return `${namespace}:${digest}`;
}

function validCalendarTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestCalendarTimestamp(
  values: readonly (string | null | undefined)[],
  fallback: string,
): string {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const normalized = validCalendarTimestamp(value);
    if (!normalized) continue;
    const timestamp = Date.parse(normalized);
    if (timestamp > latestMs) {
      latest = normalized;
      latestMs = timestamp;
    }
  }
  return latest ?? fallback;
}

function calendarMessageObservedAt(message: Memory): string {
  const createdAt = message.createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return new Date(createdAt).toISOString();
  }
  return new Date().toISOString();
}

function calendarRequestNoopReceipt(args: {
  message: Memory;
  operation: string;
  discriminator?: string;
  reason: string;
}): EffectReceipt {
  const observedAt = calendarMessageObservedAt(args.message);
  const resourceId = calendarEffectId("calendar-request-resource-v1", [
    String(args.message.id),
    args.operation,
    args.discriminator ?? null,
  ]);
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-request-receipt-v1", [
      resourceId,
      observedAt,
      args.reason,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.request",
      id: resourceId,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason: args.reason,
  });
}

function calendarFailedReceipt(args: {
  message: Memory;
  operation: string;
  discriminator?: string;
  code: string;
  retryable: boolean;
  acceptance?: "rejected" | "unknown";
}): EffectReceipt {
  const observedAt = new Date().toISOString();
  const resourceId = calendarEffectId("calendar-operation-resource-v1", [
    String(args.message.id),
    args.operation,
    args.discriminator ?? null,
  ]);
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-failed-receipt-v1", [
      resourceId,
      args.code,
      observedAt,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.operation",
      id: resourceId,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "failed",
    failure: {
      code: args.code,
      retryable: args.retryable,
      acceptance: args.acceptance ?? "rejected",
    },
  });
}

function calendarFeedReadReceipt(args: {
  feed: LifeOpsCalendarFeed;
  operation: string;
  events?: readonly LifeOpsCalendarEvent[];
  discriminator?: string;
  reason?: string;
}): EffectReceipt {
  const events = args.events ?? args.feed.events;
  const eventVersions = [...events]
    .map((event) => [
      event.id,
      event.externalId,
      event.status,
      event.updatedAt,
      event.syncedAt,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const sourceVersions = args.feed.sources
    .map((source) => [
      source.status,
      source.syncedAt,
      source.changeDelivery?.status ?? null,
      source.changeDelivery?.lastSuccessfulSyncAt ?? null,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const resourceId = calendarEffectId("calendar-feed-resource-v1", [
    args.feed.calendarId,
    args.feed.timeMin,
    args.feed.timeMax,
    args.discriminator ?? null,
  ]);
  const version = calendarEffectId("calendar-feed-version-v1", [
    args.feed.state,
    args.feed.source,
    args.feed.syncedAt,
    JSON.stringify(sourceVersions),
    JSON.stringify(eventVersions),
  ]);
  const observedAt = latestCalendarTimestamp(
    [
      args.feed.syncedAt,
      ...args.feed.sources.flatMap((source) => [
        source.syncedAt,
        source.changeDelivery?.lastSuccessfulSyncAt,
        source.changeDelivery?.lastNotificationAt,
      ]),
      ...events.flatMap((event) => [event.updatedAt, event.syncedAt]),
    ],
    new Date().toISOString(),
  );
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-feed-read-receipt-v1", [
      args.operation,
      resourceId,
      version,
      observedAt,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.feed",
      id: resourceId,
      version,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason:
      args.reason ??
      "The operation read an authoritative calendar snapshot without changing it.",
  });
}

function calendarNextEventReadReceipt(
  context: LifeOpsNextCalendarEventContext,
): EffectReceipt {
  const event = context.event;
  const sourceVersions = context.calendarSources
    .map((source) => [
      source.status,
      source.syncedAt,
      source.changeDelivery?.status ?? null,
      source.changeDelivery?.lastSuccessfulSyncAt ?? null,
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const resourceId = calendarEffectId("calendar-next-event-resource-v1", [
    event?.calendarId ?? null,
    event?.id ?? null,
  ]);
  const version = calendarEffectId("calendar-next-event-version-v1", [
    context.calendarFeedState,
    event?.externalId ?? null,
    event?.status ?? null,
    event?.updatedAt ?? null,
    event?.syncedAt ?? null,
    JSON.stringify(sourceVersions),
  ]);
  const observedAt = latestCalendarTimestamp(
    [
      event?.updatedAt,
      event?.syncedAt,
      ...context.calendarSources.flatMap((source) => [
        source.syncedAt,
        source.changeDelivery?.lastSuccessfulSyncAt,
        source.changeDelivery?.lastNotificationAt,
      ]),
    ],
    new Date().toISOString(),
  );
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-next-event-read-receipt-v1", [
      resourceId,
      version,
      observedAt,
    ]),
    operation: "calendar.event.next.read",
    resource: {
      kind: "calendar.next_event",
      id: resourceId,
      version,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "noop",
    reason:
      "The operation read the next-event projection without changing calendar state.",
  });
}

function calendarApprovalReceipt(
  approval: CalendarMutationApprovalResult,
): EffectReceipt {
  const operation = `calendar.approval.${approval.action}`;
  const receiptId = calendarEffectId("calendar-approval-receipt-v1", [
    approval.requestId,
    approval.action,
    approval.state,
    approval.acceptedAt,
    approval.idempotencyKey,
    approval.replayed,
  ]);
  const base = {
    receiptId,
    operation,
    resource: {
      kind: "calendar.approval_request",
      id: approval.requestId,
      version: approval.state,
    },
    artifacts: [],
    idempotency: {
      key: approval.idempotencyKey,
      replayed: approval.replayed,
    },
    observedAt: approval.acceptedAt,
  } as const;
  return normalizeEffectReceipt(
    approval.replayed
      ? {
          ...base,
          outcome: "noop",
          reason:
            "The approval queue returned the existing idempotent request without persisting a duplicate.",
        }
      : {
          ...base,
          outcome: "applied",
          commit: {
            kind: "durable",
            id: approval.requestId,
            committedAt: approval.acceptedAt,
          },
        },
  );
}

function calendarEventMutationReceipt(args: {
  event: LifeOpsCalendarEvent;
  idempotencyKey: string;
  operation:
    | "calendar.event.create"
    | "calendar.event.update"
    | "calendar.event.delete";
  deleted?: boolean;
}): EffectReceipt {
  const observedAt = latestCalendarTimestamp(
    [args.event.updatedAt, args.event.syncedAt],
    new Date().toISOString(),
  );
  const providerVersion =
    typeof args.event.metadata.etag === "string"
      ? args.event.metadata.etag
      : args.event.updatedAt;
  const version = args.deleted ? `deleted:${providerVersion}` : providerVersion;
  return normalizeEffectReceipt({
    receiptId: calendarEffectId("calendar-event-mutation-receipt-v1", [
      args.operation,
      args.event.id,
      version,
      args.idempotencyKey,
    ]),
    operation: args.operation,
    resource: {
      kind: "calendar.event",
      id: args.event.id,
      version,
    },
    artifacts: [],
    idempotency: { key: args.idempotencyKey, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: "durable",
      id: args.event.id,
      committedAt: observedAt,
    },
  });
}

function localCalendarOperationKey(args: {
  message: Memory;
  operation: "create" | "update" | "delete";
  payload: unknown;
}): string {
  return calendarEffectId("calendar-local-operation-v1", [
    String(args.message.id),
    args.operation,
    JSON.stringify(args.payload),
  ]);
}

export type CalendarHandlerAction = Action & {
  suppressPostActionContinuation?: boolean;
};

/**
 * Build the inner calendar CRUD + LLM-intent action, wired to host-supplied
 * dependencies. The LifeOps `CALENDAR` umbrella delegates to this action's
 * handler after it has already gated owner access, so this handler trusts it
 * is running for an authorized owner and performs no access check of its own.
 */
export function createCalendarActionRunner(
  hostDeps: CalendarActionDeps,
): CalendarHandlerAction {
  injectedDeps = hostDeps;
  return calendarAction;
}

const calendarAction: CalendarHandlerAction = {
  name: "CALENDAR",
  // This operation union needs absent optional detail fields to stay absent on the wire.
  toolSchemaStrict: false,
  similes: [
    "CALENDAR_ACTION",
    "CHECK_CALENDAR",
    "CALENDAR_READ",
    "CALENDAR_FEED",
    "CALENDAR_NEXT_EVENT",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_SEARCH_EVENTS",
    "SHOW_CALENDAR_TODAY",
    "TODAY_SCHEDULE",
    "WEEK_AHEAD",
    "WEEK_VIEW",
    "WHATS_MY_NEXT_MEETING",
    "SCHEDULE_EVENT",
    "CREATE_CALENDAR_EVENT",
    "SEARCH_CALENDAR",
    "NEXT_MEETING",
    "ITINERARY",
    "TRAVEL_SCHEDULE",
    "CHECK_SCHEDULE",
    "BOOK_TIME_BLOCK",
    "RECURRING_TIME_BLOCK",
    "REBOOK_TRAVEL",
  ],
  tags: [
    "domain:calendar",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "effect:receipt-required",
    "surface:remote-api",
  ],
  description:
    "Interact with live calendars through LifeOps. " +
    "USE this action for: viewing today's or this week's schedule; checking the next upcoming event; " +
    "searching events by title, attendee, location, or date range; creating new calendar events; " +
    "requests like 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', or 'schedule a dentist appointment next Tuesday at 3pm'; " +
    "querying travel itineraries, flights, hotel stays, trip windows, reserving recurring time blocks, and rebooking or moving calendar-backed commitments. " +
    "These are live calendar reads and writes, so do not answer them from provider context alone and do not fall back to NONE or REPLY when this action is available. " +
    "DO NOT use this action when the user is only making an observation like 'my calendar has been crazy this quarter' unless they actually ask you to inspect or change calendar state. " +
    "DO NOT use this action for email inbox work, drafting or sending emails — use MESSAGE with operation=triage, search_inbox, draft_reply, or send_draft (source=gmail for Gmail-specific work) instead. " +
    "DO NOT use this action for personal habits, goals, routines, or reminders — use OWNER_ROUTINES, OWNER_GOALS, or OWNER_REMINDERS instead. " +
    "DO NOT use this action to propose or suggest candidate meeting times to send to someone — use PROPOSE_MEETING_TIMES for requests like 'propose three times for a 30 min sync with X', 'suggest meeting slots', or 'find times that work next week'. The create_event subaction is only for booking a single known time on your own calendar. " +
    "This action returns authoritative outcome receipts and complete internal evidence for the evaluator's final grounded reply; do not pair it with a speculative REPLY action.",
  descriptionCompressed:
    "LifeOps calendar: view/search/create/query travel; not email/habits",
  contexts: ["calendar", "contacts", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  // Owner-access gating is performed by the LifeOps CALENDAR umbrella before it
  // delegates here, so this inner handler trusts an authorized owner.
  validate: async () => true,
  handler: async (
    runtime,
    message,
    state,
    options,
    callback?: HandlerCallback,
  ) => {
    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | CalendarActionParams
      | undefined;
    const params = rawParams ?? ({} as CalendarActionParams);
    const intent = resolveCalendarIntentInput(params.intent, message);

    const details = normalizeCalendarDetails(params.details, [
      params.title,
      params.query,
    ]);
    const planningTimeZone = resolveCalendarTimeZone(
      details,
      resolveConfiguredCalendarTimeZone(runtime),
    );
    const explicitSubaction = normalizeCalendarSubaction(params.subaction);
    // A promoted CALENDAR_* tool call is already the action planner's typed
    // decision. Re-planning the same operation from raw prose inside the tool
    // adds latency and can contradict the selected native action. Preserve the
    // domain planner only for the umbrella CALENDAR action, where no typed
    // subaction was supplied.
    const llmPlan: CalendarLlmPlan = explicitSubaction
      ? {
          subaction: explicitSubaction,
          shouldAct: true,
          queries: dedupeCalendarQueries([
            params.query,
            ...(params.queries ?? []),
            detailString(details, "query"),
            ...(detailArray(details, "queries")?.map((value) =>
              typeof value === "string" ? value : undefined,
            ) ?? []),
          ]),
          title:
            (typeof params.title === "string" && params.title.trim().length > 0
              ? params.title.trim()
              : undefined) ?? detailString(details, "title"),
          tripLocation:
            explicitSubaction === "trip_window"
              ? (params.query ?? detailString(details, "query"))
              : undefined,
          timeMin: detailString(details, "timeMin"),
          timeMax: detailString(details, "timeMax"),
          windowLabel: detailString(details, "label"),
        }
      : await extractCalendarPlanWithLlm(
          runtime,
          message,
          state,
          intent,
          planningTimeZone,
        );
    const explicitTitle =
      (typeof params.title === "string" && params.title.trim().length > 0
        ? params.title.trim()
        : undefined) ??
      detailString(details, "title") ??
      llmPlan.title;
    const inferredTitle = explicitTitle ?? llmPlan.title;
    const tripWindowIntent =
      llmPlan.tripLocation && llmPlan.tripLocation.trim().length > 0
        ? { location: llmPlan.tripLocation.trim() }
        : null;
    const structuredSubaction = resolveStructuredCalendarSubaction(
      params,
      details,
    );
    const hasExplicitCalendarExecutionInput = Boolean(
      explicitSubaction ||
        params.title ||
        params.query ||
        (params.queries?.length ?? 0) > 0 ||
        detailString(details, "query") ||
        detailString(details, "oldTitle") ||
        (detailArray(details, "queries")?.length ?? 0) > 0 ||
        detailString(details, "eventId") ||
        detailString(details, "startAt") ||
        detailString(details, "endAt") ||
        detailString(details, "location") ||
        detailString(details, "windowPreset") ||
        detailNumber(details, "windowDays"),
    );
    const llmPlanMutationSubaction =
      llmPlan.subaction === "create_event" ||
      llmPlan.subaction === "update_event" ||
      llmPlan.subaction === "delete_event"
        ? llmPlan.subaction
        : null;
    const explicitReadHint =
      explicitSubaction === "feed" ||
      explicitSubaction === "next_event" ||
      explicitSubaction === "search_events";
    // The caller's subaction param is a routing-level hint from the outer
    // planner, which has no calendar instructions; the internal plan is the
    // domain decision made with the full conversation. A read hint must not
    // downgrade a planned mutation — the mutation branches run their own
    // candidate resolution and confirmation gates, so honoring the plan is
    // safe, while honoring the hint silently no-ops a confirmed request.
    const subaction =
      (explicitReadHint && llmPlanMutationSubaction
        ? llmPlanMutationSubaction
        : null) ??
      explicitSubaction ??
      llmPlan.subaction ??
      (tripWindowIntent ? "trip_window" : null) ??
      structuredSubaction;
    let searchQueries = resolveCalendarSearchQueries({
      explicitQueries: [
        params.query,
        detailString(details, "query"),
        detailString(details, "oldTitle"),
        ...(params.queries ?? []),
        ...(detailArray(details, "queries")?.map((value) =>
          typeof value === "string" ? value : undefined,
        ) ?? []),
      ],
      llmPlan,
      fallbackQueries: [
        tripWindowIntent?.location,
        // A typed delete target ("delete_event" + title) is the target itself;
        // dropping it sent valid structured deletes to the clarify path without
        // ever reading the feed (ROOT trace step-1788648925553-vzj6rq).
        ...(subaction === "delete_event"
          ? [params.title, detailString(details, "title")]
          : []),
      ],
    });
    // Remembered so the read path does not repeat the same extraction with
    // the same inputs when this one found nothing.
    let searchQueriesInferred = false;
    if (subaction === "search_events" && searchQueries.length === 0) {
      searchQueries = await inferCalendarSearchQueriesWithLlm({
        runtime,
        message,
        state,
        intent,
        llmPlan,
      });
      searchQueriesInferred = true;
    }
    const service = resolveCalendarService(runtime);
    // Complete evidence for the existing planner evaluator, not a second
    // action-owned synthesis. The receipt supplied to respond is authoritative
    // about applied/noop/failed state; facts and context are never delivered
    // directly as conversational text.
    const renderReply = (
      scenario: string,
      facts: string,
      context?: Record<string, unknown>,
    ) => ({
      domain: "calendar",
      intent,
      scenario,
      facts,
      context: context ?? {},
    });
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      text: string | ReturnType<typeof renderReply>;
      interaction?: boolean;
      data?: T;
      effectReceipt: EffectReceipt;
    }): Promise<ActionResult> => {
      const effectReceipt = normalizeEffectReceipt(payload.effectReceipt);
      if (!payload.interaction || typeof payload.text !== "string") {
        // `turnComplete:false` is the core contract for "evaluation required";
        // a settled successful operation with a canonical receipt omits it so
        // the runtime may phrase the receipt facts directly (owner ruling
        // 2026-09-05). Pauses for the user and failures keep the evaluation.
        const pauseData = payload.data as Record<string, unknown> | undefined;
        const settled =
          payload.success &&
          effectReceipt.outcome !== "failed" &&
          pauseData?.requiresInput !== true &&
          pauseData?.approvalRequired !== true;
        return {
          success: payload.success,
          transcriptVisibility: "internal",
          ...(settled ? {} : { turnComplete: false }),
          effectReceipts: [effectReceipt],
          data: {
            ...payload.data,
            // A settled missing/ambiguous lookup must not run again with the
            // same arguments. The planner may still choose a different target
            // or another authorized operation using the complete evidence.
            ...(!payload.success && effectReceipt.outcome === "noop"
              ? { retryable: false }
              : {}),
            replyContext: toActionData(
              typeof payload.text === "string"
                ? renderReply("action_outcome", payload.text)
                : payload.text,
            ),
          },
        };
      }
      // Approval choices and permission cards are explicit interaction
      // protocols. Preserve their exact text and binding, without synthesis.
      const text = payload.text.trim();
      const result: ActionResult = {
        success: payload.success,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        effectReceipts: [effectReceipt],
        userFacingEffectReceiptIds: [effectReceipt.receiptId],
        ...(payload.data !== undefined ? { data: payload.data } : {}),
      };
      await callback?.({ text, source: "action", action: "CALENDAR" });
      return result;
    };

    if (
      llmPlan.shouldAct === false &&
      !hasExplicitCalendarExecutionInput &&
      !explicitSubaction
    ) {
      const fallback =
        llmPlan.response ?? buildCalendarReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        effectReceipt: calendarRequestNoopReceipt({
          message,
          operation: "calendar.request.evaluate",
          discriminator: llmPlan.subaction ?? undefined,
          reason:
            "The request required a conversational reply without executing a calendar operation.",
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    if (!subaction) {
      const fallback =
        llmPlan.response ?? buildCalendarReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        effectReceipt: calendarRequestNoopReceipt({
          message,
          operation: "calendar.request.evaluate",
          discriminator: llmPlan.subaction ?? undefined,
          reason:
            "No unambiguous calendar operation was selected, so calendar state was unchanged.",
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    try {
      if (subaction === "next_event") {
        const context = await service.getNextCalendarEventContext(
          INTERNAL_URL,
          {
            calendarId: calendarIdDetail(details),
            timeZone: planningTimeZone,
          },
        );
        const fallback = formatNextEventContext(context);
        return respond({
          success: true,
          text: await renderReply("next_event", fallback, {
            event: context,
          }),
          effectReceipt: calendarNextEventReadReceipt(context),
          data: toActionData(context),
        });
      }

      if (subaction === "create_event") {
        const calendarContext = await loadCreateEventCalendarContext(
          service,
          details,
          true,
          planningTimeZone,
          configuredCalendarTimeZone(runtime),
        );
        if (!calendarContext) {
          throw new CalendarServiceError(
            503,
            "Calendar create is blocked because current calendar context is unavailable.",
            "CALENDAR_MUTATION_CONTEXT_UNAVAILABLE",
          );
        }
        requireCompleteFreshCalendarFeed(calendarContext.feed, "create");
        // When the native planner supplied the minimum executable create
        // shape, those typed fields are authoritative. The extraction model is
        // a fallback for umbrella or incomplete calls, not a mandatory second
        // interpretation of an already-structured planner decision.
        const plannerStartAt = createStartDetail(details);
        const plannerEndAt = createEndDetail(details);
        const plannerTimeZone = detailString(details, "timeZone");
        // A "Z" instant for an owner who is not in UTC is the planner's most
        // common mistake (live 2026-09-05: "tuesday at 7am" arrived as
        // 2026-09-09T07:00:00Z). It is not executable as typed; the
        // timezone-grounded extractor re-derives the wall time from the
        // user's words with local-date anchors instead of trusting the
        // fabricated instant.
        const utcInstantForNonUtcOwner = Boolean(
          plannerStartAt?.toUpperCase().endsWith("Z") &&
            (plannerTimeZone
              ? plannerTimeZone !== "UTC"
              : calendarContext.calendarTimeZone !== "UTC"),
        );
        const hasExecutablePlannerCreate = Boolean(
          explicitTitle &&
            ((plannerStartAt && normalizeIsoDateTime(plannerStartAt)) ||
              detailString(details, "windowPreset")) &&
            (!plannerEndAt || normalizeIsoDateTime(plannerEndAt)) &&
            !utcInstantForNonUtcOwner,
        );
        const extractedDetails = hasExecutablePlannerCreate
          ? {}
          : await inferCreateEventDetails(
              runtime,
              message,
              state,
              intent,
              calendarContext,
              planningTimeZone,
            );
        const createEventBuild = buildCreateEventRequest({
          details,
          extractedDetails,
          explicitTitle,
          inferredTitle,
          recurrenceGuardTexts: [messageText(message)],
          // The outer planner identifies CALENDAR and supplies hints; this
          // domain-specific extraction has the authoritative calendar context,
          // timezone, and local-date anchors needed to normalize wall time.
          preferExtractedDetails: !hasExecutablePlannerCreate,
        });
        const { title, resolvedStartAt, resolvedWindowPreset, request } =
          createEventBuild;
        // Planner timestamps arrive as offset-less wall time or with a real
        // offset. Anchor them to the create zone so the stored event and every
        // rendering share the owner's zone; the stated-day guard then keeps
        // the day the user named.
        const createTimeZone =
          plannerRequestedTimeZone({ timeZone: request.timeZone }) ??
          calendarContext.calendarTimeZone;
        anchorCreateRequestToTimeZone(request, createTimeZone);
        applyStatedDateToCreateRequest({
          request,
          currentMessage: messageText(message).trim(),
          intent,
          timeZone: createTimeZone,
        });
        const travelIntent = createEventBuild.travelIntent;
        if (!title) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_create_event_title",
              "What event do you want to add?",
              {
                missing: ["title"],
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.create",
              reason:
                "The create request was missing a title, so no approval or calendar event was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              requiresInput: true,
              missing: ["title"],
            },
          });
        }
        // The LifeOps service throws a raw 400 when neither startAt nor a
        // window preset is supplied. Catch that case here so the user gets a
        // useful prompt instead of "startAt is required when windowPreset is
        // not provided" — and so the failure path doesn't re-trigger the
        // action through planner follow-up.
        if (!resolvedStartAt && !resolvedWindowPreset) {
          const suggestedStartAt = title
            ? suggestCreateEventStartAt({
                currentMessage: messageText(message).trim(),
                intent,
                title,
                calendarContext,
              })
            : null;
          const fallback = suggestedStartAt
            ? `i can tentatively put "${title}" on ${formatCalendarEventDateTime(
                {
                  startAt: suggestedStartAt.startAt,
                  timezone: suggestedStartAt.timeZone,
                },
                { includeTimeZoneName: true },
              )}. if you want a different time, tell me what works better.`
            : `i need a time for "${title}" in ${
                calendarContext?.calendarTimeZone ?? planningTimeZone
              }. try "tomorrow morning", "tomorrow afternoon", "tomorrow evening", or give me a specific date and time.`;
          return respond({
            success: false,
            text: await renderReply("clarify_create_event_time", fallback, {
              title,
              suggestedStartAt,
              calendarTimeZone:
                calendarContext?.calendarTimeZone ?? planningTimeZone,
            }),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.create",
              discriminator: title,
              reason:
                "The create request was missing a time, so no approval or calendar event was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              requiresInput: true,
              missing: ["startAt"],
              title,
            },
          });
        }
        const pastStart = resolvePastStartClarification({
          request,
          details,
          title,
          currentMessage: messageText(message).trim(),
          intent,
          timeZone: createTimeZone,
          // The moment the user asked, the same clock the receipts observe.
          now: new Date(calendarMessageObservedAt(message)),
        });
        if (pastStart) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_create_event_past_start",
              pastStart.facts,
              {
                title,
                requestedStartAt: request.startAt,
                suggestedStartAt: pastStart.suggestedStartAt ?? null,
                calendarTimeZone: createTimeZone,
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.create",
              discriminator: title,
              reason:
                "The requested start had already passed, so no approval or calendar event was created until the user confirms the date.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              requiresInput: true,
              missing: ["confirmed date"],
              title,
              requestedStartAt: request.startAt,
              ...(pastStart.suggestedStartAt
                ? { suggestedStartAt: pastStart.suggestedStartAt }
                : {}),
            },
          });
        }
        const requestToApprove = await service.prepareCalendarEventCreate(
          INTERNAL_URL,
          request,
        );
        const travel = injectedDeps?.travelBuffer;
        let travelBuffer: CalendarTravelBufferResult | undefined;
        if (travelIntent && travel) {
          try {
            travelBuffer = await travel.computeTravelBuffer({
              runtime,
              event: {
                id: "pending-calendar-approval",
                location: requestToApprove.location ?? "",
              },
              travelIntent,
            });
          } catch (error) {
            if (travel.isTravelTimeUnavailable(error)) {
              return respond({
                success: false,
                text: `I couldn't prepare the travel buffer, so I did not queue or create the event: ${error.message}`,
                effectReceipt: calendarFailedReceipt({
                  message,
                  operation: "calendar.travel_buffer.prepare",
                  discriminator: title,
                  code: error.code,
                  retryable: true,
                }),
                data: {
                  actionName: "CALENDAR",
                  subaction: "create_event",
                  approvalRequired: true,
                  error: error.code,
                },
              });
            }
            throw error;
          }
        }
        if (requestToApprove.grantId === ELIZA_CALENDAR_GRANT_ID) {
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "create",
            payload: requestToApprove,
          });
          const { startAt, endAt, ...dateOnlyRequest } = requestToApprove;
          const createdEvent = await service.createCalendarEvent(
            INTERNAL_URL,
            requestToApprove.allDay
              ? { ...dateOnlyRequest, idempotencyKey }
              : { ...requestToApprove, startAt, endAt, idempotencyKey },
          );
          if (travelBuffer && travel) {
            await travel.reserveTravelBuffer({
              runtime,
              eventId: createdEvent.id,
              travelBuffer,
            });
          }
          const fallback = `Created “${createdEvent.title}” for ${formatCalendarEventDateTime(
            createdEvent,
            { includeTimeZoneName: true },
          )}.`;
          return respond({
            success: true,
            text: await renderReply("create_event_completed", fallback, {
              event: createdEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: createdEvent,
              idempotencyKey,
              operation: "calendar.event.create",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "create_event",
              approvalRequired: false,
              event: createdEvent,
              ...(travelBuffer ? { travelBuffer } : {}),
            },
          });
        }
        const approval = await requireCalendarMutationGateway().schedule({
          runtime,
          message,
          request: requestToApprove,
          ...(travelBuffer ? { travelBuffer } : {}),
        });
        return respond({
          success: true,
          text: approval.text,
          interaction: true,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "create_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: requestToApprove,
            ...(travelBuffer ? { travelBuffer } : {}),
          },
        });
      }

      if (subaction === "update_event") {
        const explicitEventId = detailString(details, "eventId");
        let resolvedEventId = explicitEventId;
        let resolvedCalendarId = calendarIdDetail(details);
        let targetEvent: LifeOpsCalendarEvent | null = null;
        if (!resolvedEventId) {
          const titleHint = searchQueries[0];
          if (!titleHint) {
            return respond({
              success: false,
              text: await renderReply(
                "clarify_update_event_target",
                "Tell me which calendar event you want to change by title, person, place, or date.",
                {
                  missing: ["target event"],
                  targetGuidance:
                    "Identify the existing event with query, details.oldTitle, or details.eventId. title and details.newTitle describe the replacement name, not the update target.",
                },
              ),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                reason:
                  "The update request did not identify a target, so no approval or calendar event was changed.",
              }),
              data: {
                error: "CALENDAR_TARGET_UNRESOLVED",
              },
            });
          }
          const feedRequest = plannerWindowUsable(details, llmPlan)
            ? resolveCalendarWindow(
                intent,
                details,
                true,
                llmPlan,
                planningTimeZone,
              ).request
            : {
                calendarId: calendarIdDetail(details),
                timeZone: planningTimeZone,
                ...buildWideLookupRange(planningTimeZone),
              };
          const feed = requireCompleteFreshCalendarFeed(
            await service.getCalendarFeed(INTERNAL_URL, {
              includeHiddenCalendars: true,
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              forceSync: true,
              ...feedRequest,
            }),
            "update",
          );
          const candidates = resolveCalendarMutationCandidates({
            action: "update",
            events: feed.events,
            titleHint,
            // An explicit `date` detail names the target's local day ahead of
            // any date phrase in the prose.
            texts: mutationTargetTexts({
              details,
              currentMessage: messageText(message),
              intent,
              timeZone: planningTimeZone,
            }),
            explicitDate: detailString(details, "date"),
            nonPlannerDateTexts: mutationTargetTexts({
              details,
              currentMessage: messageText(message),
              intent,
              timeZone: planningTimeZone,
              excludePlannerDate: true,
            }),
            timeZone: planningTimeZone,
          });
          if (candidates.length === 0) {
            const fallback = buildCalendarEventNotFoundFallback(
              "update",
              titleHint,
            );
            return respond({
              success: false,
              text: await renderReply("update_event_not_found", fallback, {
                titleHint: userReferenceLogView(titleHint),
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "No matching event was found, so no update approval was created.",
              }),
            });
          }
          if (candidates.length > 1) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "update",
              candidates,
              titleHint,
              timeZone: planningTimeZone,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_update_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint: userReferenceLogView(titleHint),
                candidates,
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "Multiple events matched the request, so no update approval was created.",
              }),
            });
          }
          targetEvent = candidates.at(0) ?? null;
          if (!targetEvent) {
            return respond({
              success: false,
              text: await renderReply(
                "update_event_not_found",
                "i couldn't find a unique event to update.",
                { titleHint: userReferenceLogView(titleHint) },
              ),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.update",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "A unique target could not be resolved, so no update approval was created.",
              }),
            });
          }
          resolvedEventId = targetEvent.externalId;
          resolvedCalendarId = targetEvent.calendarId;
        }
        if (!resolvedEventId) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_update_event_target",
              "i need an event id or a title + date to update an event.",
              {
                missing: ["event target"],
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.update",
              reason:
                "The update request did not resolve an event identifier, so calendar state was unchanged.",
            }),
          });
        }
        if (!targetEvent) {
          targetEvent = await service.getConditionalCalendarMutationTarget(
            INTERNAL_URL,
            {
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              calendarId: resolvedCalendarId,
              eventId: resolvedEventId,
            },
          );
          resolvedCalendarId = targetEvent.calendarId;
        }
        const newTitle = detailString(details, "newTitle") ?? explicitTitle;
        // The schema advertises `start`/`end` beside `startAt`/`endAt`; the
        // create path accepts both, and an update must too (live 2026-09-10
        // the planner's `start` was ignored and the time was re-extracted).
        const explicitStartAtForUpdate = createStartDetail(details);
        const explicitEndAtForUpdate = createEndDetail(details);
        const extractedForUpdate = targetEvent
          ? await inferUpdateEventDetails(
              runtime,
              message,
              state,
              intent,
              targetEvent,
              targetEvent.timezone ?? planningTimeZone,
            )
          : ({} as Record<string, unknown>);
        const extractedStartAt = detailString(extractedForUpdate, "startAt");
        const extractedEndAt = detailString(extractedForUpdate, "endAt");
        const extractedTimeZoneForUpdate = detailString(
          extractedForUpdate,
          "timeZone",
        );
        const recurrenceUpdate =
          detailRecurrenceLines(details) ??
          detailRecurrenceLines(extractedForUpdate);
        let recurrenceScopeForUpdate = resolveRecurrenceScopeIntent({
          details,
          fallbackDetails: extractedForUpdate,
          text: `${messageText(message)} ${intent}`,
        });
        if (!recurrenceScopeForUpdate) {
          recurrenceScopeForUpdate = lenientRecurrenceScope(
            extractedForUpdate.recurrenceScope,
          );
        }
        // A recurrence-rule change is inherently a series edit.
        if (recurrenceUpdate && !recurrenceScopeForUpdate) {
          recurrenceScopeForUpdate = "series";
        }
        // Mutating a recurring event without explicit occurrence/following/
        // series intent is ambiguous: ask instead of guessing.
        if (
          targetEvent &&
          isRecurringCalendarEvent(targetEvent) &&
          !recurrenceScopeForUpdate
        ) {
          const fallback = buildRecurrenceScopeClarification({
            action: "update",
            event: targetEvent,
          });
          return respond({
            success: false,
            text: await renderReply(
              "clarify_update_event_recurrence_scope",
              fallback,
              {
                event: targetEvent,
                recurrenceDescription: describeRecurrence(
                  recurrenceLinesFrom(targetEvent),
                ),
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.update",
              discriminator: resolvedEventId,
              reason:
                "The recurrence scope was ambiguous, so no update approval was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "update_event",
              requiresInput: true,
              missing: ["recurrenceScope"],
              eventId: resolvedEventId,
            },
          });
        }

        const grantId = targetEvent.grantId?.trim();
        if (!grantId) {
          throw new CalendarServiceError(
            409,
            "Calendar update is blocked because the target account binding is missing.",
            "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
          );
        }
        const updateTimeZone =
          detailString(details, "timeZone") ??
          extractedTimeZoneForUpdate ??
          targetEvent?.timezone ??
          undefined;
        const updateRequest = {
          side: targetEvent.side,
          grantId,
          calendarId: targetEvent.calendarId,
          eventId: targetEvent.externalId,
          title: newTitle,
          description: calendarUpdateTextField(
            details,
            extractedForUpdate,
            "description",
          ),
          location: calendarUpdateTextField(
            details,
            extractedForUpdate,
            "location",
          ),
          ...resolveUpdateTimeRange({
            explicitStart: explicitStartAtForUpdate,
            explicitEnd: explicitEndAtForUpdate,
            extractedStart: extractedStartAt,
            extractedEnd: extractedEndAt,
            target: targetEvent,
            timeZone: updateTimeZone,
          }),
          timeZone: updateTimeZone,
          recurrence: recurrenceUpdate,
          // Honor a scope only when the target recurs or the update itself
          // introduces a recurrence rule — the planner emits junk scopes.
          recurrenceScope:
            recurrenceScopeForUpdate &&
            (isRecurringCalendarEvent(targetEvent) || recurrenceUpdate)
              ? recurrenceScopeForUpdate
              : undefined,
          notifyAttendees: shouldNotifyAttendees(details, targetEvent),
        };
        if (targetEvent.provider === ELIZA_CALENDAR_PROVIDER) {
          const expectedProviderVersion = targetEvent.metadata.etag;
          if (typeof expectedProviderVersion !== "string") {
            throw new CalendarServiceError(
              409,
              "The built-in calendar event is missing its version. Refresh and try again.",
              "ELIZA_CALENDAR_VERSION_REQUIRED",
            );
          }
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "update",
            payload: updateRequest,
          });
          const updatedEvent = await service.updateCalendarEvent(INTERNAL_URL, {
            ...updateRequest,
            expectedProviderVersion,
            idempotencyKey,
          });
          const fallback = `Updated “${updatedEvent.title}” for ${formatCalendarEventDateTime(
            updatedEvent,
            { includeTimeZoneName: true },
          )}.`;
          return respond({
            success: true,
            text: await renderReply("update_event_completed", fallback, {
              event: updatedEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: updatedEvent,
              idempotencyKey,
              operation: "calendar.event.update",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "update_event",
              approvalRequired: false,
              event: updatedEvent,
              targetEvent,
            },
          });
        }
        const approval = await requireCalendarMutationGateway().modify({
          runtime,
          message,
          targetEvent,
          request: updateRequest,
        });
        return respond({
          success: true,
          text: approval.text,
          interaction: true,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "update_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: updateRequest,
            targetEvent,
            ...(updateRequest.recurrenceScope
              ? { recurrenceScope: updateRequest.recurrenceScope }
              : {}),
          },
        });
      }

      if (subaction === "delete_event") {
        const explicitEventId = detailString(details, "eventId");
        let targetEvent: LifeOpsCalendarEvent | null = null;
        const recurrenceScopeForDelete = resolveRecurrenceScopeIntent({
          details,
          text: `${messageText(message)} ${intent}`,
        });
        if (!explicitEventId) {
          // A structured deletion title identifies the target too; unlike an
          // update title, it cannot mean a requested rename. Keep explicit
          // query precedence and the existing unique-match checks below.
          const titleHint = searchQueries[0] ?? explicitTitle;
          if (!titleHint) {
            return respond({
              success: false,
              text: await renderReply(
                "clarify_delete_event_target",
                "Tell me which calendar event you want to delete by title, person, place, or date.",
                {
                  missing: ["target event"],
                },
              ),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                reason:
                  "The delete request did not identify a target, so no approval or calendar event was changed.",
              }),
            });
          }
          const feedRequest = plannerWindowUsable(details, llmPlan)
            ? resolveCalendarWindow(
                intent,
                details,
                true,
                llmPlan,
                planningTimeZone,
              ).request
            : {
                calendarId: calendarIdDetail(details),
                timeZone: planningTimeZone,
                ...buildWideLookupRange(planningTimeZone),
              };
          const feed = requireCompleteFreshCalendarFeed(
            await service.getCalendarFeed(INTERNAL_URL, {
              includeHiddenCalendars: true,
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              forceSync: true,
              ...feedRequest,
            }),
            "delete",
          );
          const candidates = resolveCalendarMutationCandidates({
            action: "delete",
            events: feed.events,
            titleHint,
            // An explicit `date` detail names the target's local day ahead of
            // any date phrase in the prose.
            texts: mutationTargetTexts({
              details,
              currentMessage: messageText(message),
              intent,
              timeZone: planningTimeZone,
            }),
            explicitDate: detailString(details, "date"),
            nonPlannerDateTexts: mutationTargetTexts({
              details,
              currentMessage: messageText(message),
              intent,
              timeZone: planningTimeZone,
              excludePlannerDate: true,
            }),
            timeZone: planningTimeZone,
          });
          if (candidates.length === 0) {
            const fallback = buildCalendarEventNotFoundFallback(
              "delete",
              titleHint,
            );
            return respond({
              success: false,
              text: await renderReply("delete_event_not_found", fallback, {
                titleHint: userReferenceLogView(titleHint),
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "No matching event was found, so no cancellation approval was created.",
              }),
            });
          }

          if (candidates.length > 1) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "delete",
              candidates,
              titleHint,
              timeZone: planningTimeZone,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_delete_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint: userReferenceLogView(titleHint),
                candidates,
              }),
              effectReceipt: calendarRequestNoopReceipt({
                message,
                operation: "calendar.event.delete",
                discriminator: userReferenceLogView(titleHint),
                reason:
                  "Multiple events matched the request, so no cancellation approval was created.",
              }),
            });
          }
          targetEvent = candidates[0] ?? null;
        } else {
          targetEvent = await service.getConditionalCalendarMutationTarget(
            INTERNAL_URL,
            {
              mode: connectorModeDetail(details),
              side: connectorSideDetail(details),
              grantId: connectorGrantIdDetail(details),
              calendarId: calendarIdDetail(details),
              eventId: explicitEventId,
            },
          );
        }
        if (!targetEvent) {
          return respond({
            success: false,
            text: await renderReply(
              "delete_event_not_found",
              "i couldn't find a unique event to delete.",
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.delete",
              reason:
                "A unique target could not be resolved, so no cancellation approval was created.",
            }),
          });
        }
        if (
          isRecurringCalendarEvent(targetEvent) &&
          !recurrenceScopeForDelete
        ) {
          const fallback = buildRecurrenceScopeClarification({
            action: "delete",
            event: targetEvent,
          });
          return respond({
            success: false,
            text: await renderReply(
              "clarify_delete_event_recurrence_scope",
              fallback,
              {
                event: targetEvent,
                recurrenceDescription: describeRecurrence(
                  recurrenceLinesFrom(targetEvent),
                ),
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.delete",
              discriminator: targetEvent.externalId,
              reason:
                "The recurrence scope was ambiguous, so no cancellation approval was created.",
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "delete_event",
              requiresInput: true,
              missing: ["recurrenceScope"],
              eventId: targetEvent.externalId,
            },
          });
        }
        const grantId = targetEvent.grantId?.trim();
        if (!grantId) {
          throw new CalendarServiceError(
            409,
            "Calendar cancellation is blocked because the target account binding is missing.",
            "CALENDAR_MUTATION_TARGET_BINDING_REQUIRED",
          );
        }
        const cancelRequest = {
          side: targetEvent.side,
          grantId,
          calendarId: targetEvent.calendarId,
          eventId: targetEvent.externalId,
          // The outer planner stuffs a junk recurrenceScope into every call;
          // a scope is only meaningful when the resolved target recurs.
          ...(recurrenceScopeForDelete && isRecurringCalendarEvent(targetEvent)
            ? { recurrenceScope: recurrenceScopeForDelete }
            : {}),
          notifyAttendees: shouldNotifyAttendees(details, targetEvent),
        };
        if (targetEvent.provider === ELIZA_CALENDAR_PROVIDER) {
          const expectedProviderVersion = targetEvent.metadata.etag;
          if (typeof expectedProviderVersion !== "string") {
            throw new CalendarServiceError(
              409,
              "The built-in calendar event is missing its version. Refresh and try again.",
              "ELIZA_CALENDAR_VERSION_REQUIRED",
            );
          }
          const idempotencyKey = localCalendarOperationKey({
            message,
            operation: "delete",
            payload: cancelRequest,
          });
          await service.deleteCalendarEvent(INTERNAL_URL, {
            ...cancelRequest,
            expectedProviderVersion,
            idempotencyKey,
          });
          const fallback = `Deleted “${targetEvent.title}” from your calendar.`;
          return respond({
            success: true,
            text: await renderReply("delete_event_completed", fallback, {
              event: targetEvent,
            }),
            effectReceipt: calendarEventMutationReceipt({
              event: targetEvent,
              idempotencyKey,
              operation: "calendar.event.delete",
              deleted: true,
            }),
            data: {
              actionName: "CALENDAR",
              subaction: "delete_event",
              approvalRequired: false,
              deleted: true,
              targetEvent,
            },
          });
        }
        const approval = await requireCalendarMutationGateway().cancel({
          runtime,
          message,
          targetEvent,
          request: cancelRequest,
        });
        return respond({
          success: true,
          text: approval.text,
          interaction: true,
          effectReceipt: calendarApprovalReceipt(approval),
          data: {
            actionName: "CALENDAR",
            subaction: "delete_event",
            approvalRequired: approval.state === "pending",
            approvalRequestId: approval.requestId,
            approvalState: approval.state,
            request: cancelRequest,
            targetEvent,
          },
        });
      }

      if (subaction === "trip_window" && tripWindowIntent) {
        const feed = await service.getCalendarFeed(INTERNAL_URL, {
          includeHiddenCalendars: true,
          mode: connectorModeDetail(details),
          side: connectorSideDetail(details),
          grantId: connectorGrantIdDetail(details),
          ...resolveTripWindowRequest(details, llmPlan, planningTimeZone),
        });
        const itineraryEvents = resolveTripWindowEvents(
          feed.events,
          tripWindowIntent.location,
        );
        if (!itineraryEvents || itineraryEvents.length === 0) {
          const fallback = `I couldn't find a clear trip window for ${tripWindowIntent.location} in your upcoming calendar.`;
          return respond({
            success: true,
            text: await renderReply("trip_window_not_found", fallback, {
              location: tripWindowIntent.location,
            }),
            effectReceipt: calendarFeedReadReceipt({
              feed,
              events: [],
              operation: "calendar.trip_window.read",
              discriminator: tripWindowIntent.location,
              reason:
                "The trip-window lookup completed without finding a matching itinerary and changed no calendar state.",
            }),
            data: toActionData({
              ...feed,
              location: tripWindowIntent.location,
              events: [],
            }),
          });
        }
        const fallback = formatTripWindowResults(
          itineraryEvents,
          tripWindowIntent.location,
        );
        return respond({
          success: true,
          text: await renderReply("trip_window_results", fallback, {
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
          effectReceipt: calendarFeedReadReceipt({
            feed,
            events: itineraryEvents,
            operation: "calendar.trip_window.read",
            discriminator: tripWindowIntent.location,
          }),
          data: toActionData({
            ...feed,
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
        });
      }

      // When the user explicitly asks for "all events" / "everything" / a
      // multi-year span, broaden the lookup window past the default
      // "today only" feed window. resolveCalendarWindow's default is too
      // narrow for these queries — without this branch, "show all my
      // events" returns "no events today" even when the calendar has
      // dozens of upcoming items. We apply this regardless of whether the
      // chat LLM picked feed or search_events because both subactions go
      const baseResolved = resolveCalendarWindow(
        intent,
        details,
        subaction === "search_events",
        llmPlan,
        planningTimeZone,
      );
      const request = baseResolved.request;
      const label = baseResolved.label;
      const hasExplicitWindow = baseResolved.explicitWindow;
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        includeHiddenCalendars:
          detailBoolean(details, "includeHiddenCalendars") ??
          subaction === "search_events",
        mode: connectorModeDetail(details),
        side: connectorSideDetail(details),
        grantId: connectorGrantIdDetail(details),
        ...request,
      });

      if (subaction === "search_events") {
        let queriesForSearch = searchQueries;
        const currentMessageText = messageText(message);
        if (queriesForSearch.length === 0) {
          if (!searchQueriesInferred) {
            queriesForSearch = await inferCalendarSearchQueriesWithLlm({
              runtime,
              message,
              state,
              intent,
            });
          }
          if (queriesForSearch.length === 0) {
            const groundedFromFeed = await groundCalendarSearchMatchesWithLlm(
              runtime,
              state,
              intent,
              [],
              buildCalendarGroundingCandidates(feed.events),
            );
            if (groundedFromFeed && groundedFromFeed.length > 0) {
              const groundedIdSet = new Set(groundedFromFeed);
              const filteredEvents = feed.events.filter((event) =>
                groundedIdSet.has(event.id),
              );
              // Echo the user's actual words, not the external-content
              // security envelope hardenIncomingUserMessage may have wrapped
              // around content.text; the raw text stays in currentMessageText
              // for the inference calls above/below.
              const queryFallback =
                unwrapUserMessageText(message) || intent || "your request";
              const fallback = formatCalendarSearchResults(
                filteredEvents,
                queryFallback,
                label,
              );
              return respond({
                success: true,
                text: await renderReply("search_results", fallback, {
                  query: userReferenceLogView(queryFallback),
                  queries: [],
                  events: filteredEvents,
                  label,
                }),
                effectReceipt: calendarFeedReadReceipt({
                  feed,
                  events: filteredEvents,
                  operation: "calendar.event.search",
                  discriminator: userReferenceLogView(queryFallback),
                }),
                data: toActionData({
                  ...feed,
                  query: userReferenceLogView(queryFallback),
                  queries: [],
                  events: filteredEvents,
                }),
              });
            }
            // The complete room transcript is only needed by this
            // disambiguation fallback; every other search read skipped an
            // unbounded room scan that nothing consumed.
            const recentConversation = (
              await collectRecentConversationTexts({
                runtime,
                message,
                state,
              })
            ).join("\n");
            const recoveredReadPlan = await disambiguateCalendarReadPlanWithLlm(
              {
                runtime,
                currentMessage: currentMessageText,
                intent,
                recentConversation,
                candidateSubaction: "search_events",
              },
            );
            if (recoveredReadPlan?.subaction === "feed") {
              const fallback = formatCalendarFeed(feed, label);
              return respond({
                success: true,
                text: await renderReply("feed_results", fallback, {
                  label,
                  events: feed.events,
                }),
                effectReceipt: calendarFeedReadReceipt({
                  feed,
                  operation: "calendar.feed.read",
                  discriminator: label,
                }),
                data: toActionData(feed),
              });
            }
          }
        }

        const query = queriesForSearch[0];
        if (!query || queriesForSearch.length === 0) {
          if (hasExplicitWindow) {
            const fallback = formatCalendarFeed(feed, label);
            return respond({
              success: true,
              text: await renderReply("feed_results", fallback, {
                label,
                events: feed.events,
              }),
              effectReceipt: calendarFeedReadReceipt({
                feed,
                operation: "calendar.feed.read",
                discriminator: label,
              }),
              data: toActionData(feed),
            });
          }
          return respond({
            success: false,
            text: await renderReply(
              "clarify_calendar_search",
              "I couldn't infer what to look for in your calendar yet. Try naming a person, place, trip, or date.",
              {
                missing: ["search target"],
              },
            ),
            effectReceipt: calendarRequestNoopReceipt({
              message,
              operation: "calendar.event.search",
              reason:
                "The search target remained ambiguous, so no calendar lookup result was claimed.",
            }),
          });
        }
        const rankedEvents: RankedCalendarSearchCandidate[] = feed.events
          .map((event) => {
            const matchedQueries: string[] = [];
            let score = 0;
            for (const candidateQuery of queriesForSearch) {
              const queryScore = scoreCalendarEvent(event, candidateQuery);
              if (queryScore > 0) {
                matchedQueries.push(candidateQuery);
                score += queryScore;
              }
            }
            if (matchedQueries.length > 1) {
              score += (matchedQueries.length - 1) * 12;
            }
            return { event, score, matchedQueries };
          })
          .filter(
            (candidate) =>
              candidate.score > 0 && candidate.matchedQueries.length > 0,
          )
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            const aTime = Date.parse(left.event.startAt);
            const bTime = Date.parse(right.event.startAt);
            const aSafe = Number.isFinite(aTime) ? aTime : 0;
            const bSafe = Number.isFinite(bTime) ? bTime : 0;
            return aSafe - bSafe;
          });
        const strongestScore = rankedEvents[0]?.score ?? 0;
        const strongestThreshold =
          strongestScore >= 30 ? Math.max(16, strongestScore - 12) : 1;
        let filteredEvents = rankedEvents
          .filter((candidate) => candidate.score >= strongestThreshold)
          .map((candidate) => candidate.event);
        if (shouldGroundCalendarSearchWithLlm(query, rankedEvents)) {
          const groundedIds = await groundCalendarSearchMatchesWithLlm(
            runtime,
            state,
            intent,
            queriesForSearch,
            rankedEvents,
          );
          if (groundedIds) {
            const groundedIdSet = new Set(groundedIds);
            filteredEvents = rankedEvents
              .filter((candidate) => groundedIdSet.has(candidate.event.id))
              .map((candidate) => candidate.event);
          }
        }
        if (filteredEvents.length === 0 && feed.events.length > 0) {
          const groundedIds = await groundCalendarSearchMatchesWithLlm(
            runtime,
            state,
            intent,
            queriesForSearch,
            rankedEvents.length > 0
              ? rankedEvents
              : buildCalendarGroundingCandidates(feed.events),
          );
          if (groundedIds && groundedIds.length > 0) {
            const groundedIdSet = new Set(groundedIds);
            filteredEvents = feed.events.filter((event) =>
              groundedIdSet.has(event.id),
            );
          }
        }
        const fallback = formatCalendarSearchResults(
          filteredEvents,
          query,
          label,
        );
        // queriesForSearch values are LLM-extracted and can be blobs; clamp
        // every machine-facing render while matching above kept the raw values.
        const queryViews = queriesForSearch.map((value) =>
          userReferenceLogView(value),
        );
        return respond({
          success: true,
          text: await renderReply("search_results", fallback, {
            query: userReferenceLogView(query),
            queries: queryViews,
            events: filteredEvents,
            label,
          }),
          effectReceipt: calendarFeedReadReceipt({
            feed,
            events: filteredEvents,
            operation: "calendar.event.search",
            discriminator: userReferenceLogView(JSON.stringify(queryViews)),
          }),
          data: toActionData({
            ...feed,
            query: userReferenceLogView(query),
            queries: queryViews,
            events: filteredEvents,
          }),
        });
      }

      const fallback = formatCalendarFeed(feed, label);
      return respond({
        success: true,
        text: await renderReply("feed_results", fallback, {
          label,
          events: feed.events,
        }),
        effectReceipt: calendarFeedReadReceipt({
          feed,
          operation: "calendar.feed.read",
          discriminator: label,
        }),
        data: toActionData(feed),
      });
    } catch (error) {
      if (error instanceof CalendarServiceError) {
        if (isAppleCalendarPermissionError(error)) {
          return respond({
            success: false,
            text: buildAppleCalendarPermissionRequestText(subaction),
            interaction: true,
            effectReceipt: calendarFailedReceipt({
              message,
              operation: `calendar.${subaction}`,
              code: error.code ?? "APPLE_CALENDAR_PERMISSION_REQUIRED",
              retryable: false,
            }),
          });
        }
        // The failure receipt carries only a code; without the service
        // error's message and the request hints the operator cannot see WHICH
        // validation or provider call rejected the turn (live 2026-08-09: a
        // swallowed "mode must be one of ..." surfaced only as
        // CALENDAR_SERVICE_400).
        runtime.reportError("calendar:action", error, {
          subaction: subaction ?? "none",
          status: error.status,
          code: error.code ?? `CALENDAR_SERVICE_${error.status}`,
          detail: error.message,
          // Raw, deliberately: this diagnostic exists to show the operator what
          // the planner actually authored. Reporting the sanitized values would
          // render a placeholder id or a reversed window as "unset" and delete
          // the evidence for the exact input class the sanitizers absorb, so
          // both are reported — raw for diagnosis, effective for what ran.
          calendarId: detailString(details, "calendarId") ?? "unset",
          effectiveCalendarId: calendarIdDetail(details) ?? "unset",
          timeMin: detailString(details, "timeMin") ?? "unset",
          timeMax: detailString(details, "timeMax") ?? "unset",
          effectiveWindow: plannerWindowDetail(details)
            ? `${plannerWindowDetail(details)?.timeMin}..${plannerWindowDetail(details)?.timeMax}`
            : "unset",
          timeZone: detailString(details, "timeZone") ?? "unset",
          mode: detailString(details, "mode") ?? "unset",
          side: detailString(details, "side") ?? "unset",
          grantId: detailString(details, "grantId") ?? "unset",
        });
        const fallback = buildCalendarServiceErrorFallback(error, intent);
        return respond({
          success: false,
          text: await renderReply("service_error", fallback, {
            status: error.status,
            subaction,
          }),
          effectReceipt: calendarFailedReceipt({
            message,
            operation: `calendar.${subaction}`,
            code: error.code ?? `CALENDAR_SERVICE_${error.status}`,
            retryable: error.status >= 500,
            acceptance:
              subaction === "create_event" ||
              subaction === "update_event" ||
              subaction === "delete_event"
                ? "unknown"
                : "rejected",
          }),
        });
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Calendar operation. Use feed for the full agenda or all events on a date or in a time range, including requests with no title or keyword filter. Use search_events only when the user supplies an event-content filter such as a title, attendee, location, or keyword; a date alone is a time bound, not a search phrase. Use next_event for the next upcoming event; create_event only when creating a new event.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "feed",
          "next_event",
          "search_events",
          "create_event",
          "update_event",
          "delete_event",
          "trip_window",
        ],
      },
    },
    {
      name: "intent",
      description:
        'Natural language calendar request, especially schedule or itinerary questions. Examples: "what is on my calendar today", "do i have any flights this week", "when do i fly back from denver", "create a meeting tomorrow at 3pm".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Title for create_event, replacement title for update_event, or existing title for delete_event. For an update target use query, details.oldTitle, or details.eventId; do not put the existing target here.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Event-content filter explicitly requested by the user, such as flight, dentist, Denver, or return flight. Never put dates, agenda, events, or schedule here just to express a time range. For an unfiltered day agenda use feed with details.timeMin/timeMax and omit query/queries.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional event-content filters for search_events. The action combines and deduplicates them. Omit for an unfiltered agenda; dates belong in details.timeMin/timeMax, not in search phrases.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "details",
      description:
        "Optional structured calendar fields such as time bounds, timezone, calendar id, create-event timing, location, attendees, " +
        "start/end datetimes must be RFC 3339 with a numeric offset matching timeZone (use Z only for UTC); " +
        'recurrence (RFC 5545 RRULE line(s) like "RRULE:FREQ=WEEKLY;BYDAY=MO" for repeating events), and recurrenceScope ' +
        '("instance" for one occurrence, "this_and_following" to split at the selected occurrence, "series" for the whole series).',
      required: false,
      schema: CALENDAR_DETAILS_PARAMETER_SCHEMA,
    },
    {
      // Planners habitually add a calendar-id field on feed/read calls (live:
      // top-level calendar_id AND calendarId on one CALENDAR_FEED call, which
      // validateToolArgs rejected and the whole read failed). Declare the
      // field so natural variants normalize here instead of erroring; reads
      // span the account's calendars and creation targets the built-in
      // calendar, so the value is advisory and the handler ignores it.
      name: "calendarId",
      aliases: ["calendar_id", "calendarid"],
      description:
        "Optional; leave unset. Agenda reads use the selected Calendar feed; searches cover connected calendars. Use details.includeHiddenCalendars to explicitly change that scope. Event creation targets the built-in calendar.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my calendar today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Events today:\n- **Team sync** (10:00 AM – 10:30 AM)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What is my next meeting?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Next event: Product review** (2:00 PM – 3:00 PM) — in 45 min",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What does my week look like?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "This week's calendar includes 4 events, starting with a dentist appointment on Tuesday at 3:00 PM.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Create a dentist appointment for tomorrow at 3pm." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "Dentist appointment" for tomorrow at 3:00 PM.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Put a 1:1 with Alex on my calendar Thursday at 10am for 30 minutes.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "1:1 with Alex" for Thursday at 10:00 AM for 30 minutes.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Need to book 1 hour per day for time with my partner. Any time is fine, ideally before sleep.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a recurring daily one-hour block, placed before your sleep window when possible.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Flag the conflict before my flight later and, if needed, help rebook the other thing.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll check the flight against your calendar, flag the conflict, and help move the other commitment if it collides.",
        },
      },
    ],
  ] as ActionExample[][],
};
