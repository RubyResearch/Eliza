/**
 * Pins the planner-facing shape of CALENDAR's `details` argument against the
 * handler's alias tolerance. Live 2026-09-13: the 99-key schema (every
 * spelling of every field plus connector control flags) rendered ~10.7k
 * characters per planner call and the 27B planner smeared debris across it
 * ("4pm" as location, neighbouring key names as values, placeholder guests).
 * The planner now sees one canonical key per concept; the older spellings
 * stay accepted by normalizeCalendarDetails for direct callers and replayed
 * requests. Deterministic unit suite over the exported runner: no runtime,
 * no network.
 */
import { describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../packages/core/src/actions/validate-tool-args";
import {
  createCalendarActionRunner,
  normalizeCalendarDetails,
} from "./actions/calendar-handler";
import type { CalendarActionDeps } from "./actions/deps";
import {
  CALENDAR_DETAIL_ALIASES,
  CALENDAR_DETAILS_PARAMETER_SCHEMA,
  CALENDAR_PLANNER_DETAIL_KEYS,
} from "./calendar-action-schema";

/** Hard ceiling on the planner-facing surface; the 2026-09-13 audit found 99. */
const MAX_PLANNER_DETAIL_KEYS = 25;

/** Keys the planner only ever filled with debris; handler-readable, not offered. */
const WITHDRAWN_CONTROL_KEYS = [
  "mode",
  "label",
  "windowDays",
  "windowPreset",
  "forceSync",
  "queries",
];

function foldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deps(): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    mutationGateway: {
      schedule: vi.fn(),
      modify: vi.fn(),
      cancel: vi.fn(),
    },
  } as unknown as CalendarActionDeps;
}

describe("CALENDAR details planner schema", () => {
  it("offers one canonical key per concept and no alternate spellings", () => {
    const exposed = Object.keys(
      CALENDAR_DETAILS_PARAMETER_SCHEMA.properties ?? {},
    );
    expect(exposed).toEqual([...CALENDAR_PLANNER_DETAIL_KEYS]);
    expect(exposed.length).toBeLessThanOrEqual(MAX_PLANNER_DETAIL_KEYS);
    expect(CALENDAR_DETAILS_PARAMETER_SCHEMA.additionalProperties).toBe(false);
    // No two offered keys differ only by case or separators.
    expect(new Set(exposed.map(foldKey)).size).toBe(exposed.length);
    // Of every alias family at most one spelling is offered, and when one is
    // (start for startAt, end for endAt) the handler's own name is not.
    for (const [canonical, spellings] of Object.entries(
      CALENDAR_DETAIL_ALIASES,
    )) {
      const offered = spellings.filter((alias) => exposed.includes(alias));
      expect(offered.length, canonical).toBeLessThanOrEqual(1);
      if (offered.length === 1) {
        expect(exposed, canonical).not.toContain(canonical);
      }
    }
    expect(exposed).toEqual(expect.arrayContaining(["start", "end"]));
    expect(exposed).not.toContain("startAt");
    expect(exposed).not.toContain("endAt");
    for (const key of WITHDRAWN_CONTROL_KEYS) {
      expect(exposed).not.toContain(key);
    }
  });

  it("keeps every offered key reachable by the handler", () => {
    const canonical = new Set(Object.keys(CALENDAR_DETAIL_ALIASES));
    const aliasToCanonical = new Map<string, string>();
    for (const [name, spellings] of Object.entries(CALENDAR_DETAIL_ALIASES)) {
      for (const alias of spellings) aliasToCanonical.set(alias, name);
    }
    for (const key of CALENDAR_PLANNER_DETAIL_KEYS) {
      const target = aliasToCanonical.get(key) ?? key;
      const normalized = normalizeCalendarDetails({ [key]: "value" });
      expect(normalized?.[target], key).toBe("value");
      if (aliasToCanonical.has(key)) {
        expect(canonical.has(target), key).toBe(true);
      }
    }
  });

  it("folds every accepted alias onto its handler-canonical key", () => {
    for (const [canonical, spellings] of Object.entries(
      CALENDAR_DETAIL_ALIASES,
    )) {
      for (const alias of spellings) {
        const normalized = normalizeCalendarDetails({ [alias]: "value" });
        expect(normalized?.[canonical], `${alias} -> ${canonical}`).toBe(
          "value",
        );
        const shouted = normalizeCalendarDetails({
          [alias.toUpperCase()]: "value",
        });
        expect(
          shouted?.[canonical],
          `${alias.toUpperCase()} -> ${canonical}`,
        ).toBe("value");
      }
    }
    // A canonical value already present wins over an alias beside it.
    expect(
      normalizeCalendarDetails({ startAt: "canonical", start_time: "alias" })
        ?.startAt,
    ).toBe("canonical");
  });

  it("accepts canonical create, update and delete arguments at the validation boundary", () => {
    const action = createCalendarActionRunner(deps());
    const create = {
      subaction: "create_event",
      title: "Dentist",
      details: {
        start: "2026-09-18T15:00:00",
        end: "2026-09-18T16:00:00",
        timeZone: "America/New_York",
        location: "4 Pine St",
        description: "bring the insurance card",
        attendees: ["ron@example.org"],
        recurrence: "RRULE:FREQ=WEEKLY;BYDAY=FR",
        allowPast: false,
      },
    };
    const update = {
      subaction: "update_event",
      query: "piano lesson",
      details: {
        eventId: "event-abc123",
        date: "2026-09-17",
        start: "2026-09-18T18:00:00",
        durationMinutes: 45,
        timeZone: "America/New_York",
        newTitle: "Piano lesson (moved)",
        clearFields: ["location"],
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
        recurrenceScope: "this_and_following",
        notifyAttendees: true,
      },
    };
    const remove = {
      subaction: "delete_event",
      details: {
        oldTitle: "Tailor appointment",
        date: "2026-09-18",
        timeZone: "UTC",
        includeHiddenCalendars: true,
        recurrenceScope: "instance",
      },
    };
    for (const args of [create, update, remove]) {
      const result = validateToolArgs(action, args);
      expect(result.errors, args.subaction).toEqual([]);
      expect(result.valid, args.subaction).toBe(true);
      expect(result.args, args.subaction).toEqual(args);
    }
  });

  it("names an alias spelling as the unexpected details argument so the planner can correct it", () => {
    // Core closes the details object: an older planner output that still
    // says start_time is rejected with the offending path (the planner loop's
    // correction retry), while direct callers keep the alias fold below.
    const action = createCalendarActionRunner(deps());
    const result = validateToolArgs(action, {
      subaction: "create_event",
      title: "Dentist",
      details: { start_time: "2026-09-18T15:00:00", timeZone: "UTC" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toContain("details.start_time");
    expect(
      normalizeCalendarDetails({ start_time: "2026-09-18T15:00:00" })?.startAt,
    ).toBe("2026-09-18T15:00:00");
  });
});
