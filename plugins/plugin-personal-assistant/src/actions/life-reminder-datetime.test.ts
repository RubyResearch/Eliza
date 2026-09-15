/**
 * Reminder datetime + snooze-duration pipeline tests (#10721 #10723).
 *
 * Guards the four P0 fixes:
 *  1. one-off reminders resolve their extracted date/weekday/offset against
 *     the owner timezone instead of fabricating dueAt=now;
 *  2. an unresolvable (or absent) time expression yields NO cadence so the
 *     handler asks "when?" instead of scheduling an immediate fire;
 *  3. rescheduling a one-off actually moves the stored dueAt (and reports
 *     honestly when nothing changed), while a time-only edit preserves the
 *     stored zoned local date;
 *  4. LLM-extracted snooze minutes/presets and top-level `minutes` params
 *     reach the snooze handler instead of being discarded.
 */

import * as agent from "@elizaos/agent";
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import { getZonedDateParts } from "../lifeops/time.js";
import type { ExtractedTaskParams } from "./lib/extract-task-plan.js";
import {
  isLifeSaveRetraction,
  readRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";
import {
  textContradictsExplicitUndatedTodo,
  textStatesExplicitUndatedTodo,
} from "./lib/undated-todo-intent.js";
import {
  applyLeadUpReminderShape,
  buildCadenceFromLlmParams,
  buildCadenceFromUpdateFields,
  formatLeadOffsetPhrase,
  parseMilestoneListFromIntent,
  reminderStepMinutesBeforeDue,
  resolveDefinitionFromIntent,
  resolveOnceDueAt,
  runLifeConnectedQuery,
  runLifeOperationHandler,
  wantsEarlierReminderNudge,
} from "./life.js";

const serviceState = vi.hoisted(() => ({
  snoozeCalls: [] as Array<{
    id: string;
    request: { preset?: string; minutes?: number };
  }>,
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{
    id: string;
    request: Record<string, unknown>;
  }>,
  extraDefinitions: [] as Array<Record<string, unknown>>,
  goalCreateCalls: [] as Array<Record<string, unknown>>,
  deleteDefinitionCalls: [] as string[],
  deleteGoalCalls: [] as string[],
  ownerEntityIds: [] as Array<string | undefined>,
}));

vi.mock("../lifeops/service.js", () => {
  class LifeOpsServiceError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  class LifeOpsService {
    private readonly ownerEntityIdValue: string;

    constructor(_runtime: IAgentRuntime, options?: { ownerEntityId?: string }) {
      serviceState.ownerEntityIds.push(options?.ownerEntityId);
      this.ownerEntityIdValue = options?.ownerEntityId ?? "owner-test";
    }

    agentId() {
      return "agent-test";
    }

    ownerEntityId() {
      return this.ownerEntityIdValue;
    }

    repository = {
      listAuditEvents: async (
        _agentId: string,
        ownerType: string,
        ownerId: string,
      ) => {
        const deleted =
          ownerType === "goal"
            ? serviceState.deleteGoalCalls.includes(ownerId)
            : serviceState.deleteDefinitionCalls.includes(ownerId);
        return [
          {
            id: `audit-${ownerType}-${ownerId}`,
            eventType: deleted
              ? `${ownerType}_deleted`
              : ownerType === "goal"
                ? "goal_created"
                : serviceState.updateCalls.some((entry) => entry.id === ownerId)
                  ? "definition_updated"
                  : "definition_created",
            ownerType,
            ownerId,
            decision: {},
            createdAt: "2026-07-01T18:00:00.000Z",
          },
        ];
      },
    };

    async getOverview() {
      return {
        owner: {
          summary: "1 item",
          occurrences: [
            {
              id: "occ-1",
              title: "workout",
              state: "visible",
              domain: "user_lifeops",
              dueAt: null,
              windowName: null,
            },
          ],
          goals: [],
        },
        agentOps: { occurrences: [], goals: [] },
      };
    }
    async snoozeOccurrence(
      id: string,
      request: { preset?: string; minutes?: number },
    ) {
      serviceState.snoozeCalls.push({ id, request });
      return { id, title: "workout" };
    }
    async createDefinition(request: Record<string, unknown>) {
      serviceState.createCalls.push(request);
      return {
        definition: {
          id: `def-created-${serviceState.createCalls.length}`,
          title: request.title,
          cadence: request.cadence,
          status: "active",
        },
        reminderPlan: request.reminderPlan ?? null,
      };
    }
    async updateDefinition(id: string, request: Record<string, unknown>) {
      serviceState.updateCalls.push({ id, request });
      const current = serviceState.extraDefinitions.find(
        (entry) => (entry.definition as { id?: string } | undefined)?.id === id,
      )?.definition as Record<string, unknown> | undefined;
      return {
        definition: {
          ...current,
          ...request,
          id,
          windowPolicy: request.windowPolicy ??
            current?.windowPolicy ?? {
              timezone: request.timezone ?? current?.timezone ?? "UTC",
              windows: [],
            },
        },
      };
    }
    async createGoal(request: Record<string, unknown>) {
      serviceState.goalCreateCalls.push(request);
      return {
        goal: {
          id: "goal-created",
          title: request.title,
          description: request.description,
          cadence: request.cadence ?? null,
          supportStrategy: request.supportStrategy ?? {},
          successCriteria: request.successCriteria ?? {},
          status: "active",
          reviewState: "idle",
          metadata: request.metadata ?? {},
        },
        links: [],
      };
    }
    async buildGoalExperienceLoop() {
      return {
        cadence: null,
        matches: [],
        summary: null,
      };
    }
    async listDefinitions() {
      // The caller-subject filter in life.ts requires each definition to be
      // bound to the resolving owner; stamp the default subject unless a test
      // deliberately supplies a foreign one.
      return [
        {
          definition: {
            id: "def-1",
            title: "workout",
            domain: "user_lifeops",
            subjectType: "owner",
            subjectId: this.ownerEntityIdValue,
          },
        },
        ...serviceState.extraDefinitions.map((entry) => ({
          ...entry,
          definition: {
            subjectType: "owner",
            subjectId: this.ownerEntityIdValue,
            ...(entry.definition as Record<string, unknown>),
          },
        })),
      ];
    }
    async listGoals() {
      return [
        {
          goal: {
            id: "goal-1",
            title: "marathon",
            domain: "user_lifeops",
          },
        },
      ];
    }
    async reviewGoalsForWeek() {
      return { summary: { totalGoals: 0 }, goals: [] };
    }
    async deleteDefinition(id: string) {
      serviceState.deleteDefinitionCalls.push(id);
    }
    async deleteGoal(id: string) {
      serviceState.deleteGoalCalls.push(id);
    }
  }
  return { LifeOpsService, LifeOpsServiceError };
});

// Wednesday 2026-07-01 12:00 in America/Denver (MDT, UTC-6).
const NOW = new Date("2026-07-01T18:00:00Z");
const DENVER = "America/Denver";

function makeParams(
  overrides: Partial<ExtractedTaskParams>,
): ExtractedTaskParams {
  return {
    requestKind: null,
    title: null,
    description: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    quotaTargetCount: null,
    quotaUnit: null,
    perOccurrenceWork: null,
    checkInRequested: null,
    checkInWindows: null,
    timesPerDay: null,
    priority: null,
    durationMinutes: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    multiStep: false,
    ...overrides,
  };
}

describe("resolveOnceDueAt", () => {
  const base = {
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    timeOfDayMinute: null,
    now: NOW,
    timeZone: DENVER,
  };

  it('resolves "friday at 5pm" to the upcoming Friday 17:00 owner-tz', () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 5,
      timeOfDayMinute: 17 * 60,
    });
    expect(dueAt).toBe("2026-07-03T23:00:00.000Z");
  });

  it('resolves "in 2 hours" to now + 120 minutes', () => {
    const dueAt = resolveOnceDueAt({ ...base, dueInMinutes: 120 });
    expect(dueAt).toBe("2026-07-01T20:00:00.000Z");
  });

  it('resolves "tomorrow" without a clock time to 9:00 AM owner-tz', () => {
    const dueAt = resolveOnceDueAt({ ...base, dueInDays: 1 });
    expect(dueAt).toBe("2026-07-02T15:00:00.000Z");
  });

  it("resolves an absolute date across a DST boundary", () => {
    // Dec 24 in Denver is MST (UTC-7).
    const dueAt = resolveOnceDueAt({
      ...base,
      dueDate: "2026-12-24",
      timeOfDayMinute: 8 * 60,
    });
    expect(dueAt).toBe("2026-12-24T15:00:00.000Z");
  });

  it("uses today when the named weekday is today and the time is still ahead", () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 3,
      timeOfDayMinute: 17 * 60,
    });
    expect(dueAt).toBe("2026-07-01T23:00:00.000Z");
  });

  it("rolls to next week when the named weekday's time already passed", () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 3,
      timeOfDayMinute: 8 * 60,
    });
    expect(dueAt).toBe("2026-07-08T14:00:00.000Z");
  });

  it("keeps the today-or-tomorrow behavior for a bare clock time", () => {
    const dueAt = resolveOnceDueAt({ ...base, timeOfDayMinute: 20 * 60 });
    expect(dueAt).toBe("2026-07-02T02:00:00.000Z");
  });

  it("returns null when there is no time expression at all", () => {
    expect(resolveOnceDueAt(base)).toBeNull();
  });

  it("returns null for a named date already in the past", () => {
    expect(resolveOnceDueAt({ ...base, dueDate: "2026-04-17" })).toBeNull();
  });

  it('returns null for "today" at a time that already passed', () => {
    expect(
      resolveOnceDueAt({ ...base, dueInDays: 0, timeOfDayMinute: 8 * 60 }),
    ).toBeNull();
  });
});

describe("buildCadenceFromLlmParams (explicit daily slots, negation scope)", () => {
  // Live-proven defect (#16941, student-term-paper-night-owl-deadline): the
  // slot extractor turned "no 8am/9am reminders" into 8am + 9am slots, so the
  // saved plan contradicted both the owner's ask and the assistant's reply.
  it("excludes clock times under a negation cue in the same clause", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW,
        timeZone: DENVER,
        intent:
          "Break the seminar paper into work sessions and remind me at 1pm and 5pm — no 8am/9am reminders",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 1020]);
  });

  it("excludes clock times after 'do not' across a slash group", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW,
        timeZone: DENVER,
        intent:
          "please break it up, but do not set me some 8am/9am reminder. remind me at 1pm and 9pm",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 1260]);
  });

  it("keeps a time affirmed by the 'don't forget' idiom", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW,
        timeZone: DENVER,
        intent: "remind me at 8am and don't forget the 5pm one",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([480, 1020]);
  });

  it("resets negation scope at a contrastive connective", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW,
        timeZone: DENVER,
        intent: "no morning pings but 9pm works, also 1pm please",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 1260]);
  });
});

describe("buildCadenceFromLlmParams (once)", () => {
  it("builds a dated once cadence from dueWeekday + timeOfDay", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({
        cadenceKind: "once",
        dueWeekday: 5,
        timeOfDay: "17:00",
      }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-03T23:00:00.000Z",
    });
  });

  it("never fabricates an immediate dueAt for a time-less once request", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "once" }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built).toBeNull();
  });

  it("leaves recurring cadences untouched", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily", windows: ["morning"] }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built?.cadence.kind).toBe("daily");
  });
});

describe("buildCadenceFromUpdateFields (once reschedule)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const currentWindowPolicy = { timezone: DENVER, windows: [] };
  const currentCadence = {
    kind: "once" as const,
    dueAt: "2026-07-01T19:00:00.000Z",
  };
  const emptyUpdate = {
    title: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    everyMinutes: null,
    quotaTargetCount: null,
    quotaUnit: null,
    perOccurrenceWork: null,
    checkInRequested: null,
    checkInWindows: null,
    priority: null,
    description: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
  };

  it("moves the dueAt when a new time is extracted", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, timeOfDay: "18:00" },
    });
    // 18:00 MDT on the (fake) current day = 2026-07-02T00:00:00Z.
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-02T00:00:00.000Z",
    });
    expect(
      built && built.cadence.kind === "once" ? built.cadence.dueAt : null,
    ).not.toBe(currentCadence.dueAt);
  });

  it("preserves the stored local date when only the clock time changes", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence: {
        kind: "once",
        dueAt: "2026-07-03T15:00:00.000Z",
      },
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, timeOfDay: "18:00" },
    });

    // The stored instant is July 3 at 09:00 in Denver. A time-only edit must
    // remain July 3 instead of rebuilding the reminder from fake "today."
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-04T00:00:00.000Z",
    });
  });

  it("preserves the stored date across a skipped DST wall time", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence: {
        kind: "once",
        dueAt: "2026-03-08T17:00:00.000Z",
      },
      currentWindowPolicy: {
        timezone: "America/Los_Angeles",
        windows: [],
      },
      timeZone: "America/Los_Angeles",
      update: { ...emptyUpdate, timeOfDay: "02:30" },
    });

    // Temporal-compatible disambiguation advances the nonexistent 02:30 to
    // 03:30 while keeping the stored March 8 local date.
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-03-08T10:30:00.000Z",
    });
  });

  it("uses the stored timezone for the date when time and timezone change together", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence: {
        kind: "once",
        // July 3 at 23:00 in Los Angeles, but already July 4 in Tokyo.
        dueAt: "2026-07-04T06:00:00.000Z",
      },
      currentWindowPolicy: {
        timezone: "America/Los_Angeles",
        windows: [],
      },
      timeZone: "Asia/Tokyo",
      update: { ...emptyUpdate, timeOfDay: "09:00" },
    });

    // Preserve the stored July 3 calendar date, then interpret the requested
    // wall time in the new timezone.
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-03T00:00:00.000Z",
    });
  });

  it("returns null (no silent no-op) when nothing reschedulable was extracted", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: emptyUpdate,
    });
    expect(built).toBeNull();
  });

  it("updates quota target, unit work, and timing without fabricating slots", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence: {
        kind: "count_per_day",
        targetCount: 3,
        unit: "set",
        perOccurrenceWork: "25 pushups",
        timing: { kind: "anytime" },
      },
      currentWindowPolicy: {
        timezone: DENVER,
        windows: [
          {
            name: "evening",
            label: "Evening",
            startMinute: 17 * 60,
            endMinute: 22 * 60,
          },
        ],
      },
      timeZone: DENVER,
      update: {
        ...emptyUpdate,
        cadenceKind: "count_per_day",
        quotaTargetCount: 4,
        perOccurrenceWork: "30 pushups",
        windows: ["evening"],
      },
    });
    expect(built?.cadence).toEqual({
      kind: "count_per_day",
      targetCount: 4,
      unit: "set",
      perOccurrenceWork: "30 pushups",
      timing: { kind: "windows", windows: ["evening"] },
    });
    expect(built && "slots" in built.cadence).toBe(false);
  });

  // Date-level moves ("push it to Friday / tomorrow / april 17") must resolve
  // the DATE, not just the time: the update extractor carries due* fields so
  // the date advances instead of silently staying put.
  it("moves the dueAt to a named weekday + time", () => {
    // NOW is Wed 2026-07-01 (Denver). "Friday at 3pm" => Fri 2026-07-03 15:00 MDT.
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueWeekday: 5, timeOfDay: "15:00" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-03T21:00:00.000Z",
    });
  });

  it("moves the dueAt by relative days (tomorrow), keeping the extracted time", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueInDays: 1, timeOfDay: "09:30" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-02T15:30:00.000Z",
    });
  });

  it("moves the dueAt to an explicit calendar date", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueDate: "2026-07-10", timeOfDay: "12:00" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-10T18:00:00.000Z",
    });
  });

  it("an offset move (in 2 hours) resolves from now", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueInMinutes: 120 },
    });
    expect(built?.cadence.kind).toBe("once");
    const dueAt =
      built && built.cadence.kind === "once" ? built.cadence.dueAt : "";
    expect(new Date(dueAt).getTime() - NOW.getTime()).toBe(120 * 60_000);
  });

  it("a past calendar date is rejected (null), never a bogus dueAt", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueDate: "2026-06-01", timeOfDay: "12:00" },
    });
    expect(built).toBeNull();
  });
});

// ── Handler-level flows ───────────────────────────────

function makeRuntime(respond: (prompt: string) => string): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(),
    useModel: vi.fn(async (_modelType: unknown, args: { prompt: string }) =>
      respond(args.prompt),
    ),
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
  } as unknown as Memory;
}

function externalSourceMessageText(text: string): string {
  return [
    "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source.",
    "",
    "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
    "Source: API",
    "---",
    text,
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
  ].join("\n");
}

function taskPlanJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    mode: "create",
    response: null,
    requestKind: null,
    title: null,
    description: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    timesPerDay: null,
    priority: null,
    durationMinutes: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    ...overrides,
  });
}

describe("runLifeOperationHandler definition update targeting", () => {
  beforeEach(() => {
    serviceState.extraDefinitions.length = 0;
    serviceState.updateCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["provider_issue", "rate_limited", "no_provider"] as const)(
    "retains a completed update and receipt when the reply is unavailable: %s",
    async (kind) => {
      serviceState.extraDefinitions.push({
        definition: {
          id: "def-reply",
          title: "Reply target",
          cadence: { kind: "daily", windows: ["morning"] },
          windowPolicy: { timezone: "UTC", windows: [] },
          updatedAt: "2026-07-01T18:00:00.000Z",
        },
      });
      const failure = {
        kind,
        code: "REPLY_UNAVAILABLE",
        message: "Reply generation unavailable.",
        transient: false as const,
      };
      const renderReply = vi
        .spyOn(agent, "renderGroundedActionReply")
        .mockResolvedValue({ kind: "unavailable", failure });
      const callback = vi.fn(async () => []);
      const result = await runLifeOperationHandler(
        makeRuntime(() => ""),
        makeMessage('Rename "Reply target" to "Evening session"'),
        undefined,
        {
          parameters: {
            action: "update",
            kind: "definition",
            target: "Reply target",
            title: "Evening session",
            details: { cadence: { kind: "daily", windows: ["evening"] } },
            intent: 'Rename "Reply target" to "Evening session"',
          },
        },
        callback,
      );

      expect(serviceState.updateCalls).toHaveLength(1);
      expect(result).toMatchObject({
        success: true,
        data: { definition: { id: "def-reply", title: "Evening session" } },
        effectReceipts: [
          { outcome: "applied", operation: "lifeops.definition.update" },
        ],
        replyFailure: failure,
        transcriptVisibility: "internal",
        turnComplete: false,
      });
      expect(result.text).toBeUndefined();
      expect(result.userFacingText).toBeUndefined();
      expect(result.verifiedUserFacing).toBeUndefined();
      expect(result.userFacingEffectReceiptIds).toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
      expect(renderReply).toHaveBeenCalledOnce();
    },
  );

  it("persists an explicit destination timezone and resolves the local clock in that zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    serviceState.extraDefinitions.push({
      definition: {
        id: "def-arrival",
        title: "Call Elena after landing",
        domain: "user_lifeops",
        timezone: "UTC",
        cadence: {
          kind: "once",
          dueAt: "2026-07-02T07:00:00.000Z",
        },
        windowPolicy: {
          timezone: "UTC",
          windows: [
            {
              name: "morning",
              label: "Morning",
              startMinute: 300,
              endMinute: 720,
            },
          ],
        },
      },
    });
    const runtime = makeRuntime((prompt) =>
      prompt.includes("update an existing task/habit")
        ? JSON.stringify({
            title: null,
            cadenceKind: null,
            windows: null,
            weekdays: null,
            timeOfDay: "09:00",
            everyMinutes: null,
            priority: null,
            description: null,
            dueDate: null,
            dueInDays: null,
            dueWeekday: null,
            dueInMinutes: null,
          })
        : "",
    );

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        'move the "Call Elena after landing" reminder to nine Tokyo time',
      ),
      undefined,
      {
        parameters: {
          action: "update",
          intent:
            'move the "Call Elena after landing" reminder to nine Tokyo time',
          target: "Call Elena after landing",
          details: {
            time: "09:00",
            timezone: "Asia/Tokyo",
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.userFacingText).toBe(result.text);
    expect(serviceState.updateCalls).toEqual([
      {
        id: "def-arrival",
        request: expect.objectContaining({
          timezone: "Asia/Tokyo",
          cadence: {
            kind: "once",
            dueAt: "2026-07-02T00:00:00.000Z",
          },
          windowPolicy: expect.objectContaining({
            timezone: "Asia/Tokyo",
          }),
        }),
      },
    ]);
  });

  it("asks which definition instead of mutating the first partial-title match", async () => {
    for (const [id, title] of [
      ["def-before", "Call Elena before the outbound leg"],
      ["def-after", "Call Elena after landing"],
    ]) {
      serviceState.extraDefinitions.push({
        definition: {
          id,
          title,
          domain: "user_lifeops",
          timezone: "UTC",
          cadence: {
            kind: "once",
            dueAt: "2026-07-02T07:00:00.000Z",
          },
          windowPolicy: { timezone: "UTC", windows: [] },
        },
      });
    }

    const result = await runLifeOperationHandler(
      makeRuntime(() => ""),
      makeMessage("move my Elena call reminder to nine"),
      undefined,
      {
        parameters: {
          action: "update",
          intent: "move my Elena call reminder to nine",
          target: "Call Elena before the outbound leg",
          details: { time: "09:00" },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("Multiple items match");
    expect(result.text).toContain("Call Elena before the outbound leg");
    expect(result.text).toContain("Call Elena after landing");
    expect(result.text).toContain("what timezone");
    expect(serviceState.updateCalls).toHaveLength(0);
  });
});

const MULTILINGUAL_CONTRADICTORY_UNSCHEDULED_TEXTS = [
  ["English", "add buy milk with no due date, but tomorrow at 9"],
  ["Spanish", "añade comprar leche sin fecha, pero mañana a las 9"],
  ["Portuguese", "adicionar comprar leite sem prazo, mas amanhã às 9"],
  ["Chinese", "添加买牛奶，没有截止日期，但明天九点"],
  ["Japanese", "牛乳を買う、期限なし、でも明日の9時"],
  ["Korean", "우유 사기, 마감일 없이, 하지만 내일 9시"],
  [
    "Vietnamese",
    "thêm việc mua sữa không có ngày đến hạn, nhưng ngày mai lúc 9 giờ",
  ],
  [
    "Tagalog",
    "idagdag ang bumili ng gatas, walang takdang petsa, pero bukas ng alas 9",
  ],
] as const;

describe("explicit unscheduled owner authority", () => {
  it.each([
    "add buy milk with no due date",
    "add buy milk as an undated task",
    "add buy milk someday",
    "añade comprar leche sin fecha",
    "adicionar comprar leite sem prazo",
    "添加买牛奶，没有截止日期",
    "牛乳を買う、期限なし",
    "우유 사기, 마감일 없이",
    "thêm việc mua sữa không có ngày đến hạn",
    "idagdag ang bumili ng gatas, walang takdang petsa",
  ])("accepts an explicit no-date phrase in %p", (text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(true);
  });

  it.each(MULTILINGUAL_CONTRADICTORY_UNSCHEDULED_TEXTS)(
    "rejects contradictory explicit scheduling in %s",
    (_language, text) => {
      expect(textStatesExplicitUndatedTodo(text)).toBe(false);
      expect(textContradictsExplicitUndatedTodo(text)).toBe(true);
    },
  );

  it.each([
    "add buy milk as a todo",
    "add buy milk tomorrow at 9 as a todo",
    "no due date, but actually schedule it tomorrow at 9",
    "not a plain todo — schedule it tomorrow",
    "add buy milk every monday",
    "someday in two weeks",
    "whenever, end of the month",
    "no due date, but in two weeks",
    "no schedule, after the meeting",
    "plain todo a week from friday",
    "not an undated task",
    "don't make it a plain todo",
    "sin fecha, pero mañana",
    "sem prazo, mas amanhã",
    "không có ngày đến hạn, nhưng ngày mai",
    "walang takdang petsa, pero bukas",
  ])("rejects omitted or contradicted no-date authority in %p", (text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(false);
  });
});

describe("runLifeOperationHandler clarification contract", () => {
  beforeEach(() => {
    serviceState.createCalls.length = 0;
  });

  it("accepts an explicitly undated owner todo as a task", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "todo",
          title: "Buy milk",
          cadenceKind: "unscheduled",
        });
      }
      return "";
    });

    // A fresh, fully-explicit undated ask saves in ONE turn (nubs-directed
    // contract change): the owner already stated the item AND its
    // undatedness, so a preview would echo back exactly what they just said.
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("Add buy milk as a todo with no due date."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Add buy milk as a todo with no due date.",
          ownerSurface: "OWNER_TODOS",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toEqual([
      expect.objectContaining({
        kind: "task",
        cadence: { kind: "unscheduled" },
        reminderPlan: null,
      }),
    ]);
  });

  it.each([
    'Preview one reminder named "Boundary QA" for September 26, 2026 at noon America/New_York.',
    'Create a reminder named "Boundary QA" for September 26, 2026 at noon America/New_York. Do not save it or change any records.',
    'Create a reminder named "Boundary QA" for September 26, 2026 at noon America/New_York. Do not save it.',
    'Create a reminder named "Boundary QA" for September 26, 2026 at noon America/New_York. Don’t save anything.',
  ])(
    "keeps the dated reminder as a preview when the owner says %p",
    async (ownerText) => {
      const runtime = makeRuntime((prompt) =>
        prompt.includes("create_definition request")
          ? taskPlanJson({
              requestKind: "reminder",
              title: "Boundary QA",
              cadenceKind: "once",
              dueDate: "2026-09-26",
              timeOfDay: "12:00",
              timeZone: "America/New_York",
            })
          : "",
      );
      const result = await runLifeOperationHandler(
        runtime,
        makeMessage(ownerText),
        undefined,
        {
          parameters: {
            action: "create",
            confirmed: true,
            title: "Boundary QA",
            intent: ownerText,
            ownerSurface: "OWNER_REMINDERS",
          },
        } as HandlerOptions,
      );

      expect(result).toMatchObject({
        success: false,
        data: { deferred: true, saved: false, requiresConfirmation: true },
      });
      expect(serviceState.createCalls).toHaveLength(0);
    },
  );

  it("does not treat a future confirmation clause as current consent", async () => {
    const ownerText =
      "Create a personal todo titled Buy oat milk. It has no due date or reminder. Preview it first and do not save until I confirm.";
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "todo",
          title: "Buy oat milk",
          cadenceKind: "unscheduled",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(ownerText),
      undefined,
      {
        parameters: {
          action: "create",
          confirmed: true,
          intent: ownerText,
          ownerSurface: "OWNER_TODOS",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: false,
      data: { deferred: true, saved: false, requiresConfirmation: true },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it.each([
    "Add tomorrow's agenda with no due date.",
    "Add Tomorrow, and Tomorrow, and Tomorrow to my reading list with no due date.",
  ])(
    "keeps temporal title nouns distinct from a real schedule in %p",
    async (ownerText) => {
      const runtime = makeRuntime((prompt) => {
        if (prompt.includes("create_definition request")) {
          return taskPlanJson({
            requestKind: "todo",
            title: "Reading list item",
            cadenceKind: "unscheduled",
          });
        }
        return "";
      });

      const result = await runLifeOperationHandler(
        runtime,
        makeMessage(ownerText),
        undefined,
        {
          parameters: {
            action: "create",
            intent: ownerText,
            ownerSurface: "OWNER_TODOS",
          },
        } as HandlerOptions,
      );

      expect(result.success).toBe(true);
      expect(serviceState.createCalls).toEqual([
        expect.objectContaining({ cadence: { kind: "unscheduled" } }),
      ]);
    },
  );

  it("rejects a contradicted edit even when extraction resolves the later date", async () => {
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Decide how the assistant should interpret the user's follow-up",
        )
      ) {
        return JSON.stringify({ mode: "edit" });
      }
      if (prompt.includes("create_definition request")) {
        if (prompt.includes("Keep it with no due date, but Friday")) {
          return taskPlanJson({
            requestKind: "todo",
            title: "Buy oat milk",
            cadenceKind: "once",
            dueWeekday: 5,
          });
        }
        if (
          prompt.includes(
            "Yes, confirm and save the edited Book dentist visit task now",
          )
        ) {
          return taskPlanJson({
            requestKind: "todo",
            title: "Book dentist visit",
            cadenceKind: "weekly",
            weekdays: [5],
            windows: ["morning"],
          });
        }
        return taskPlanJson({
          requestKind: "todo",
          title: "Buy oat milk",
          cadenceKind: "unscheduled",
        });
      }
      return "";
    });

    const preview = await runLifeOperationHandler(
      runtime,
      makeMessage("Add buy milk with no due date. Preview it first."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Add buy milk with no due date. Preview it first.",
          ownerSurface: "OWNER_TODOS",
        },
      } as HandlerOptions,
    );
    expect(preview).toMatchObject({
      success: false,
      data: { deferred: true, saved: false, requiresConfirmation: true },
    });

    const edit = await runLifeOperationHandler(
      runtime,
      {
        ...makeMessage("Keep it with no due date, but Friday."),
        id: "00000000-0000-0000-0000-000000000006",
      } as Memory,
      { data: { actionResults: [preview] } } as unknown as State,
      {
        parameters: {
          action: "create",
          confirmed: true,
          intent: "Keep it with no due date, but Friday.",
          ownerSurface: "OWNER_TODOS",
          details: { confirmed: true },
        },
      } as HandlerOptions,
    );

    expect(edit).toMatchObject({
      success: false,
      values: {
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
      },
      data: { lifeDraftInvalidated: true },
    });

    const confirmation = await runLifeOperationHandler(
      runtime,
      {
        ...makeMessage(
          "Yes, confirm and save the edited Book dentist visit task now.",
        ),
        id: "00000000-0000-0000-0000-000000000008",
      } as Memory,
      undefined,
      {
        parameters: {
          action: "create",
          confirmed: true,
          intent:
            "Yes, confirm and save the edited Book dentist visit task now.",
          ownerSurface: "OWNER_TODOS",
        },
      } as HandlerOptions,
    );

    expect(confirmation).toMatchObject({
      success: false,
      values: {
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("keeps a valid explicit undated edit as a preview without writing", async () => {
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Decide how the assistant should interpret the user's follow-up",
        )
      ) {
        return JSON.stringify({ mode: "edit" });
      }
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "todo",
          title: "Buy oat milk",
          cadenceKind: "unscheduled",
        });
      }
      return "";
    });

    const preview = await runLifeOperationHandler(
      runtime,
      makeMessage("Add buy milk with no due date. Preview it first."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Add buy milk with no due date. Preview it first.",
          ownerSurface: "OWNER_TODOS",
        },
      } as HandlerOptions,
    );
    expect(preview).toMatchObject({
      success: false,
      data: { deferred: true, saved: false, requiresConfirmation: true },
    });

    const edit = await runLifeOperationHandler(
      runtime,
      {
        ...makeMessage("Rename it Buy oat milk, still no due date."),
        id: "00000000-0000-0000-0000-000000000007",
      } as Memory,
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Rename it Buy oat milk, still no due date.",
          ownerSurface: "OWNER_TODOS",
          title: "Buy oat milk",
        },
      } as HandlerOptions,
    );

    expect(edit).toMatchObject({
      success: false,
      data: {
        deferred: true,
        saved: false,
        requiresConfirmation: true,
        lifeDraft: {
          request: {
            cadence: { kind: "unscheduled" },
            reminderPlan: null,
            title: "Buy oat milk",
          },
        },
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it.each([
    "add buy milk as a todo",
    "add buy milk tomorrow at 9 as a todo",
    "someday in two weeks",
    "whenever, end of the month",
  ])(
    "does not treat planner-only unscheduled output as explicit for %p",
    async (ownerText) => {
      const runtime = makeRuntime((prompt) => {
        if (prompt.includes("create_definition request")) {
          return taskPlanJson({
            requestKind: "todo",
            title: "Buy milk",
            cadenceKind: "unscheduled",
          });
        }
        return "";
      });

      const result = await runLifeOperationHandler(
        runtime,
        makeMessage(ownerText),
        undefined,
        {
          parameters: {
            action: "create",
            intent: ownerText,
            ownerSurface: "OWNER_TODOS",
          },
        } as HandlerOptions,
      );

      expect(result).toMatchObject({
        success: false,
        values: {
          error: "MISSING_DEFINITION_FIELD",
          missingField: "schedule",
        },
      });
      expect(serviceState.createCalls).toHaveLength(0);
    },
  );

  it.each(MULTILINGUAL_CONTRADICTORY_UNSCHEDULED_TEXTS)(
    "rejects a contradicted no-date todo through the handler in %s",
    async (_language, ownerText) => {
      const runtime = makeRuntime((prompt) => {
        if (prompt.includes("create_definition request")) {
          return taskPlanJson({
            requestKind: "todo",
            title: "Buy milk",
            cadenceKind: "unscheduled",
          });
        }
        return "";
      });

      const result = await runLifeOperationHandler(
        runtime,
        makeMessage(ownerText),
        undefined,
        {
          parameters: {
            action: "create",
            intent: ownerText,
            ownerSurface: "OWNER_TODOS",
          },
        } as HandlerOptions,
      );

      expect(result).toMatchObject({
        success: false,
        values: {
          error: "MISSING_DEFINITION_FIELD",
          missingField: "schedule",
        },
      });
      expect(serviceState.createCalls).toHaveLength(0);
    },
  );

  it("does not turn an undated reminder into a non-firing definition", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call mom",
          cadenceKind: "unscheduled",
        });
      }
      return "When should it happen?";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("Remind me to call mom, but with no due date."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Remind me to call mom, but with no due date.",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: false,
      values: {
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("marks a reminder-plan response as user-facing and awaiting owner input", async () => {
    const clarification =
      "Please tell me the report name, date, and time before I create the reminder.";
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Plan the next step for a LifeOps create_definition request.",
        )
      ) {
        return taskPlanJson({
          mode: "respond",
          response: clarification,
        });
      }
      return clarification;
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "I need a reminder for an upcoming report deadline, but I still need to provide its name, date, and time.",
      ),
      undefined,
      {
        parameters: {
          action: "create",
          intent:
            "Create a reminder after asking me for its report name, date, and time.",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: true,
      text: clarification,
      userFacingText: clarification,
      values: {
        success: true,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: "create",
      },
      data: {
        actionName: "OWNER_REMINDERS",
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: "create",
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("keeps a missing reminder schedule available for grounded owner clarification", async () => {
    const clarification = "What day and time should I use?";
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Plan the next step for a LifeOps create_definition request.",
        )
      ) {
        return taskPlanJson({
          mode: "respond",
          response: clarification,
          title: "Report deadline",
        });
      }
      return clarification;
    });

    const message = makeMessage("Remind me about my report deadline.");
    const options = {
      parameters: {
        action: "create",
        intent: "Create a report deadline reminder.",
        title: "Report deadline",
        ownerSurface: "OWNER_REMINDERS",
      },
    } as HandlerOptions;
    const result = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );
    const retry = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );

    expect(result).toMatchObject({
      success: false,
      text: "When should it happen?",
      transcriptVisibility: "internal",
      turnComplete: false,
      values: {
        success: false,
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
        requiresConfirmation: true,
        awaitingUserInput: true,
      },
      data: {
        actionName: "OWNER_REMINDERS",
        missingField: "schedule",
        requiresConfirmation: true,
        awaitingUserInput: true,
      },
    });
    expect(retry.effectReceipts).toEqual(result.effectReceipts);
    expect(result.userFacingText).toBeUndefined();
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("does not deliver a renderer's saved claim for a rejected reminder create", async () => {
    const draft =
      "I've saved the report reminder. Ready to continue when you are.";
    vi.spyOn(agent, "renderGroundedActionReply").mockResolvedValue({
      kind: "model",
      text: draft,
    });
    const runtime = makeRuntime(() =>
      taskPlanJson({ mode: "respond", response: "When?", title: "Report" }),
    );
    const callback = vi.fn(async () => []);
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("Create a report reminder; I have not specified when."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Create a report reminder",
          title: "Report",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
      callback,
    );
    expect(result).toMatchObject({
      success: false,
      text: draft,
      transcriptVisibility: "internal",
      verifiedUserFacing: false,
      turnComplete: false,
      values: { error: "MISSING_DEFINITION_FIELD", missingField: "schedule" },
    });
    expect(result.userFacingText).toBeUndefined();
    expect(result.effectReceipts).toMatchObject([{ outcome: "preview" }]);
    expect(callback).not.toHaveBeenCalled();
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("preserves observation recovery when a failed review has a model draft", async () => {
    const { LifeOpsService, LifeOpsServiceError } = await import(
      "../lifeops/service.js"
    );
    vi.spyOn(LifeOpsService.prototype, "listDefinitions").mockRejectedValue(
      new LifeOpsServiceError("Definitions are unavailable", 503),
    );
    const draft = "I checked everything and there are no reminders.";
    vi.spyOn(agent, "renderGroundedActionReply").mockResolvedValue({
      kind: "model",
      text: draft,
    });
    const callback = vi.fn(async () => []);
    const result = await runLifeOperationHandler(
      makeRuntime(() => ""),
      makeMessage("Review my reminders."),
      undefined,
      {
        parameters: {
          action: "review",
          intent: "Review my reminders",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
      callback,
    );
    expect(result).toMatchObject({
      success: false,
      text: draft,
      transcriptVisibility: "internal",
      verifiedUserFacing: false,
      turnComplete: false,
      data: { readOnlyOperation: true },
      effectReceipts: [
        { outcome: "failed", failure: { acceptance: "rejected" } },
      ],
    });
    expect(result.userFacingText).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects a model-invented date when the owner explicitly withheld timing", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call Mom",
          cadenceKind: "once",
          dueInDays: 1,
          timeOfDay: "09:00",
        });
      }
      return "When should it happen?";
    });
    const ownerText = "Remind me to call Mom, but I have not said when.";

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(ownerText),
      undefined,
      {
        parameters: {
          action: "create",
          intent: ownerText,
          ownerSurface: "OWNER_REMINDERS",
          title: "Call Mom",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: false,
      values: {
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
        awaitingUserInput: true,
      },
      data: {
        actionName: "OWNER_REMINDERS",
        missingField: "schedule",
        awaitingUserInput: true,
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });
});

describe("runLifeConnectedQuery capability boundaries", () => {
  const service = (
    overrides: Record<string, unknown>,
  ): Parameters<typeof runLifeConnectedQuery>[0]["service"] =>
    ({
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: false,
        grantedCapabilities: [],
      })),
      listCalendars: vi.fn(async () => []),
      ...overrides,
    }) as unknown as Parameters<typeof runLifeConnectedQuery>[0]["service"];

  const query = async (
    queryOperation: Parameters<
      typeof runLifeConnectedQuery
    >[0]["queryOperation"],
    serviceOverrides: Record<string, unknown>,
  ) =>
    runLifeConnectedQuery({
      runtime: makeRuntime(() => ""),
      message: makeMessage("show me the connected data"),
      state: undefined,
      intent: "show me the connected data",
      service: service(serviceOverrides),
      queryOperation,
      actionName: "OWNER_LIFE",
    });

  it("reports Gmail unavailable without calling the triage endpoint", async () => {
    const getGmailTriage = vi.fn();
    const result = await query("query_email", { getGmailTriage });

    expect(result.success).toBe(false);
    expect(result.text).toContain("Gmail is not connected");
    expect(getGmailTriage).not.toHaveBeenCalled();
  });

  it("returns the designed empty Gmail state when triage access is granted", async () => {
    const result = await query("query_email", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.gmail.triage"],
      })),
      getGmailTriage: vi.fn(async () => ({
        messages: [],
        source: "synced",
        syncedAt: "2026-07-10T00:00:00.000Z",
        summary: {
          unreadCount: 0,
          importantNewCount: 0,
          likelyReplyNeededCount: 0,
        },
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("No important emails right now.");
  });

  it("uses an Apple calendar grant when Google calendar access is absent", async () => {
    const result = await query("query_calendar_next", {
      listCalendars: vi.fn(async () => [{ id: "apple-calendar" }]),
      getNextCalendarEventContext: vi.fn(async () => ({
        event: null,
        startsAt: null,
        startsInMinutes: null,
        location: null,
        attendeeNames: [],
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("No upcoming events on your calendar.");
  });

  it("reports calendar unavailable when neither connector grants read access", async () => {
    const result = await query("query_calendar_today", {});

    expect(result.success).toBe(false);
    expect(result.text).toContain("Google Calendar is not connected");
    expect(result.data).toEqual({
      actionName: "OWNER_LIFE",
      operation: "query_calendar_today",
    });
  });

  it("returns the designed empty state for an accessible clear calendar", async () => {
    const getCalendarFeed = vi.fn(async () => ({ events: [] }));
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("Your calendar is clear today.");
    expect(getCalendarFeed).toHaveBeenCalledOnce();
  });

  it("summarizes populated accessible calendar feeds", async () => {
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed: vi.fn(async () => ({
        events: [
          {
            title: "Report review",
            startAt: "2026-07-10T15:00:00.000Z",
            timezone: "UTC",
          },
        ],
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("You have 1 event today:");
    expect(result.text).toContain("Report review");
  });

  it("translates a connected-service rate limit at the action boundary", async () => {
    const { LifeOpsServiceError } = await import("../lifeops/service.js");
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed: vi.fn(async () => {
        throw new LifeOpsServiceError("rate limit", 429);
      }),
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "LifeOps is rate-limited right now. Try again in a bit.",
    );
    expect(result.data).toEqual({
      actionName: "OWNER_LIFE",
      operation: "query_calendar_today",
    });
  });
});

describe("resolveDefinitionFromIntent", () => {
  it("resolves a uniquely named definition from natural-language intent", async () => {
    const service = {
      agentId: () => "agent-test",
      ownerEntityId: () => "owner-test",
      listDefinitions: vi.fn(async () => [
        {
          definition: {
            id: "def-1",
            title: "workout",
            domain: "user_lifeops",
            subjectType: "owner",
            subjectId: "owner-test",
          },
        },
      ]),
    } as unknown as Parameters<typeof resolveDefinitionFromIntent>[0];
    const result = await resolveDefinitionFromIntent(
      service,
      undefined,
      "Please update my workout routine",
      "user_lifeops",
    );

    expect(result?.definition.id).toBe("def-1");
  });
});

describe("runLifeOperationHandler snooze durations", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
    serviceState.goalCreateCalls.length = 0;
    serviceState.ownerEntityIds.length = 0;
    serviceState.deleteDefinitionCalls.length = 0;
    serviceState.deleteGoalCalls.length = 0;
  });

  it("threads LLM-extracted snooze minutes through to the service", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Pick the correct action value")) {
        return JSON.stringify({
          action: "snooze",
          params: { target: "workout", minutes: 45 },
          missing: [],
          confidence: 0.9,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout for 45 minutes"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.id).toBe("occ-1");
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBe(45);
  });

  it('threads a "tomorrow morning" preset through to the service', async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Pick the correct action value")) {
        return JSON.stringify({
          action: "snooze",
          params: { target: "workout", preset: "tomorrow_morning" },
          missing: [],
          confidence: 0.9,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout until tomorrow morning"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.request.preset).toBe(
      "tomorrow_morning",
    );
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBeUndefined();
  });

  it("honors a planner-supplied top-level minutes param", async () => {
    const runtime = makeRuntime(() => "");
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout for 45 minutes"),
      undefined,
      {
        parameters: { subaction: "snooze", target: "workout", minutes: 45 },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBe(45);
  });

  it("blocks broad emotional delete-everything requests before any destructive call", async () => {
    const runtime = makeRuntime(() => "");
    const intent =
      "you know what? just delete everything. all my reminders, all my tasks, all of it. i give up.";
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "delete",
          intent,
          target: "everything",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      noop: true,
      blockedReason: "broad_destructive_delete",
    });
    expect(serviceState.deleteDefinitionCalls).toHaveLength(0);
    expect(serviceState.deleteGoalCalls).toHaveLength(0);
    expect(result.text).toContain("won't delete everything");
  });

  it("preserves concrete goal deadline details in the confirmation preview", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Conversational Spanish",
          description:
            "Practice conversational Spanish until a cafe-style conversation is possible.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Hold a 10-minute cafe-style conversation without switching to English by the deadline.",
            metric: "Spanish-only conversation duration",
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Use four weekly practice blocks.",
            firstStep: "Schedule the first 20-minute practice block.",
            suggestedSupport: ["weekly check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.9,
          evaluationSummary:
            "Progress is measured by four weekly practice sessions and a 10-minute Spanish-only conversation by the deadline.",
          targetDomain: "learning",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        externalSourceMessageText(
          "Let's define success as holding a 10-minute cafe-style conversation without switching to English by December 1, with four 20-minute practice blocks each week.",
        ),
      ),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "goal",
          confirmed: false,
          title: "Conversational Spanish",
          intent: "Learn conversational Spanish",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("December 1");
    expect(result.text).toContain("four 20-minute practice blocks");
    expect(result.values).toMatchObject({
      saved: false,
      requiresConfirmation: true,
    });
    expect(serviceState.goalCreateCalls).toHaveLength(0);
  });

  it("reuses a cached goal draft when confirm state has no action results", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Stabilize sleep schedule",
          description:
            "Maintain a consistent weekday sleep window for the next month.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Be asleep by 11:30 PM and awake by 7:30 AM on weekdays, within a 45-minute margin.",
            metric: "weekday schedule adherence",
            evidenceSignals: ["health.sleep", "manual_checkin"],
          },
          supportStrategy: {
            summary: "Use a consistent wind-down and wake routine.",
            firstStep: "Start wind-down at 10:30 PM on weekdays.",
            suggestedSupport: ["weekly sleep check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.95,
          evaluationSummary:
            "Progress is measured by weekday sleep and wake adherence.",
          targetDomain: "sleep",
        });
      }
      return "";
    });

    const preview = await runLifeOperationHandler(
      runtime,
      makeMessage(
        externalSourceMessageText(
          "I want that to mean being asleep by 11:30 pm and awake around 7:30 am on weekdays, within 45 minutes, for the next month.",
        ),
      ),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "goal",
          confirmed: false,
          title: "Stabilize sleep schedule",
          intent:
            "Stabilize sleep schedule with target bedtime 11:30pm and wake time 7:30am on weekdays, within 45 minutes, for the next month",
        },
      } as HandlerOptions,
    );
    expect(preview.success).toBe(false);
    expect(preview.values).toMatchObject({
      saved: false,
      requiresConfirmation: true,
    });

    const confirm = await runLifeOperationHandler(
      runtime,
      makeMessage(externalSourceMessageText("Yes, save that goal.")),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "goal",
          title: "Stabilize sleep schedule",
          intent: "Stabilize sleep schedule",
        },
      } as HandlerOptions,
    );

    expect(confirm.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Stabilize sleep schedule",
      successCriteria: {
        metric: "weekday schedule adherence",
      },
      supportStrategy: {
        firstStep: "Start wind-down at 10:30 PM on weekdays.",
      },
    });
  });

  it.each([
    "ok save that one",
    "ok save that one\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]",
  ])(
    "reuses a previewed goal draft when confirmation is misrouted to routines: %s",
    async (confirmation) => {
      const runtime = makeRuntime(() => {
        throw new Error(
          "explicit draft confirmations should not need LLM reuse classification",
        );
      });
      const deferredGoalDraft = {
        intent:
          "Count it if I walk around the block after lunch three times a week for the next six weeks.",
        operation: "create_goal",
        createdAt: Date.now(),
        request: {
          title: "Walk around the block",
          description:
            "Walk around the block after lunch three times a week for six weeks.",
          successCriteria: {
            metric: "weekly post-lunch walks",
            summary:
              "Complete three post-lunch walks around the block per week.",
          },
          supportStrategy: {
            firstStep: "Pick the next lunch where a short walk is possible.",
            summary: "Keep the walk small and low-pressure.",
          },
          metadata: {
            goalGrounding: { groundingState: "grounded" },
            source: "chat",
          },
        },
      };
      const state = {
        data: {
          actionResults: [
            {
              success: false,
              data: { lifeDraft: deferredGoalDraft },
            },
          ],
        },
      } as unknown as State;

      const result = await runLifeOperationHandler(
        runtime,
        makeMessage(externalSourceMessageText(confirmation)),
        state,
        {
          parameters: {
            action: "create",
            kind: "definition",
            intent:
              "Walk around the block after lunch three times a week for the next six weeks",
            title: "Walk around the block after lunch",
            confirmed: false,
            details: {
              frequency: "3 times per week",
              durationWeeks: 6,
              timeOfDay: "after lunch",
            },
            ownerSurface: "OWNER_ROUTINES",
          },
        } as HandlerOptions,
      );

      expect(result.success).toBe(true);
      expect(serviceState.createCalls).toHaveLength(0);
      expect(serviceState.goalCreateCalls).toHaveLength(1);
      expect(serviceState.goalCreateCalls[0]).toMatchObject({
        title: "Walk around the block",
        description:
          "Walk around the block after lunch three times a week for six weeks.",
        successCriteria: {
          metric: "weekly post-lunch walks",
        },
        supportStrategy: {
          firstStep: "Pick the next lunch where a short walk is possible.",
        },
      });
    },
  );

  it("keeps goal-tracking follow-up details on the goal path even when planner selects routines", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Walk around the block after lunch",
          description:
            "Leave the apartment by walking around the block after lunch three times a week.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Walk around the block after lunch at least 3 times per week for 6 weeks.",
            metric: "weekly post-lunch walks",
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Use a low-pressure after-lunch walking routine.",
            firstStep: "Pick the next lunch where a short walk is possible.",
            suggestedSupport: ["weekly check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.9,
          evaluationSummary:
            "Progress is three post-lunch block walks per week for six weeks.",
          targetDomain: "health",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "Count it if I walk around the block after lunch three times a week for the next six weeks. Even if it is slow.",
      ),
      undefined,
      {
        parameters: {
          ownerSurface: "OWNER_ROUTINES",
          action: "create",
          kind: "definition",
          confirmed: true,
          title: "Block Walks",
          intent:
            "walk around the block after lunch three times a week for the next six weeks, counting each walk even if slow",
          details: {
            frequency: "3/week",
            durationWeeks: 6,
            timeOfDay: "after lunch",
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
      lifeDraft: {
        operation: "create_goal",
        request: {
          title: "Block Walks",
          successCriteria: {
            metric: "weekly post-lunch walks",
          },
          supportStrategy: {
            firstStep: "Pick the next lunch where a short walk is possible.",
          },
        },
      },
    });
  });

  it("grounds a confirmed titled goal before saving", async () => {
    const intent =
      "ok save this goal: leave the apartment more; count it if I walk around the block after lunch three times a week for the next six weeks, and slow counts.";
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Leave the apartment more",
          description:
            "Build a low-pressure habit of leaving the apartment for a short walk after lunch.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Walk around the block after lunch three times per week for six weeks.",
            metric: "post_lunch_block_walks",
            target: { walksPerWeek: 3, weeks: 6 },
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Keep the goal small and count slow walks.",
            firstStep: "Take one slow walk around the block after lunch.",
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.88,
          evaluationSummary:
            "Progress means three after-lunch walks around the block each week for six weeks.",
          targetDomain: "movement",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: true,
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Leave the apartment more",
      description:
        "Build a low-pressure habit of leaving the apartment for a short walk after lunch.",
      successCriteria: {
        metric: "post_lunch_block_walks",
      },
      supportStrategy: {
        summary: "Keep the goal small and count slow walks.",
      },
      metadata: {
        source: "chat",
        originalIntent: intent,
        goalGrounding: {
          groundingState: "grounded",
          missingCriticalFields: [],
        },
      },
    });
  });

  it("marks planner-supplied grounded goal details as grounded metadata", async () => {
    const intent = "ok save that one";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: true,
          details: {
            description:
              "Feel less stuck at home by getting outside more often.",
            successCriteria: {
              summary:
                "Walk around the block after lunch at least 3 times per week for 6 weeks.",
            },
            supportStrategy: {
              summary: "Anchor the walk to lunch and count slow walks.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      metadata: {
        source: "chat",
        originalIntent: intent,
        goalGrounding: {
          groundingState: "grounded",
          missingCriticalFields: [],
          summary:
            "Walk around the block after lunch at least 3 times per week for 6 weeks.",
        },
      },
    });
  });

  it("asks for concrete success criteria before previewing a vague goal save", async () => {
    const intent = "I want to leave the apartment more";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: false,
          details: {
            description: "Feel less stuck by getting outside more often.",
            successCriteria: {
              summary:
                "A meaningful increase in days per week leaving the apartment for any reason, measured by feeling less stuck instead of step counts.",
            },
            supportStrategy: {
              summary: "Keep it low-pressure and non-fitness.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain(
      "What would count as success",
    );
    expect(result.userFacingText ?? result.text).toContain("how often");
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("asks instead of previewing planner-invented first-turn goal criteria", async () => {
    const intent = "I want a goal called Run a 5K by fall.";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Run a 5K by fall",
          confirmed: false,
          details: {
            description: "Train and complete a 5K run by fall 2026.",
            successCriteria: {
              summary: "Complete a 5K run before the end of fall 2026.",
            },
            supportStrategy: {
              summary:
                "Build up running distance gradually with a progressive training plan.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain(
      "What would count as success",
    );
  });

  it("previews grounded goal criteria when planner confirmation is premature", async () => {
    const intent =
      "Count it if I walk around the block after lunch three times a week for the next six weeks. Even if it is slow.";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Walk around the block after lunch 3x/week",
          confirmed: true,
          details: {
            description:
              "Leave the apartment more by walking around the block after lunch.",
            successCriteria: {
              summary:
                "Walk around the block after lunch 3 times per week for 6 weeks. Slow counts.",
            },
            supportStrategy: {
              summary: "Keep it low-pressure and count any pace after lunch.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain("Confirm");
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("saves when explicit confirmation text is wrapped by an external-source notice", async () => {
    const wrappedIntent = `SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source.
<<<EXTERNAL_UNTRUSTED_CONTENT>>>
Source: API
---
Yes, save it.
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(wrappedIntent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent: "save goal",
          title: "Save $2,000 for Lisbon trip by March 31",
          confirmed: true,
          details: {
            description: "Save $2,000 by March 31 for a Lisbon trip.",
            successCriteria: {
              summary: "$2,000 saved by March 31 for the Lisbon trip.",
            },
            supportStrategy: {
              summary: "Transfer $175 after each paycheck.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Save $2,000 for Lisbon trip by March 31",
    });
    expect(result.userFacingText ?? result.text).toContain(
      "$2,000 saved by March 31",
    );
    expect(result.userFacingText ?? result.text).not.toContain(
      "What would count as success",
    );
  });
});

describe("runLifeOperationHandler one-off reminder scheduling", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
    serviceState.goalCreateCalls.length = 0;
    serviceState.ownerEntityIds.length = 0;
  });

  it("marks an expired bare confirmation as awaiting the owner without classifying the app footer", async () => {
    const prompts: string[] = [];
    const runtime = makeRuntime((prompt) => {
      prompts.push(prompt);
      return "";
    });
    const state = {
      data: {
        actionResults: [
          {
            success: false,
            data: {
              lifeDraft: {
                operation: "create_definition",
                intent: "Preview a reminder tomorrow at noon",
                createdAt: Date.now() - 6 * 60_000,
                sourceMessageId: "prior-preview",
                request: {
                  title: "Expired preview",
                  kind: "task",
                  cadence: { kind: "once", dueAt: "2026-09-26T16:00:00.000Z" },
                },
              },
            },
          },
        ],
      },
    } as unknown as State;
    const message = makeMessage(
      "Yes, save it.\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]",
    );
    const result = await runLifeOperationHandler(runtime, message, state, {
      parameters: { action: "create_reminder", confirmed: true },
    } as HandlerOptions);
    expect(
      prompts.filter((prompt) =>
        prompt.includes("interpret the user's follow-up"),
      ),
    ).toHaveLength(0);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      data: {
        reason: "draft_expired",
        lifeDraftInvalidated: true,
        awaitingUserInput: true,
      },
    });
    expect(message.content.text).toContain("Language instruction");
  });

  it("keeps a three-character time correction out of the bare-confirmation shortcut", async () => {
    const prompts: string[] = [];
    const runtime = makeRuntime((prompt) => {
      prompts.push(prompt);
      if (prompt.includes("interpret the user's follow-up"))
        return JSON.stringify({ mode: "edit" });
      if (prompt.includes("create_definition request"))
        return taskPlanJson({
          title: "Call Mom",
          requestKind: "reminder",
          cadenceKind: "once",
          dueDate: "2026-09-26",
          timeOfDay: "21:00",
          timeZone: "America/New_York",
        });
      return "";
    });
    const state = {
      data: {
        actionResults: [
          {
            success: false,
            data: {
              lifeDraft: {
                operation: "create_definition",
                intent: "Remind me to call Mom on September 26 at noon",
                createdAt: Date.now(),
                sourceMessageId: "prior-preview",
                request: {
                  title: "Call Mom",
                  kind: "task",
                  timezone: "America/New_York",
                  cadence: { kind: "once", dueAt: "2026-09-26T16:00:00.000Z" },
                },
              },
            },
          },
        ],
      },
    } as unknown as State;
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("Yes, 9pm"),
      state,
      {
        parameters: { action: "create_reminder", confirmed: true },
      } as HandlerOptions,
    );
    expect(
      prompts.filter((prompt) =>
        prompt.includes("interpret the user's follow-up"),
      ),
    ).toHaveLength(1);
    const request =
      serviceState.createCalls[0] ??
      (result.data?.lifeDraft as { request?: unknown } | undefined)?.request;
    expect(request).toMatchObject({
      cadence: { kind: "once", dueAt: "2026-09-27T01:00:00.000Z" },
    });
  });

  it.each([
    {
      name: "preview stays unsaved",
      text: "Preview a reminder to call Mom tomorrow at noon. Do not save it.",
      plan: {
        requestKind: "reminder",
        cadenceKind: "once",
        dueInDays: 1,
        timeOfDay: "12:00",
      },
      writes: 0,
    },
    {
      name: "alarm classification",
      text: "Set an alarm for tomorrow at 7am.",
      plan: {
        requestKind: "alarm",
        cadenceKind: "once",
        dueInDays: 1,
        timeOfDay: "07:00",
      },
      writes: 1,
    },
    {
      name: "multi-step confirmation",
      text: "Remind me to outline, draft, and proofread by the 28th.",
      plan: {
        requestKind: "reminder",
        cadenceKind: "once",
        dueDate: "2026-09-28",
        multiStep: true,
      },
      writes: 0,
    },
    {
      name: "flexible quota and check-ins",
      text: "Track 25 pushups, three sets a day, whenever, and check in after lunch. Show it first.",
      plan: {
        cadenceKind: "count_per_day",
        quotaTargetCount: 3,
        quotaUnit: "set",
        perOccurrenceWork: "25 pushups",
        checkInRequested: true,
        checkInWindows: ["afternoon"],
        description: "Daily exercise",
        priority: 2,
      },
      writes: 0,
    },
    {
      name: "unknown schedule overrides model guess",
      text: "Remind me to call Mom. I have not said when. Don't guess a schedule.",
      plan: {
        requestKind: "reminder",
        cadenceKind: "once",
        dueInDays: 1,
        timeOfDay: "12:00",
      },
      writes: 0,
    },
    {
      name: "clockless once asks when",
      text: "Remind me to call Mom.",
      plan: { requestKind: "reminder", cadenceKind: "once" },
      writes: 0,
    },
    {
      name: "explicit undated todo",
      text: "Add a todo to call Mom, no due date.",
      plan: { cadenceKind: "unscheduled" },
      surface: "OWNER_TODOS",
      writes: 1,
    },
    {
      name: "clarification without create",
      text: "Can you remind me?",
      plan: { mode: "respond", response: "What should I remind you about?" },
      writes: 0,
    },
  ])(
    "preserves extraction semantics: $name",
    async ({ text, plan, surface, writes }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-11T18:00:00.000Z"));
      try {
        const completePlan = {
          requestKind: "unspecified",
          mode: "create",
          multiStep: false,
          title: "Call Mom",
          timeZone: "America/New_York",
          ...plan,
        };
        const run = async (native: boolean) => {
          serviceState.createCalls.length = 0;
          const extractionPrompts: string[] = [];
          const runtime = makeRuntime((prompt) => {
            if (prompt.includes("create_definition request")) {
              extractionPrompts.push(prompt);
              return taskPlanJson(completePlan);
            }
            return "";
          });
          const result = await runLifeOperationHandler(
            runtime,
            makeMessage(text),
            undefined,
            {
              parameters: {
                action: "create",
                kind: "definition",
                ownerSurface: surface ?? "OWNER_REMINDERS",
                confirmed: true,
                ...(native ? { createPlan: completePlan } : {}),
              },
            } as HandlerOptions,
          );
          return {
            result,
            saved: [...serviceState.createCalls],
            extractionPrompts,
          };
        };
        const extracted = await run(false);
        const native = await run(true);
        expect(extracted.extractionPrompts).toHaveLength(1);
        expect(native.extractionPrompts).toHaveLength(0);
        expect(native.saved).toHaveLength(writes);
        expect(native.saved).toEqual(extracted.saved);
        expect(native.result.success).toEqual(extracted.result.success);
        expect(native.result.data?.lifeDraft).toEqual(
          extracted.result.data?.lifeDraft,
        );
        expect(native.result.data?.awaitingUserInput).toEqual(
          extracted.result.data?.awaitingUserInput,
        );
        expect(native.result.data?.requiresConfirmation).toEqual(
          extracted.result.data?.requiresConfirmation,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { mode: "create", title: "Call Mom", cadenceKind: "once", dueInDays: 1 },
    {
      mode: "create",
      multiStep: false,
      title: "Call Mom",
      cadenceKind: "once",
      timeOfDay: "29:99",
    },
    {
      mode: "create",
      multiStep: false,
      title: "Call Mom",
      cadenceKind: "once",
      timeZone: "Not/AZone",
    },
    {
      mode: "create",
      multiStep: false,
      title: "Call Mom",
      cadenceKind: "once",
      dueInDays: 1,
      dueWeekday: 2,
    },
    {
      mode: "create",
      multiStep: false,
      title: "Call Mom",
      cadenceKind: "once",
      confirmed: true,
    },
  ])(
    "keeps extraction for an incomplete or invalid direct plan: %j",
    async (createPlan) => {
      const prompts: string[] = [];
      const runtime = makeRuntime((prompt) => {
        prompts.push(prompt);
        return taskPlanJson({
          mode: "respond",
          response: "When should I remind you?",
        });
      });
      await runLifeOperationHandler(
        runtime,
        makeMessage("Remind me to call Mom."),
        undefined,
        {
          parameters: {
            action: "create_reminder",
            createPlan: { requestKind: "reminder", ...createPlan },
          },
        } as HandlerOptions,
      );
      expect(
        prompts.filter((prompt) =>
          prompt.includes("create_definition request"),
        ),
      ).toHaveLength(1);
      expect(serviceState.createCalls).toHaveLength(0);
    },
  );

  it("uses the ordinary planner's complete create plan without a second extraction", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        throw new Error("A complete planner plan must not reread room history");
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "Remind me to call Mom on September 26, 2026 at noon in New York.",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          createPlan: {
            mode: "create",
            multiStep: false,
            requestKind: "reminder",
            title: "Call Mom",
            cadenceKind: "once",
            dueDate: "2026-09-26",
            timeOfDay: "12:00",
            timeZone: "America/New_York",
          },
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    expect(serviceState.createCalls[0]).toMatchObject({
      title: "Call Mom",
      timezone: "America/New_York",
      cadence: { kind: "once", dueAt: "2026-09-26T16:00:00.000Z" },
    });
  });

  it.each([400, 503])(
    "stops when pending-draft classification fails with provider status %s, without another extraction or save",
    async (statusCode) => {
      const failure = Object.assign(
        new Error(
          statusCode === 400
            ? "Bad Request: Please reduce the length of the messages or completion. Current length is 139000 while limit is 131072"
            : "Provider unavailable",
        ),
        { name: "AI_APICallError", statusCode },
      );
      let calls = 0;
      const runtime = makeRuntime(() => {
        if (calls++ === 0) throw failure;
        return taskPlanJson({
          requestKind: "reminder",
          title: "New preview",
          cadenceKind: "once",
          dueWeekday: 5,
          timeOfDay: "17:00",
        });
      });
      const draft = {
        operation: "create_definition",
        createdAt: Date.now(),
        sourceMessageId: "prior-preview",
        intent: "Preview an earlier reminder",
        request: {
          title: "Earlier preview",
          kind: "task",
          cadence: { kind: "once", dueAt: "2026-09-26T16:00:00.000Z" },
        },
      };
      const state = {
        values: {},
        text: "",
        data: {
          actionResults: [
            {
              success: false,
              data: { lifeDraft: draft, saved: false, deferred: true },
            },
          ],
        },
      } as unknown as State;
      await expect(
        runLifeOperationHandler(
          runtime,
          makeMessage(
            'Preview a reminder called "New preview" for Friday at 5pm. Do not save it.',
          ),
          state,
          {
            parameters: {
              action: "create_reminder",
              title: "New preview",
              createPlan: {
                mode: "create",
                multiStep: false,
                title: "New preview",
                cadenceKind: "once",
                dueWeekday: 5,
                timeOfDay: "17:00",
                requestKind: "reminder",
              },
            },
          } as HandlerOptions,
        ),
      ).rejects.toBe(failure);
      expect(runtime.useModel).toHaveBeenCalledTimes(1);
      expect(serviceState.createCalls).toEqual([]);
      expect(serviceState.goalCreateCalls).toEqual([]);
      expect(state.data.actionResults).toEqual([
        {
          success: false,
          data: { lifeDraft: draft, saved: false, deferred: true },
        },
      ]);
    },
  );

  it.each([
    "remind me friday at 5pm to call mom",
    "remind me friday at 5pm to call mom. Do not create other reminders.",
  ])(
    "schedules the authorized single reminder on Friday 17:00: %p",
    async (ownerText) => {
      const runtime = makeRuntime((prompt) => {
        if (prompt.includes("create_definition request")) {
          return taskPlanJson({
            requestKind: "reminder",
            title: "Call mom",
            cadenceKind: "once",
            dueWeekday: 5,
            timeOfDay: "17:00",
          });
        }
        return "";
      });
      const before = Date.now();
      const message = makeMessage(ownerText);
      const result = await runLifeOperationHandler(
        runtime,
        message,
        undefined,
        {
          parameters: {
            action: "create_reminder",
            intent: ownerText,
          },
        } as HandlerOptions,
      );
      expect(result.success).toBe(true);
      // A completed persist is canonical: the planner must echo the action's
      // own confirmation instead of paraphrasing the save state (#16941).
      expect(result.verifiedUserFacing).toBe(true);
      expect(result.userFacingText ?? "").not.toBe("");
      expect(serviceState.createCalls).toHaveLength(1);
      expect(serviceState.ownerEntityIds).toContain(message.entityId);
      const cadence = serviceState.createCalls[0]?.cadence as {
        kind: string;
        dueAt: string;
      };
      expect(cadence.kind).toBe("once");
      const dueAtMs = Date.parse(cadence.dueAt);
      expect(dueAtMs).toBeGreaterThan(before);
      const timeZone = resolveDefaultTimeZone();
      const parts = getZonedDateParts(new Date(cadence.dueAt), timeZone);
      const weekday = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day, 12),
      ).getUTCDay();
      expect(weekday).toBe(5);
      expect(parts.hour).toBe(17);
      expect(parts.minute).toBe(0);
    },
  );

  it("previews (never writes) a multi-milestone dated ask until the owner confirms (#16941)", async () => {
    // Live finding: "history report due Monday 9am — set reminders for
    // outline, rough draft, and final proofread" took the crisp-single-ask
    // immediate-save exemption and persisted pre-consent. multiStep asks must
    // keep the two-phase preview even with a resolved once cadence.
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "History report milestones",
          cadenceKind: "once",
          dueWeekday: 1,
          timeOfDay: "09:00",
          multiStep: true,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "my history report is due next monday at 9am. can you set reminders for outline, rough draft, and final proofread?",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent:
            "my history report is due next monday at 9am - set reminders for outline, rough draft, and final proofread",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it('anchors "remind me tomorrow at 9am" to the owner timezone fact, not the host clock (#13509)', async () => {
    // Regression for #13509: a conversational one-off create with no zone
    // stated out loud (planner returns timeZone:null) must resolve "9am"
    // against the owner's STORED timezone fact, not the host clock. Before the
    // fix, this stored 09:00 in the host zone (UTC on TZ=UTC / server
    // topologies) = 04:00 America/Chicago — "confidently wrong by five hours".
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call pharmacy about refill",
          cadenceKind: "once",
          dueInDays: 1,
          timeOfDay: "09:00",
          // No zone stated out loud: the planner leaves timeZone null. The
          // owner-fact fallback (#13509) must supply the zone.
          timeZone: null,
        });
      }
      return "";
    });
    // Seed the owner's stored timezone fact.
    registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
    await resolveOwnerFactStore(runtime).update(
      { timezone: "America/Chicago" },
      { source: "profile_save", recordedAt: "2026-07-04T00:00:00.000Z" },
    );

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "remind me tomorrow at 9am to call the pharmacy about my refill",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent:
            "remind me tomorrow at 9am to call the pharmacy about my refill",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const created = serviceState.createCalls[0] as {
      cadence: { kind: string; dueAt: string };
      timezone?: string;
    };
    expect(created.cadence.kind).toBe("once");
    // dueAt wall-clock is 09:00 in America/Chicago, NOT 09:00 host/UTC.
    const parts = getZonedDateParts(
      new Date(created.cadence.dueAt),
      "America/Chicago",
    );
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    // The persisted definition also carries the owner zone, not the host zone.
    expect(created.timezone).toBe("America/Chicago");
  });

  it("asks for clarification instead of scheduling when the time is unresolvable", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        // Time expression present ("when the game starts") but unresolvable —
        // the extractor leaves every datetime field null.
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call mom",
          cadenceKind: "once",
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("remind me to call mom when the game starts"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "remind me to call mom when the game starts",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(false);
    expect(
      (result.data as Record<string, unknown> | undefined)?.missingField,
    ).toBe("schedule");
    expect(serviceState.createCalls).toHaveLength(0);
  });
});

describe("runLifeOperationHandler consent gate (#16941)", () => {
  const CHILD_ASK =
    "before school i always forget stuff. can you remind me every morning to brush teeth, pack my lunch, and put my math folder in my bag? just say it normal, not like a baby.";

  function routineRuntime(): IAgentRuntime {
    return makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Before-school checklist",
          cadenceKind: "daily",
          windows: ["morning"],
        });
      }
      return "";
    });
  }

  function makeMessageWithId(id: string, text: string): Memory {
    return { ...makeMessage(text), id } as Memory;
  }

  beforeEach(() => {
    serviceState.createCalls.length = 0;
    serviceState.extraDefinitions.length = 0;
  });

  it("reports already-saved instead of stacking a structurally identical definition", async () => {
    // Live finding: after a save, a re-described confirm turn ("yes lock it
    // in! and can it bug me before friday too") minted a second identical
    // definition. Same normalized title + same cadence = same item.
    serviceState.extraDefinitions.push({
      definition: {
        id: "def-dup",
        title: "Before-school checklist",
        status: "active",
        cadence: { kind: "daily", windows: ["morning"] },
      },
    });

    const result = await runLifeOperationHandler(
      routineRuntime(),
      makeMessage("yes save the before-school checklist please"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "save the before-school checklist routine",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(result.data).toMatchObject({ deduplicated: true });
    expect(result.text).toContain("already saved");
  });

  it("ignores bare planner confirmed:true on a fresh recurring create", async () => {
    // Live finding: the planner asserted confirmed:true on the FIRST call of
    // a daily-routine ask and saved a definition the child never approved.
    // Without an explicit yes in the owner text or a prior-turn draft, the
    // flag is not consent.
    const result = await runLifeOperationHandler(
      routineRuntime(),
      makeMessage(CHILD_ASK),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: CHILD_ASK,
          confirmed: true,
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("blocks a same-turn preview→confirmed:true re-call from self-approving", async () => {
    // Exact live repro: preview on message M, then the planner re-calls
    // create with confirmed:true still on message M. The draft's
    // sourceMessageId matches, so the flag still is not consent.
    const runtime = routineRuntime();
    const message = makeMessageWithId(
      "00000000-0000-0000-0000-000000000011",
      CHILD_ASK,
    );

    const preview = await runLifeOperationHandler(runtime, message, undefined, {
      parameters: { action: "create_reminder", intent: CHILD_ASK },
    } as HandlerOptions);
    expect(preview.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);

    const recall = await runLifeOperationHandler(runtime, message, undefined, {
      parameters: {
        action: "create_reminder",
        intent: CHILD_ASK,
        confirmed: true,
      },
    } as HandlerOptions);

    expect(recall.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(recall.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("fails closed when a same-turn re-call has no stable message id", async () => {
    // Some connector/runtime boundaries do not carry Memory.id into the action
    // invocation. An absent id cannot prove the cached preview came from an
    // earlier owner turn, so planner-confirmed reuse must remain a preview.
    const runtime = routineRuntime();
    const message = makeMessage(CHILD_ASK);

    const preview = await runLifeOperationHandler(runtime, message, undefined, {
      parameters: { action: "create_reminder", intent: CHILD_ASK },
    } as HandlerOptions);
    expect(preview.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);

    const recall = await runLifeOperationHandler(runtime, message, undefined, {
      parameters: {
        action: "create_reminder",
        intent: CHILD_ASK,
        confirmed: true,
      },
    } as HandlerOptions);

    expect(recall.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(recall.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("rejects planner confirmed:true without deterministic current-turn consent", async () => {
    // A prior-turn draft proves a preview exists, not that neutral current
    // text authorizes the write. The planner cannot turn "mhm" into consent.
    const runtime = routineRuntime();

    const preview = await runLifeOperationHandler(
      runtime,
      makeMessageWithId("00000000-0000-0000-0000-000000000021", CHILD_ASK),
      undefined,
      {
        parameters: { action: "create_reminder", intent: CHILD_ASK },
      } as HandlerOptions,
    );
    expect(preview.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);

    const confirm = await runLifeOperationHandler(
      runtime,
      makeMessageWithId("00000000-0000-0000-0000-000000000022", "mhm"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: CHILD_ASK,
          confirmed: true,
        },
      } as HandlerOptions,
    );

    expect(confirm.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(confirm.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });
});

describe("lead-up reminder shape (#16941)", () => {
  const BASE_PLAN = {
    steps: [{ channel: "in_app" as const, offsetMinutes: 0, label: "due" }],
  };
  const ASK = "yes lock it in! and can it bug me before friday too";

  it("detects explicit lead-up asks and ignores plain confirmations", () => {
    expect(wantsEarlierReminderNudge(ASK)).toBe(true);
    expect(
      wantsEarlierReminderNudge("remind me earlier in the week as well"),
    ).toBe(true);
    expect(wantsEarlierReminderNudge("not just friday morning, please")).toBe(
      true,
    );
    expect(wantsEarlierReminderNudge("yes lock it in!")).toBe(false);
    expect(wantsEarlierReminderNudge("remind me friday at 5pm")).toBe(false);
  });

  it("widens the once lead and anchors an early step at relevance start", () => {
    const now = Date.parse("2026-07-20T09:00:00.000Z");
    const shaped = applyLeadUpReminderShape({
      cadence: { kind: "once", dueAt: "2026-07-24T09:00:00.000Z" },
      plan: BASE_PLAN,
      ownerText: ASK,
      title: "Book report",
      milestones: [],
      now,
    });
    // Steps fire at (dueAt - lead) + offset: offset 0 is the early nudge a
    // day out, offset = lead is the due-time reminder.
    expect(shaped.cadence).toMatchObject({
      kind: "once",
      visibilityLeadMinutes: 1440,
    });
    expect(shaped.plan.steps).toEqual([
      {
        channel: "in_app",
        offsetMinutes: 0,
        label: "Early start: Book report",
      },
      {
        channel: "in_app",
        offsetMinutes: 1440,
        label: "Book report reminder",
      },
    ]);
    expect(reminderStepMinutesBeforeDue(shaped.cadence, 0)).toBe(1440);
    expect(reminderStepMinutesBeforeDue(shaped.cadence, 1440)).toBe(0);
  });

  it("shrinks the lead toward the midpoint when the deadline is close", () => {
    const now = Date.parse("2026-07-20T09:00:00.000Z");
    const shaped = applyLeadUpReminderShape({
      cadence: { kind: "once", dueAt: "2026-07-20T12:00:00.000Z" },
      plan: BASE_PLAN,
      ownerText: ASK,
      title: "Book report",
      milestones: [],
      now,
    });
    expect(shaped.cadence).toMatchObject({ visibilityLeadMinutes: 90 });
  });

  it("leaves the shape alone without an ask, without runway, or off-once", () => {
    const now = Date.parse("2026-07-20T09:00:00.000Z");
    expect(
      applyLeadUpReminderShape({
        cadence: { kind: "once", dueAt: "2026-07-24T09:00:00.000Z" },
        plan: BASE_PLAN,
        ownerText: "yes lock it in!",
        title: "Book report",
        milestones: [],
        now,
      }).plan.steps,
    ).toHaveLength(1);
    expect(
      applyLeadUpReminderShape({
        cadence: { kind: "once", dueAt: "2026-07-20T09:30:00.000Z" },
        plan: BASE_PLAN,
        ownerText: ASK,
        title: "Book report",
        milestones: [],
        now,
      }).plan.steps,
    ).toHaveLength(1);
    expect(
      applyLeadUpReminderShape({
        cadence: { kind: "daily", windows: ["morning"] },
        plan: BASE_PLAN,
        ownerText: ASK,
        title: "Book report",
        milestones: [],
        now,
      }).plan.steps,
    ).toHaveLength(1);
  });

  it("renders lead offsets as human phrases", () => {
    expect(formatLeadOffsetPhrase(1440)).toBe("a day");
    expect(formatLeadOffsetPhrase(90)).toBe("1.5 hours");
    expect(formatLeadOffsetPhrase(60)).toBe("1 hour");
    expect(formatLeadOffsetPhrase(45)).toBe("45 minutes");
    expect(formatLeadOffsetPhrase(4320)).toBe("3 days");
  });

  it("persists the lead shape and reports it on a crisp confirm-with-additions save", async () => {
    serviceState.createCalls.length = 0;
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Book report",
          cadenceKind: "once",
          dueInDays: 3,
          timeOfDay: "09:00",
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "yes lock it in! and can it bug me before friday too so i actually read the chapters, not just friday morning.",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "save the book report reminder plan",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const created = serviceState.createCalls[0] as {
      cadence: { kind: string; visibilityLeadMinutes?: number };
      reminderPlan: { steps: Array<{ offsetMinutes: number }> };
    };
    expect(created.cadence.visibilityLeadMinutes ?? 0).toBeGreaterThanOrEqual(
      60,
    );
    expect(created.reminderPlan.steps.length).toBeGreaterThanOrEqual(2);
    expect(
      created.reminderPlan.steps.every((step) => step.offsetMinutes >= 0),
    ).toBe(true);
    // The stored lead must surface in the confirmed reply, not stay a silent
    // row: the live failure was an earlier checkpoint "proposed, not created".
    expect(result.text ?? "").toContain("early nudge");
  });
});

describe("recent-save retraction (#16941)", () => {
  beforeEach(() => {
    serviceState.createCalls.length = 0;
    serviceState.extraDefinitions.length = 0;
    serviceState.deleteDefinitionCalls.length = 0;
  });

  function makeMessageWithId(id: string, text: string): Memory {
    return { ...makeMessage(text), id } as Memory;
  }

  it("classifies retractions narrowly", () => {
    expect(
      isLifeSaveRetraction(
        "actually no wait don't save that one. my teacher changed it and i need to ask her tomorrow first.",
      ),
    ).toBe(true);
    expect(isLifeSaveRetraction("cancel that")).toBe(true);
    expect(isLifeSaveRetraction("never mind")).toBe(true);
    expect(isLifeSaveRetraction("please undo that")).toBe(true);
    expect(
      isLifeSaveRetraction(
        "ok now save just this: tomorrow after school remind me to ask Ms. Rivera what the science report topic is.",
      ),
    ).toBe(false);
    expect(isLifeSaveRetraction("delete the workout habit")).toBe(false);
    expect(
      isLifeSaveRetraction("don't forget to set a reminder for friday"),
    ).toBe(false);
  });

  it("deletes the just-saved row whatever operation the planner picked", async () => {
    const runtime = makeRuntime(() => "");
    const savedMessage = makeMessageWithId(
      "00000000-0000-0000-0000-000000000031",
      "can you remind me about my science report?",
    );
    await writeRecentLifeSaveCache(runtime, savedMessage, {
      definitionId: "def-science",
      title: "Science report - start this weekend",
      sourceMessageId: "00000000-0000-0000-0000-000000000031",
      createdAt: Date.now(),
    });
    serviceState.extraDefinitions.push({
      definition: {
        id: "def-science",
        title: "Science report - start this weekend",
        status: "active",
        cadence: { kind: "once", dueAt: "2026-07-25T09:00:00.000Z" },
      },
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessageWithId(
        "00000000-0000-0000-0000-000000000032",
        "actually no wait don't save that one. my teacher changed it and i need to ask her tomorrow first.",
      ),
      undefined,
      {
        parameters: {
          action: "review",
          intent: "confirm no science report reminder exists",
        },
      } as HandlerOptions,
    );

    expect(serviceState.deleteDefinitionCalls).toEqual(["def-science"]);
    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.data).toMatchObject({ retractedRecentSave: true });
    expect(result.text ?? "").toContain("Science report");
    // The undo handle is one-shot: a later unrelated turn must not re-delete.
    expect(await readRecentLifeSaveCache(runtime, savedMessage)).toBeNull();
  });

  it("never retracts from the same message that saved", async () => {
    const runtime = makeRuntime(() => "");
    const message = makeMessageWithId(
      "00000000-0000-0000-0000-000000000041",
      "don't save that one",
    );
    await writeRecentLifeSaveCache(runtime, message, {
      definitionId: "def-science",
      title: "Science report",
      sourceMessageId: "00000000-0000-0000-0000-000000000041",
      createdAt: Date.now(),
    });
    serviceState.extraDefinitions.push({
      definition: {
        id: "def-science",
        title: "Science report",
        status: "active",
        cadence: { kind: "once", dueAt: "2026-07-25T09:00:00.000Z" },
      },
    });

    await runLifeOperationHandler(runtime, message, undefined, {
      parameters: { action: "review", intent: "review reminders" },
    } as HandlerOptions);

    expect(serviceState.deleteDefinitionCalls).toEqual([]);
  });

  it("parks an undo handle on an un-previewed crisp save and honors the next-turn retraction", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Science report - start this weekend",
          cadenceKind: "once",
          dueInDays: 2,
          timeOfDay: "09:00",
        });
      }
      return "";
    });

    const saveResult = await runLifeOperationHandler(
      runtime,
      makeMessageWithId(
        "00000000-0000-0000-0000-000000000051",
        "can you remind me about my science report? it's due next monday and i think i should start this weekend.",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "remind me about my science report due monday",
        },
      } as HandlerOptions,
    );
    expect(saveResult.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const parked = await readRecentLifeSaveCache(
      runtime,
      makeMessage("any text"),
    );
    expect(parked?.definitionId).toBe("def-created-1");

    serviceState.extraDefinitions.push({
      definition: {
        id: "def-created-1",
        title: "Science report - start this weekend",
        status: "active",
        cadence: { kind: "once", dueAt: "2026-07-27T09:00:00.000Z" },
      },
    });
    const retractResult = await runLifeOperationHandler(
      runtime,
      makeMessageWithId(
        "00000000-0000-0000-0000-000000000052",
        "actually no wait don't save that one. my teacher changed it and i need to ask her tomorrow first.",
      ),
      undefined,
      {
        parameters: { action: "review", intent: "check reminders" },
      } as HandlerOptions,
    );

    expect(serviceState.deleteDefinitionCalls).toEqual(["def-created-1"]);
    expect(retractResult.success).toBe(true);
    expect(retractResult.data).toMatchObject({ retractedRecentSave: true });
  });
});

describe("sentence-scoped explicit confirmation (#16941)", () => {
  it("treats a leading yes with a later negation clause as consent", async () => {
    // Live failure: "yes lock it in! … not just friday morning" tripped the
    // message-wide negation veto, so three confirmed creates all previewed
    // and nothing persisted. The negation lives in a different sentence than
    // the confirmation cue, so it must not cancel the yes.
    serviceState.createCalls.length = 0;
    serviceState.extraDefinitions.length = 0;
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Book report milestones",
          cadenceKind: "once",
          dueInDays: 3,
          timeOfDay: "09:00",
          multiStep: true,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "yes lock it in! and can it bug me before friday too so i actually read the chapters, not just friday morning.",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "save the book report reminder plan",
          confirmed: true,
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
  });

  it("still refuses consent when the negation shares the sentence with the cue", async () => {
    serviceState.createCalls.length = 0;
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Book report milestones",
          cadenceKind: "once",
          dueInDays: 3,
          timeOfDay: "09:00",
          multiStep: true,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("hold off, don't save that plan yet"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "book report reminder plan",
          confirmed: true,
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
  });
});

describe("buildCadenceFromLlmParams (deadline exclusion + phrase slots, #16941)", () => {
  const NOW2 = new Date("2026-07-20T12:00:00-06:00");
  const DENVER2 = "America/Denver";

  it("never turns the deadline clock into a work slot", () => {
    // Live failure: "due thursday at 5pm" produced a 17:00 daily slot, so the
    // saved plan scheduled a work session exactly at the due instant.
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW2,
        timeZone: DENVER2,
        intent:
          "my seminar paper is due thursday at 5pm. remind me at 1pm and again late evening — no 8am/9am reminders",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 1290]);
  });

  it("maps owner phrase anchors (after dinner, after school) to slots", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW2,
        timeZone: DENVER2,
        intent:
          "draft session at 1pm, citations after dinner, and a run after school",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 930, 1170]);
  });

  it("keeps phrase anchors under negation excluded", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily" }),
      {
        now: NOW2,
        timeZone: DENVER2,
        intent: "remind me at 1pm and 3pm but not after dinner",
      },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
    const slots =
      built?.cadence.kind === "times_per_day" ? built.cadence.slots : [];
    expect(slots.map((slot) => slot.minuteOfDay)).toEqual([780, 900]);
  });
});

describe("milestone reminder plans (#16941)", () => {
  const DUE = "2026-07-27T09:00:00.000Z";
  const NOW3 = Date.parse("2026-07-23T09:00:00.000Z");

  it("parses an enumerated milestone list from the intent", () => {
    expect(
      parseMilestoneListFromIntent(
        "Set reminders to prepare a history report due Monday at 9am: outline, rough draft, and final proofread",
      ),
    ).toEqual(["outline", "rough draft", "final proofread"]);
    expect(
      parseMilestoneListFromIntent(
        "can you set reminders for outline, rough draft, and final proofread?",
      ),
    ).toEqual(["outline", "rough draft", "final proofread"]);
    // Single-item and schedule-prose segments never become milestone lists.
    expect(
      parseMilestoneListFromIntent("remind me to pay the electric bill"),
    ).toEqual([]);
  });

  it("spreads milestone steps across the runway, all before the due step", () => {
    const shaped = applyLeadUpReminderShape({
      cadence: { kind: "once", dueAt: DUE },
      plan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "due" }],
      },
      ownerText: "yes save it exactly like that.",
      title: "History report milestones",
      milestones: ["Outline", "Rough draft", "Final proofread"],
      now: NOW3,
    });
    // 4 days of runway → lead 3 days; milestones at 0/-2d/-1d before due,
    // then the due-time step at offset = lead.
    expect(shaped.cadence).toMatchObject({ visibilityLeadMinutes: 4320 });
    expect(shaped.plan.steps.map((step) => step.offsetMinutes)).toEqual([
      0, 1440, 2880, 4320,
    ]);
    expect(shaped.plan.steps.map((step) => step.label)).toEqual([
      "Outline",
      "Rough draft",
      "Final proofread",
      "Due: History report milestones",
    ]);
    const beforeDue = shaped.plan.steps.map((step) =>
      reminderStepMinutesBeforeDue(shaped.cadence, step.offsetMinutes),
    );
    expect(beforeDue).toEqual([4320, 2880, 1440, 0]);
  });

  it("persists milestone steps on a confirmed multiStep save and names them", async () => {
    // Live failure (student-report-two-phase-commit): the confirmed save
    // stored ONE reminder at the deadline with a bare [0m] plan — "no derived
    // milestone schedule". Planner-supplied details.steps must become
    // spread reminder-plan steps.
    serviceState.createCalls.length = 0;
    serviceState.extraDefinitions.length = 0;
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "History report milestones",
          cadenceKind: "once",
          dueInDays: 4,
          timeOfDay: "09:00",
          multiStep: true,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("yes save it exactly like that."),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent:
            "Set reminders to prepare a history report due Monday at 9am: outline, rough draft, and final proofread",
          confirmed: true,
          details: {
            steps: ["Outline", "Rough draft", "Final proofread"],
          },
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const created = serviceState.createCalls[0] as {
      cadence: { visibilityLeadMinutes?: number };
      reminderPlan: { steps: Array<{ offsetMinutes: number; label: string }> };
    };
    const lead = created.cadence.visibilityLeadMinutes ?? 0;
    expect(lead).toBeGreaterThanOrEqual(120);
    const beforeDue = created.reminderPlan.steps.filter(
      (step) => lead - step.offsetMinutes >= 60,
    );
    expect(beforeDue.map((step) => step.label)).toEqual([
      "Outline",
      "Rough draft",
      "Final proofread",
    ]);
    expect(result.text ?? "").toContain("early nudges");
  });
});
