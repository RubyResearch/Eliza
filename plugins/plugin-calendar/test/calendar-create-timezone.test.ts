/**
 * Create requests anchor planner timestamps to the owner's zone: offset-less
 * values are wall time in the configured TIMEZONE, a fabricated "Z" instant
 * for a non-UTC owner is handed to the timezone-grounded extractor instead of
 * being trusted, and the stored event carries the zone so replies render in
 * it. CalendarService is stubbed with the real range resolver; the request
 * handed to prepareCalendarEventCreate, the created event and the extractor
 * call are inspected. Clock pinned to Saturday 2026-09-05 so "tuesday"
 * resolves to 2026-09-08. The extractor model is a fixture; no database.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";
import { resolveCalendarEventRange } from "../src/internal/calendar-normalize.js";
import { resolveDefaultTimeZone } from "../src/internal/constants.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";

/** Saturday 2026-09-05, 11:00 in America/Los_Angeles. */
const PINNED_NOW = new Date("2026-09-05T18:00:00.000Z");
const OWNER_TIME_ZONE = "America/Los_Angeles";
/** Tuesday 2026-09-08, 7:00 AM PDT. */
const TUESDAY_7AM_PDT = "2026-09-08T14:00:00.000Z";
const TUESDAY_8AM_PDT = "2026-09-08T15:00:00.000Z";

function utcEvent(externalId: string, startAt: string): LifeOpsCalendarEvent {
  return {
    id: `agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:${externalId}`,
    externalId,
    agentId: "agent-1",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title: "Gym session",
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: '"eliza-1"', version: 1 },
    syncedAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    grantId: ELIZA_CALENDAR_GRANT_ID,
  };
}

function stubService(feedEvents: LifeOpsCalendarEvent[] = []) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: feedEvents,
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-09-05T00:00:00.000Z",
      timeMax: "2026-09-19T00:00:00.000Z",
      syncedAt: null,
    })),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: CreateLifeOpsCalendarEventRequest) => {
        const range = resolveCalendarEventRange(request, new Date());
        return {
          ...request,
          side: "owner" as const,
          grantId: ELIZA_CALENDAR_GRANT_ID,
          calendarId: ELIZA_CALENDAR_ID,
          startAt: range.startAt,
          endAt: range.endAt,
          timeZone: range.timeZone,
        };
      },
    ),
    createCalendarEvent: vi.fn(
      async (
        _url: URL,
        request: CreateLifeOpsCalendarEventRequest & {
          startAt: string;
          endAt: string;
          timeZone: string;
        },
      ): Promise<LifeOpsCalendarEvent> => ({
        ...utcEvent("created", request.startAt),
        title: request.title,
        endAt: request.endAt,
        timezone: request.timeZone,
      }),
    ),
  };
}

type StubService = ReturnType<typeof stubService>;

/** Zone-grounded extraction fixture: what the domain extractor returns for "tuesday at 7am". */
const GROUNDED_EXTRACTION = {
  title: "Gym session",
  startAt: "2026-09-08T07:00:00-07:00",
  durationMinutes: 60,
  timeZone: OWNER_TIME_ZONE,
};

function makeDeps() {
  const runJsonModel = vi.fn(async (args: { prompt: string }) => {
    if (!args.prompt.includes("Extract calendar event creation fields")) {
      return null;
    }
    return {
      rawResponse: JSON.stringify(GROUNDED_EXTRACTION),
      parsed: GROUNDED_EXTRACTION,
    };
  });
  const deps: CalendarActionDeps = {
    runTextModel: async () => null,
    runJsonModel: runJsonModel as unknown as CalendarActionDeps["runJsonModel"],
    recentConversationTexts: async () => [],
  };
  return { deps, runJsonModel };
}

function fakeRuntime(
  service: StubService,
  settings: Record<string, string>,
): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: vi.fn(),
    getSetting: (key: string) => settings[key],
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

async function createThroughHandler(args: {
  text: string;
  details: Record<string, unknown>;
  settings?: Record<string, string>;
  feedEvents?: LifeOpsCalendarEvent[];
  title?: string;
  intent?: string;
}) {
  const service = stubService(args.feedEvents);
  const { deps, runJsonModel } = makeDeps();
  const action = createCalendarActionRunner(deps);
  const result = await action.handler(
    fakeRuntime(service, args.settings ?? { TIMEZONE: OWNER_TIME_ZONE }),
    {
      id: "00000000-0000-0000-0000-000000000301",
      entityId: "00000000-0000-0000-0000-000000000302",
      roomId: "00000000-0000-0000-0000-000000000303",
      content: { text: args.text },
    } as unknown as Memory,
    undefined,
    {
      parameters: {
        subaction: "create_event",
        title: args.title ?? "Gym session",
        ...(args.intent ? { intent: args.intent } : {}),
        details: args.details,
      },
    },
    vi.fn(async () => []),
  );
  if (!result) throw new Error("Expected a Calendar action result");
  const createdCall = service.createCalendarEvent.mock.calls[0] as
    | [URL, { startAt: string; endAt: string; timeZone: string }]
    | undefined;
  return {
    result,
    created: createdCall?.[1],
    createCalls: service.createCalendarEvent.mock.calls.length,
    extractorCalls: runJsonModel.mock.calls.length,
  };
}

describe("calendar create anchors planner timestamps to the owner's zone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["offset-less wall time", "2026-09-08T07:00:00", "2026-09-08T08:00:00"],
    ["wall time without seconds", "2026-09-08T07:00", "2026-09-08T08:00"],
    [
      "the wrong date as wall time",
      "2026-09-01T07:00:00",
      "2026-09-01T08:00:00",
    ],
    [
      "a correct explicit offset",
      "2026-09-08T07:00:00-07:00",
      "2026-09-08T08:00:00-07:00",
    ],
  ])(
    "stores 'tuesday at 7am' at 7 AM Pacific without a model call when the planner sends %s",
    async (_label, start, end) => {
      // Live 2026-09-05: these shapes were recorded for the same request; the
      // offset-less ones were stored at 07:00Z and read back as 7 AM UTC.
      const { result, created, extractorCalls } = await createThroughHandler({
        text: "add gym session tuesday at 7am to my calendar",
        details: { start, end, calendarId: "primary" },
      });
      expect(extractorCalls).toBe(0);
      expect(created).toMatchObject({
        startAt: TUESDAY_7AM_PDT,
        endAt: TUESDAY_8AM_PDT,
        timeZone: OWNER_TIME_ZONE,
      });
      // The action hands internal evidence to the evaluator (no user text of
      // its own); the rendered time in that evidence must carry the zone.
      const evidence = JSON.stringify(result.data ?? {}) + (result.text ?? "");
      // A self-verified receipt spells the time compactly ("7am PDT").
      expect(evidence).toMatch(/\b7(?::00 AM|am) PDT\b/);
      expect(evidence).not.toMatch(/(?:AM|am) UTC\b/);
    },
  );

  it.each([
    ["a fabricated Z on the right digits", "2026-09-08T07:00:00.000Z"],
    ["a fabricated Z on the wrong day", "2026-09-09T07:00:00Z"],
  ])(
    "hands %s to the timezone-grounded extractor instead of trusting the instant",
    async (_label, start) => {
      // Live 2026-09-05: both shapes were recorded for "tuesday at 7am" and
      // stored at midnight Pacific. The user's prose is not re-parsed here;
      // the grounded extraction model re-derives the wall time.
      const { created, extractorCalls } = await createThroughHandler({
        text: "add gym session tuesday at 7am to my calendar",
        details: { start, calendarId: "primary" },
      });
      expect(extractorCalls).toBe(1);
      expect(created).toMatchObject({
        startAt: TUESDAY_7AM_PDT,
        endAt: TUESDAY_8AM_PDT,
        timeZone: OWNER_TIME_ZONE,
      });
    },
  );

  it("lets the per-event intent pick the day when one message names several dates", async () => {
    // Live 2026-09-05 22:43: "pottery class saturday at 10am and a haircut
    // sunday at 2pm" — the haircut's Sunday start was "corrected" to Saturday
    // because the stated-date check read the whole message first.
    const { created, extractorCalls, result } = await createThroughHandler({
      text: "add a pottery class saturday at 10am and a haircut sunday at 2pm to my calendar",
      title: "Haircut",
      intent: "Add a haircut Sunday at 2pm",
      details: {
        start: "2026-09-06T14:00:00",
        durationMinutes: 60,
        calendarId: "primary",
      },
    });
    expect(extractorCalls).toBe(0);
    expect(result.success).toBe(true);
    expect(created).toMatchObject({
      startAt: "2026-09-06T21:00:00.000Z",
      endAt: "2026-09-06T22:00:00.000Z",
      timeZone: OWNER_TIME_ZONE,
    });
  });

  it("keeps the message's single stated day over a planner intent that disagrees", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      intent: "add gym session wednesday at 7am",
      details: { start: "2026-09-09T07:00:00", calendarId: "primary" },
    });
    expect(created).toMatchObject({
      startAt: TUESDAY_7AM_PDT,
      endAt: TUESDAY_8AM_PDT,
    });
  });

  it("pauses instead of creating an event whose start has already passed, suggesting the same time next week", async () => {
    // PINNED_NOW is Saturday 11:00 AM Pacific; "saturday at 10am" is an hour
    // gone. Live 2026-09-05 the pottery class was created at 10:00 that day.
    const { result, createCalls } = await createThroughHandler({
      text: "add a pottery class saturday at 10am to my calendar",
      title: "Pottery class",
      intent: "Add a pottery class Saturday at 10am",
      details: {
        start: "2026-09-05T10:00:00",
        durationMinutes: 60,
        calendarId: "primary",
      },
    });
    expect(createCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      subaction: "create_event",
      requiresInput: true,
      requestedStartAt: "2026-09-05T17:00:00.000Z",
      suggestedStartAt: "2026-09-12T17:00:00.000Z",
    });
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "calendar.event.create",
      outcome: "noop",
    });
    const evidence = JSON.stringify(result.data ?? {}) + (result.text ?? "");
    expect(evidence).toContain("already passed");
    expect(evidence).toContain("Sep 12");
  });

  it("creates a past event when the planner marks allowPast for an explicit user request", async () => {
    const { created, result } = await createThroughHandler({
      text: "log the pottery class I went to this morning at 10am",
      title: "Pottery class",
      intent: "Record the pottery class from this morning at 10am",
      details: {
        start: "2026-09-05T10:00:00",
        durationMinutes: 60,
        allowPast: true,
        calendarId: "primary",
      },
    });
    expect(result.success).toBe(true);
    expect(created).toMatchObject({ startAt: "2026-09-05T17:00:00.000Z" });
  });

  it("trusts a UTC instant when the owner's zone is UTC", async () => {
    const { created, extractorCalls } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00Z" },
      settings: { TIMEZONE: "UTC" },
    });
    expect(extractorCalls).toBe(0);
    expect(created).toMatchObject({
      startAt: "2026-09-08T07:00:00.000Z",
      timeZone: "UTC",
    });
  });

  it("does not reinterpret a correct planner time from other clock times in the sentence", async () => {
    // Review counterexample: the only clock time in the sentence belongs to
    // the train, not to the requested event.
    const { created, extractorCalls } = await createThroughHandler({
      text: "create packing time tuesday one hour before my train leaves at 7am",
      details: { start: "2026-09-08T06:00:00", durationMinutes: 60 },
    });
    expect(extractorCalls).toBe(0);
    expect(created).toMatchObject({
      startAt: "2026-09-08T13:00:00.000Z",
      timeZone: OWNER_TIME_ZONE,
    });
  });

  it("keeps the configured zone when the feed is full of UTC-stamped events", async () => {
    const feedEvents = [
      utcEvent("a", "2026-09-08T07:00:00.000Z"),
      utcEvent("b", "2026-09-08T07:00:00.000Z"),
      utcEvent("c", "2026-09-08T14:00:00.000Z"),
    ];
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00" },
      feedEvents,
    });
    expect(created.timeZone).toBe(OWNER_TIME_ZONE);
    expect(created.startAt).toBe(TUESDAY_7AM_PDT);
  });

  it("ignores planner junk in timeZone and still creates in the owner's zone", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: {
        start: "2026-09-08T07:00:00",
        timeZone: "user's timezone",
      },
    });
    expect(created).toMatchObject({
      startAt: TUESDAY_7AM_PDT,
      timeZone: OWNER_TIME_ZONE,
    });
  });

  it("honours a real zone the planner names", async () => {
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00", timeZone: "America/New_York" },
    });
    expect(created).toMatchObject({
      startAt: "2026-09-08T11:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it("returns structured validation instead of inventing a duration when the end does not follow the start", async () => {
    const { result, createCalls } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00", end: "2026-09-08T07:00:00" },
    });
    expect(createCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "calendar.create_event",
      outcome: "failed",
      failure: { code: "CALENDAR_SERVICE_400" },
    });
    expect(result.data?.replyContext).toMatchObject({
      scenario: "service_error",
      facts: expect.stringMatching(/end time lands before the start/),
    });
  });

  it("falls back to the host zone when no TIMEZONE is configured", async () => {
    const hostZone = resolveDefaultTimeZone();
    const { created } = await createThroughHandler({
      text: "add gym session tuesday at 7am to my calendar",
      details: { start: "2026-09-08T07:00:00" },
      settings: {},
    });
    expect(created.timeZone).toBe(hostZone);
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: hostZone,
        hour: "numeric",
        hour12: false,
      }).format(new Date(created.startAt)),
    ).toBe("07");
  });
});
