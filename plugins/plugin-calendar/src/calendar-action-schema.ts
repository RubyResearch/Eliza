/**
 * Leaf metadata for CALENDAR's nested planner arguments. Both the calendar
 * action and its PA host wrapper import this module directly so action-schema
 * construction cannot depend on either plugin's runtime registration cycle.
 */

import type { ActionParameterSchema } from "@elizaos/core";

const CALENDAR_DETAIL_STRING_KEYS = [
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
  "windowPreset",
  "windowpreset",
  "window_preset",
  "eventId",
  "eventid",
  "event_id",
  "externaleventid",
  "external_event_id",
  "googleeventid",
  "google_event_id",
  "startAt",
  "startat",
  "start_at",
  "start",
  "start_time",
  "startTime",
  "starttime",
  "endAt",
  "endat",
  "end_at",
  "end",
  "end_time",
  "endTime",
  "endtime",
  "newTitle",
  "newtitle",
  "new_title",
  "renameto",
  "rename_to",
  "oldTitle",
  "oldtitle",
  "old_title",
  "title",
  "date",
  "query",
  "label",
  "description",
  "desc",
  "summary",
  "body",
  "location",
  "place",
  "venue",
  "mode",
  "side",
  "grantId",
  "recurrenceScope",
  "recurrencescope",
  "recurrence_scope",
  "applyto",
  "apply_to",
  "editscope",
  "edit_scope",
  "travelOriginAddress",
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
] as const;

const CALENDAR_DETAIL_NUMBER_KEYS = [
  "durationMinutes",
  "durationminutes",
  "duration_minutes",
  "windowDays",
  "windowdays",
  "window_days",
] as const;

const CALENDAR_DETAIL_BOOLEAN_KEYS = [
  "forceSync",
  "forcesync",
  "force_sync",
  "notifyAttendees",
  "allowPast",
  "includeHiddenCalendars",
] as const;

const CALENDAR_DETAIL_RECURRENCE_KEYS = [
  "recurrence",
  "rrule",
  "recurrencerule",
  "recurrence_rule",
  "repeat",
  "repeats",
  "repeatrule",
  "repeat_rule",
] as const;

const stringSchema: ActionParameterSchema = { type: "string" };
// Planner-facing guidance for the timestamp leaves. Live 2026-09-05 the
// planner rendered "tuesday at 7am" as "2026-09-08T07:00:00Z" (a fabricated
// UTC instant) and day bounds as "2026-09-08T00:00:00Z".."23:59:59Z" for a
// Pacific owner; the runtime applies the owner's zone to offset-less values.
const LOCAL_WALL_TIME_FORMAT =
  "local wall-clock time formatted YYYY-MM-DDTHH:mm:ss with NO trailing Z and NO UTC offset, paired with the intended IANA timeZone (normally the user's configured timezone); never fabricate a UTC instant";
const CALENDAR_ID_DESCRIPTION =
  "Optional; omit unless selecting an exact calendarId from a Calendar result. New events use the built-in calendar by default. Never invent a calendar ID or derive one from an event title.";
const EVENT_ID_DESCRIPTION =
  "For update_event/delete_event only: the exact externalId from a Calendar result. Omit for create_event. Never invent an event ID or derive it from a title; use query and date to find an existing event when its ID is unknown.";
const CALENDAR_DETAIL_STRING_DESCRIPTIONS: Partial<
  Record<(typeof CALENDAR_DETAIL_STRING_KEYS)[number], string>
> = {
  ...Object.fromEntries(
    ["calendarId", "calendarid", "calendar_id"].map((key) => [
      key,
      CALENDAR_ID_DESCRIPTION,
    ]),
  ),
  ...Object.fromEntries(
    [
      "eventId",
      "eventid",
      "event_id",
      "externaleventid",
      "external_event_id",
      "googleeventid",
      "google_event_id",
    ].map((key) => [key, EVENT_ID_DESCRIPTION]),
  ),
  description:
    "New description only when the user changes it. For updates, omit unchanged fields; to remove the description explicitly, use clearFields instead of an empty string.",
  location:
    "New location only when the user changes it. For updates, omit unchanged fields; to remove the location explicitly, use clearFields instead of an empty string.",
  startAt: `Event start as ${LOCAL_WALL_TIME_FORMAT}.`,
  start: `Event start as ${LOCAL_WALL_TIME_FORMAT}.`,
  endAt:
    "Event end in the same local wall-clock format as startAt; omit it to use durationMinutes.",
  end: "Event end in the same local wall-clock format as start; omit it to use durationMinutes.",
  timeMin: `Window start as ${LOCAL_WALL_TIME_FORMAT}, or RFC 3339 with an explicit numeric offset.`,
  timeMax: "Window end (exclusive) in the same format as timeMin.",
  timeZone:
    "IANA timezone for the supplied wall-clock times (e.g. America/New_York): use the user's configured timezone unless they name another. Include it for updates so an existing event's different timezone does not reinterpret the requested new time.",
  date: "Local calendar date YYYY-MM-DD that the TARGET event is on NOW, for update_event/delete_event lookups when the user named that current day. Never the destination day of a move or reschedule: the new time belongs in start/startAt (and end/endAt). A bare weekday name means its next upcoming occurrence from today, never a past date; when the user did not name the target's current day, omit date and let query locate the event. Use start/startAt, not date, for create_event.",
  oldTitle:
    "Existing event title to locate for update_event; keep separate from the replacement title in newTitle.",
  newTitle:
    "Replacement event title for update_event, never a lookup selector. Identify the existing event with query, oldTitle, or eventId.",
  eventId:
    "Existing provider event ID from the externalId field returned by the calendar feed or search, not the feed row's composite id; takes precedence over title or query lookup for update_event/delete_event.",
};
const CALENDAR_DETAIL_BOOLEAN_DESCRIPTIONS: Partial<
  Record<(typeof CALENDAR_DETAIL_BOOLEAN_KEYS)[number], string>
> = {
  includeHiddenCalendars:
    "Agenda/feed reads default to the calendars selected in the Calendar view. Set true only when explicitly asked to include hidden or all connected calendars. Event searches include hidden calendars by default; set false to search only the selected feed. Hidden search results are not necessarily visible in the Calendar view.",
  allowPast:
    "Set true only when the user explicitly wants an event at a time that has already passed (recording a past event, or confirming the past time after being asked); otherwise omit it and the action asks before creating in the past.",
};
const numberSchema: ActionParameterSchema = { type: "number" };
const booleanSchema: ActionParameterSchema = { type: "boolean" };
// The runtime normalizer (internal/recurrence.ts) accepts a single RRULE
// string or an array of RFC 5545 lines, so the schema offers both branches.
// `anyOf` rather than `oneOf`: strict-mode provider grammars (Cerebras)
// reject `oneOf`, and a sibling `type` would contradict the array branch.
const recurrenceSchema: ActionParameterSchema = {
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
};

export const CALENDAR_DETAILS_PARAMETER_SCHEMA: ActionParameterSchema = {
  type: "object",
  properties: {
    clearFields: {
      type: "array",
      items: { type: "string", enum: ["description", "location"] },
      description:
        "For update_event only: fields the user explicitly requests to remove. Omit for unchanged or unknown fields. Do not include a field that also has a replacement value. Title, timing and recurrence cannot be cleared this way.",
    },
    ...Object.fromEntries(
      CALENDAR_DETAIL_STRING_KEYS.map((key) => {
        const description = CALENDAR_DETAIL_STRING_DESCRIPTIONS[key];
        return [
          key,
          description ? { ...stringSchema, description } : stringSchema,
        ];
      }),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_NUMBER_KEYS.map((key) => [key, numberSchema]),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_BOOLEAN_KEYS.map((key) => {
        const description = CALENDAR_DETAIL_BOOLEAN_DESCRIPTIONS[key];
        return [
          key,
          description ? { ...booleanSchema, description } : booleanSchema,
        ];
      }),
    ),
    ...Object.fromEntries(
      CALENDAR_DETAIL_RECURRENCE_KEYS.map((key) => [key, recurrenceSchema]),
    ),
    queries: {
      type: "array",
      items: { type: "string" },
    },
    attendees: {
      type: "array",
      items: {
        type: "object",
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              email: { type: "string" },
              displayName: { type: "string" },
              optional: { type: "boolean" },
            },
            required: ["email"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
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
