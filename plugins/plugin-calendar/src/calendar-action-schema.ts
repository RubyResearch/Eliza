/**
 * Leaf metadata for CALENDAR's nested planner arguments. Both the calendar
 * action and its PA host wrapper import this module directly so action-schema
 * construction cannot depend on either plugin's runtime registration cycle.
 *
 * Two surfaces live here, kept apart on purpose:
 *
 * - CALENDAR_DETAILS_PARAMETER_SCHEMA is what the planner SEES: one canonical
 *   key per concept with a short imperative description. Live 2026-09-13 the
 *   previous 99-key surface (every camel/snake/lower spelling of every field
 *   plus connector control flags) rendered ~10.7k characters per planner call
 *   and the 27B planner filled most of it with debris: "4pm" as location,
 *   neighbouring key names as values ("grantId" in departure_address), a
 *   placeholder guest with notifyAttendees on a built-in event.
 * - CALENDAR_DETAIL_ALIASES is what the handler ACCEPTS: the historical
 *   spellings, folded onto their canonical key by normalizeCalendarDetails in
 *   actions/calendar-handler.ts for direct callers, replayed requests and the
 *   calendar's own extractor output. Core's validateToolArgs closes the
 *   details object, so an alias is never added back to the planner schema: a
 *   planner that still emits one gets `Unexpected argument 'details.<alias>'`
 *   and the planner loop retries with the declared key.
 */

import type { ActionParameterSchema } from "@elizaos/core";

/**
 * Handler-canonical detail key to accepted alternate spellings. Lookup is
 * case- and separator-insensitive (normalizeLookupKey), so `start_time`,
 * `startTime` and `STARTTIME` all fold onto `startAt`. `start`/`end` are the
 * planner-facing names; `startAt`/`endAt` remain the handler's own.
 */
export const CALENDAR_DETAIL_ALIASES = {
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

// Live 2026-09-05 the planner rendered "tuesday at 7am" as a fabricated UTC
// instant ("2026-09-08T07:00:00Z") for a Pacific owner; the runtime applies
// the owner's zone to offset-less values, so every wall-clock leaf says so.
const LOCAL_WALL_TIME =
  "local wall-clock YYYY-MM-DDTHH:mm:ss with no Z and no UTC offset, read in timeZone";

function text(description: string): ActionParameterSchema {
  return { type: "string", description };
}

function flag(description: string): ActionParameterSchema {
  return { type: "boolean", description };
}

/**
 * Planner-facing detail keys, one per concept. Every key is either read by
 * the handler under this name or folded onto its handler-canonical name by
 * CALENDAR_DETAIL_ALIASES (start -> startAt, end -> endAt). Connector control
 * keys the planner never filled correctly (mode, label, windowDays,
 * windowPreset, forceSync, queries) stay handler-readable but are not offered.
 */
const CALENDAR_PLANNER_DETAIL_PROPERTIES: Record<
  string,
  ActionParameterSchema
> = {
  calendarId: text(
    "Optional. Only an exact calendarId copied from a Calendar result. Never invent one or derive it from a title.",
  ),
  grantId: text(
    "Optional. Only the grantId copied from the Calendar result row of the target event. Omit otherwise.",
  ),
  side: text(
    "Optional. owner or agent, only when copied from a Calendar result. Omit otherwise.",
  ),
  timeMin: text(`Window start for feed/search_events as ${LOCAL_WALL_TIME}.`),
  timeMax: text("Window end (exclusive), same format as timeMin."),
  timeZone: text(
    "IANA zone for every wall-clock value here (e.g. America/New_York). Use the user's configured zone unless they name another. Include it on updates.",
  ),
  includeHiddenCalendars: flag(
    "Set true only when the user explicitly asks to include hidden or all connected calendars.",
  ),
  eventId: text(
    "update_event/delete_event only: the exact externalId from a Calendar result. Omit for create_event. Never invent one or derive it from a title; use query or oldTitle plus date instead.",
  ),
  date: text(
    "Local date YYYY-MM-DD that the TARGET event is on now, for update_event/delete_event lookups when the user names that day. Never the destination day of a move (that goes in start/end). Omit for create_event.",
  ),
  query: text(
    "Words identifying the existing target event for update_event/delete_event when eventId is unknown.",
  ),
  title: text(
    "Event title for create_event (same as the top-level title). Never a lookup selector; a rename goes in newTitle.",
  ),
  oldTitle: text(
    "Existing title used to locate the update_event target; never the new name.",
  ),
  newTitle: text(
    "Replacement title for update_event only; never a lookup selector.",
  ),
  start: text(
    `Event start as ${LOCAL_WALL_TIME}. Required for create_event; the new start for a move or reschedule.`,
  ),
  end: text("Event end, same format as start. Omit to use durationMinutes."),
  durationMinutes: {
    type: "number",
    description: "Event length in minutes when end is omitted.",
  },
  description: text(
    "New description only when the user gives one. On updates omit unchanged fields; to remove it use clearFields, not an empty string.",
  ),
  location: text(
    "Place or address only when the user names one; never a time, day or date. On updates omit unchanged fields; to remove it use clearFields.",
  ),
  clearFields: {
    type: "array",
    items: { type: "string", enum: ["description", "location"] },
    description:
      "update_event only: fields the user explicitly asks to remove. Omit otherwise. Never combine with a replacement value for the same field.",
  },
  // A single RRULE string or an array of RFC 5545 lines; `anyOf` rather than
  // `oneOf` because strict provider grammars (Cerebras) reject `oneOf`.
  recurrence: {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    description:
      "RFC 5545 RRULE line(s) such as RRULE:FREQ=WEEKLY;BYDAY=MO, only when the user asks for a repeating event. Omit for single events.",
  },
  recurrenceScope: text(
    "Recurring target only: instance (this occurrence), this_and_following, or series. Omit when the user did not say.",
  ),
  attendees: {
    type: "array",
    items: { type: "string" },
    description:
      "Guest email addresses the user explicitly names. Omit otherwise; never invent one or use a placeholder.",
  },
  notifyAttendees: flag(
    "Set true only when the user explicitly asks to notify or email the guests.",
  ),
  allowPast: flag(
    "Set true only when the user explicitly wants an event at a time that already passed, or confirmed it after being asked.",
  ),
  travelOriginAddress: text(
    "Departure address only when the user asks for travel time from a named place. Omit otherwise.",
  ),
};

/** The exact key set the planner is offered, in schema order. */
export const CALENDAR_PLANNER_DETAIL_KEYS: readonly string[] = Object.freeze(
  Object.keys(CALENDAR_PLANNER_DETAIL_PROPERTIES),
);

export const CALENDAR_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema = {
  type: "object",
  properties: CALENDAR_PLANNER_DETAIL_PROPERTIES,
  additionalProperties: false,
};

/** The next-event reader consumes only calendar selection and timezone.
 * Keep every accepted spelling of those fields; mutation and range arguments
 * remain on the complete CALENDAR contract and their corresponding operations. */
export const CALENDAR_NEXT_EVENT_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema =
  {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(CALENDAR_DETAILS_PARAMETER_SCHEMA.properties ?? {}).filter(
        ([key]) =>
          [
            "calendarId",
            "calendarid",
            "calendar_id",
            "timeZone",
            "timezone",
            "time_zone",
          ].includes(key),
      ),
    ),
    additionalProperties: false,
  };

// Feed/search consume the same window and connector scope. Keep every accepted
// spelling; event edits, recurrence and travel creation belong to other actions.
const CALENDAR_READ_DETAIL_KEYS = [
  "calendarId",
  "calendarid",
  "calendar_id",
  "timeMin",
  "timemin",
  "time_min",
  "timeMax",
  "timemax",
  "time_max",
  "timeZone",
  "timezone",
  "time_zone",
  "forceSync",
  "forcesync",
  "force_sync",
  "windowDays",
  "windowdays",
  "window_days",
  "label",
  "mode",
  "side",
  "grantId",
  "includeHiddenCalendars",
] as const;

export const CALENDAR_FEED_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(CALENDAR_DETAILS_PARAMETER_SCHEMA.properties ?? {}).filter(
      ([key]) => CALENDAR_READ_DETAIL_KEYS.some((name) => name === key),
    ),
  ),
  additionalProperties: false,
};

export const CALENDAR_SEARCH_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema = {
  type: "object",
  properties: {
    ...CALENDAR_FEED_DETAILS_PARAMETER_SCHEMA.properties,
    ...Object.fromEntries(
      Object.entries(CALENDAR_DETAILS_PARAMETER_SCHEMA.properties ?? {}).filter(
        ([key]) =>
          ["query", "queries", "oldTitle", "oldtitle", "old_title"].includes(
            key,
          ),
      ),
    ),
  },
  additionalProperties: false,
};
