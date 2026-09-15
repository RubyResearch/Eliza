/**
 * Exercises the real planner-to-provider schema boundary. Calendar's operation
 * union must not turn absent travel fields (or their aliases) into required
 * strings that the planner has to invent just to satisfy the wire grammar.
 */
import type { Action, ActionParameterSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../packages/core/src/actions/promote-subactions.js";
import { buildPlannerToolsFromActions } from "../../../packages/core/src/actions/to-tool.js";
import {
  validateSchema,
  validateToolArgs,
} from "../../../packages/core/src/actions/validate-tool-args.js";
import { createCalendarActionRunner } from "../../plugin-calendar/src/actions/calendar-handler.js";
import { __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall } from "../../plugin-openai/models/text.js";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../src/actions/calendar.js";
import { resolveCreateEventTravelIntent } from "../src/travel-time/calendar-create.js";

const domainCalendarAction = createCalendarActionRunner({
  runTextModel: async () => null,
  runJsonModel: async () => null,
  recentConversationTexts: async () => [],
});

describe.each([
  ["personal-assistant calendar", calendarAction],
  ["domain calendar", domainCalendarAction],
] as const)("%s optional native arguments", (_name, parent) => {
  it.each([false, true])(
    "admits sparse calendar creates through the provider schema without weakening travel types (Cerebras: %s)",
    (cerebrasMode) => {
      const family = promoteSubactionsToActions(
        parent,
        parent === calendarAction ? calendarActionPromotionOptions : {},
      );
      expect(family.length).toBeGreaterThan(1);
      const create = family.find(
        (action) => action.name === "CALENDAR_CREATE_EVENT",
      );
      if (!create)
        throw new Error("calendar create operation was not promoted");
      const normalized = normalizeNativeToolsForCall(
        buildPlannerToolsFromActions(family),
        { cerebrasMode },
      ).tools;
      if (!normalized)
        throw new Error("calendar tool family was not normalized");
      const tool = normalized[create.name] as {
        strict?: boolean;
        inputSchema: { jsonSchema: ActionParameterSchema };
      };
      expect(tool.strict).toBe(cerebrasMode);
      const args = {
        title: "Pottery class",
        details: {
          start: "2026-09-11T16:00:00.000Z",
          end: "2026-09-11T17:00:00.000Z",
          timeZone: "UTC",
        },
      };
      for (const details of [
        args.details,
        { ...args.details, travelOriginAddress: "Studio" },
      ]) {
        const input = { ...args, details };
        const errors: string[] = [];
        validateSchema(tool.inputSchema.jsonSchema, input, "", errors);
        expect(errors).toEqual([]);
        expect(validateToolArgs(create, input)).toMatchObject({
          valid: true,
          args: input,
        });
      }
      const invalid = {
        ...args,
        details: { ...args.details, travelOriginAddress: false },
      };
      const errors: string[] = [];
      validateSchema(tool.inputSchema.jsonSchema, invalid, "", errors);
      expect(errors.length).toBeGreaterThan(0);
      expect(validateToolArgs(create, invalid).valid).toBe(false);
    },
  );

  it("accepts a typed title on the promoted delete child", () => {
    // Live 2026-09-05 23:32: CALENDAR_DELETE_EVENT rejected a top-level title
    // ("Unexpected argument 'title'") that the parent accepts, so a valid
    // structured delete failed before any lookup and the turn ended with a
    // false failure reply.
    const del = promoteSubactionsToActions(parent).find(
      (action) => action.name === "CALENDAR_DELETE_EVENT",
    ) as Action;
    expect(del).toBeDefined();
    const args = {
      title: "Pottery class",
      details: { date: "2026-09-05", timeZone: "UTC" },
    };
    expect(validateToolArgs(del, args)).toMatchObject({ valid: true, args });
  });

  it("accepts a sparse create call but still rejects invalid typed travel arguments", () => {
    const create = promoteSubactionsToActions(parent).find(
      (action) => action.name === "CALENDAR_CREATE_EVENT",
    ) as Action;
    expect(create).toBeDefined();
    const args = {
      title: "Unknown",
      details: {
        start: "2026-07-27T16:00:00.000Z",
        end: "2026-07-27T17:00:00.000Z",
        timeZone: "UTC",
      },
    };
    expect(validateToolArgs(create, args)).toMatchObject({ valid: true, args });
    expect(
      resolveCreateEventTravelIntent({
        details: args.details,
        extractedDetails: {},
      }),
    ).toBeNull();
    for (const literal of [
      "Unknown",
      "None",
      "n/a",
      "traveloriginaddress_missing",
    ]) {
      expect(
        resolveCreateEventTravelIntent({
          details: { ...args.details, travelOriginAddress: literal },
          extractedDetails: {},
        }),
      ).toEqual({ originAddress: literal });
    }
    expect(
      validateToolArgs(create, {
        ...args,
        details: { ...args.details, travelOriginAddress: false },
      }).valid,
    ).toBe(false);
  });
});

it("retains every calendar and timezone spelling for next-event reads and the complete parent contract", () => {
  const family = promoteSubactionsToActions(
    calendarAction,
    calendarActionPromotionOptions,
  );
  const next = family.find((action) => action.name === "CALENDAR_NEXT_EVENT");
  if (!next) throw new Error("Missing next-event action");
  for (const calendarKey of ["calendarId", "calendarid", "calendar_id"]) {
    for (const timezoneKey of ["timeZone", "timezone", "time_zone"]) {
      const args = {
        details: {
          [calendarKey]: "cal_actual",
          [timezoneKey]: "America/New_York",
        },
      };
      expect(validateToolArgs(next, args)).toMatchObject({ valid: true, args });
    }
  }
  expect(validateToolArgs(next, {}).valid).toBe(true);
  expect(validateToolArgs(next, { details: { timeZone: 7 } }).valid).toBe(
    false,
  );
  const readSchema = next.parameters?.find(
    (parameter) => parameter.name === "details",
  )?.schema;
  const parentSchema = family[0].parameters?.find(
    (parameter) => parameter.name === "details",
  )?.schema;
  expect(parentSchema?.properties?.recurrence).toBeDefined();
  expect(readSchema?.properties?.recurrence).toBeUndefined();
  expect(next.roleGate).toEqual(calendarAction.roleGate);
  expect(next.disclosureGate).toEqual(calendarAction.disclosureGate);
});

it.each(["feed", "search_events"])(
  "preserves %s read scope, range and aliases without mutation details",
  (operation) => {
    const family = promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    );
    const read = family.find(
      (action) => action.name === `CALENDAR_${operation.toUpperCase()}`,
    );
    if (!read) throw new Error("Missing read action");
    for (const suffix of [0, 1, 2]) {
      const details = {
        [["calendarId", "calendarid", "calendar_id"][suffix]]: "primary",
        [["timeMin", "timemin", "time_min"][suffix]]:
          "2026-09-13T00:00:00-04:00",
        [["timeMax", "timemax", "time_max"][suffix]]:
          "2026-09-14T00:00:00-04:00",
        [["timeZone", "timezone", "time_zone"][suffix]]: "America/New_York",
        [["forceSync", "forcesync", "force_sync"][suffix]]: true,
        [["windowDays", "windowdays", "window_days"][suffix]]: 60,
        mode: "local",
        side: "owner",
        grantId: "eliza-calendar",
        includeHiddenCalendars: false,
        label: "requested day",
      };
      expect(validateToolArgs(read, { details })).toMatchObject({
        valid: true,
        args: { details },
      });
    }
    expect(validateToolArgs(read, {}).valid).toBe(true);
    expect(
      validateToolArgs(read, { details: { includeHiddenCalendars: "true" } })
        .valid,
    ).toBe(false);
    expect(read.roleGate).toEqual(calendarAction.roleGate);
    expect(read.disclosureGate).toEqual(calendarAction.disclosureGate);
    const full = calendarAction.parameters?.find(
      (parameter) => parameter.name === "details",
    )?.schema;
    for (const action of family.filter((action) =>
      [
        "CALENDAR",
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
        "CALENDAR_TRIP_WINDOW",
      ].includes(action.name),
    )) {
      expect(
        action.parameters?.find((parameter) => parameter.name === "details")
          ?.schema,
      ).toEqual(full);
    }
    if (operation === "search_events") {
      for (const key of ["query", "oldTitle", "oldtitle", "old_title"]) {
        expect(
          validateToolArgs(read, { details: { [key]: "Dentist" } }).valid,
        ).toBe(true);
      }
      expect(
        validateToolArgs(read, {
          query: "Dentist",
          queries: ["Dentist"],
          details: { queries: ["Dentist"] },
        }).valid,
      ).toBe(true);
    }
  },
);
