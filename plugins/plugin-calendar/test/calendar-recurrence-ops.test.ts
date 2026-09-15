/**
 * Recurring-event (RRULE) guardrails for the CALENDAR action handler.
 *
 * The provider feed is flattened (`singleEvents: true`), so every occurrence
 * of a recurring series arrives as its own event carrying
 * `recurringEventId` → the series master. The mutation contract under test:
 *
 *   - update/delete of a recurring occurrence with NO instance-vs-series
 *     intent → clarification round-trip, no approval
 *   - "just this …" phrasing / recurrenceScope=instance → approval binds the
 *     occurrence id with scope "instance"
 *   - "this and following …" phrasing → approval binds the provider-safe split
 *     scope without collapsing it into the whole series
 *   - "whole series" phrasing / recurrenceScope=series → one series-scoped
 *     approval (never an iteration over flattened occurrences)
 *   - non-recurring events keep the old behavior (no scope round-trip)
 *   - create_event carries structured RRULE recurrence through to the service
 *
 * The CalendarService is stubbed (feed fixtures + spied mutations); the fake
 * runtime has no `useModel`; clarification evidence goes to the evaluator and
 * exact approval previews remain interactive controls.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

function fakeDeps(service: StubService): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    mutationGateway: {
      schedule: service.scheduleApproval,
      modify: service.modifyApproval,
      cancel: service.cancelApproval,
    },
  };
}

function event(args: {
  externalId: string;
  title: string;
  startAt?: string;
  recurringEventId?: string;
  recurrence?: string[];
}): LifeOpsCalendarEvent {
  const startAt = args.startAt ?? "2026-07-08T17:00:00.000Z";
  return {
    id: `agent-1:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: "2026-07-08T18:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    recurrence: args.recurrence ?? null,
    recurringEventId: args.recurringEventId ?? null,
    metadata: {
      ...(args.recurringEventId
        ? { recurringEventId: args.recurringEventId }
        : {}),
      ...(args.recurrence ? { recurrence: args.recurrence } : {}),
    },
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

// One flattened occurrence of a weekly standup series.
const STANDUP_OCCURRENCE = event({
  externalId: "standup_20260708T170000Z",
  title: "Team Standup",
  recurringEventId: "standup-master",
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
});

// A plain one-off event.
const LUNCH = event({ externalId: "evt-lunch", title: "Lunch with Maya" });

function stubService(feedEvents: LifeOpsCalendarEvent[]) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: feedEvents,
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-07-31T00:00:00.000Z",
      syncedAt: null,
    })),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "connector-account:acct-a",
        calendarId: "primary",
        startAt: request.startAt as string,
        endAt:
          (request.endAt as string | undefined) ?? "2026-07-06T14:00:00.000Z",
        timeZone: (request.timeZone as string | undefined) ?? "UTC",
      }),
    ),
    getConditionalCalendarMutationTarget: vi.fn(
      async (_url: URL, request: { eventId: string }) =>
        feedEvents.find(
          (candidate) => candidate.externalId === request.eventId,
        ) ?? STANDUP_OCCURRENCE,
    ),
    createCalendarEvent: vi.fn(async () =>
      event({
        externalId: "evt-created",
        title: "Morning Run",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      }),
    ),
    deleteCalendarEvent: vi.fn(async () => undefined),
    updateCalendarEvent: vi.fn(async () => ({
      ...STANDUP_OCCURRENCE,
      title: "Team Standup (moved)",
    })),
    scheduleApproval: vi.fn(async () => ({
      requestId: "approval-schedule",
      action: "schedule_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:schedule",
      replayed: false,
      text: "schedule approval queued",
    })),
    modifyApproval: vi.fn(async () => ({
      requestId: "approval-modify",
      action: "modify_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:modify",
      replayed: false,
      text: "modify approval queued",
    })),
    cancelApproval: vi.fn(async () => ({
      requestId: "approval-cancel",
      action: "cancel_event" as const,
      state: "pending" as const,
      acceptedAt: "2026-07-01T12:00:00.000Z",
      idempotencyKey: "calendar-approval:cancel",
      replayed: false,
      text: "cancel approval queued",
    })),
  };
}

type StubService = ReturnType<typeof stubService>;

function fakeRuntime(service: StubService): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    createdAt: Date.parse("2026-07-01T12:00:00.000Z"),
    content: { text },
  } as unknown as Memory;
}

async function runHandler(args: {
  service: StubService;
  text: string;
  parameters: Record<string, unknown>;
  extractedUpdate?: Record<string, unknown>;
}) {
  const actionDeps = fakeDeps(args.service);
  if (args.extractedUpdate) {
    actionDeps.runJsonModel = vi.fn(async ({ actionType }) =>
      actionType === "lifeops.calendar.extract_update_event"
        ? {
            rawResponse: JSON.stringify(args.extractedUpdate),
            parsed: args.extractedUpdate,
          }
        : null,
    );
  }
  const action = createCalendarActionRunner(actionDeps);
  const callback = vi.fn(async () => []);
  const result = await action.handler(
    fakeRuntime(args.service),
    message(args.text),
    undefined,
    { parameters: args.parameters },
    callback,
  );
  if (!result) throw new Error("Expected a Calendar action result");
  expect(result.effectReceipts).toHaveLength(1);
  if (result.transcriptVisibility === "internal") {
    expect(callback).not.toHaveBeenCalled();
    // Settled internal results omit turnComplete; pauses and failures keep false.
    expect(result.turnComplete).not.toBe(true);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("userFacingText");
    expect(result.data?.replyContext).toMatchObject({
      domain: "calendar",
      intent: args.text,
      scenario: expect.any(String),
      facts: expect.stringMatching(/\S/),
      context: expect.any(Object),
    });
  } else {
    expect(result.turnComplete).toBe(true);
    expect(result.userFacingText).toBe(result.text);
    expect(result.userFacingEffectReceiptIds).toEqual([
      result.effectReceipts?.[0]?.receiptId,
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      text: result.text,
      source: "action",
      action: "CALENDAR",
    });
  }
  return result;
}

describe("CALENDAR update_event on a recurring occurrence", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([STANDUP_OCCURRENCE, LUNCH]);
  });

  it("keeps title, notes, location and recurrence out of a time-only provider patch", async () => {
    const original = {
      ...STANDUP_OCCURRENCE,
      description: "Bring the agenda.",
      location: "Meeting room 3",
    };
    service = stubService([original]);
    await runHandler({
      service,
      text: "Move just this standup to 6 PM and keep everything else.",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: {
          startAt: "2026-07-08T18:00:00.000Z",
          endAt: "2026-07-08T19:00:00.000Z",
          recurrenceScope: "instance",
        },
      },
      extractedUpdate: {
        title: "",
        description: "",
        location: "",
        recurrence: "",
        timeZone: "",
      },
    });
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request).toMatchObject({
      eventId: original.externalId,
      startAt: "2026-07-08T18:00:00.000Z",
      endAt: "2026-07-08T19:00:00.000Z",
      recurrenceScope: "instance",
      timeZone: "UTC",
    });
    for (const field of ["title", "description", "location", "recurrence"]) {
      expect(request[field]).toBeUndefined();
    }
    expect(service.modifyApproval.mock.calls[0]?.[0]?.targetEvent).toEqual(
      original,
    );
  });

  it("ambiguous intent → clarification, and nothing is updated", async () => {
    const result = await runHandler({
      service,
      text: "move my standup to 10am",
      parameters: { subaction: "update_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(result.data?.replyContext).toMatchObject({
      scenario: "clarify_update_event_recurrence_scope",
      facts: expect.stringMatching(/occurrence.*series/s),
      context: { event: STANDUP_OCCURRENCE },
    });
    expect(result.data).toMatchObject({
      requiresInput: true,
      missing: ["recurrenceScope"],
    });
    expect(service.modifyApproval).not.toHaveBeenCalled();
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('"just this" phrasing → patches only the addressed occurrence', async () => {
    const result = await runHandler({
      service,
      text: "move just this standup to 10am",
      parameters: { subaction: "update_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    expect(service.modifyApproval).toHaveBeenCalledTimes(1);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("instance");
    expect(result.text).toContain("approval queued");
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('"whole series" phrasing → one series-scoped patch', async () => {
    const result = await runHandler({
      service,
      text: "rename the whole series of my standup",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { newTitle: "Daily Sync" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.modifyApproval).toHaveBeenCalledTimes(1);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("series");
    expect(request.title).toBe("Daily Sync");
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('"this and following" phrasing → one split-scoped patch', async () => {
    const result = await runHandler({
      service,
      text: "rename this standup and every following one",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { newTitle: "Family Sync" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("this_and_following");
    expect(request.title).toBe("Family Sync");
  });

  it("explicit recurrenceScope detail wins without special phrasing", async () => {
    const result = await runHandler({
      service,
      text: "move my standup to 10am",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { recurrenceScope: "series" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("series");
  });

  it("planner debris in the explicit scope falls back to user phrasing", async () => {
    const result = await runHandler({
      service,
      text: "move just this standup to 10am",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { recurrenceScope: ',time_max:"' },
      },
    });
    expect(result.success).toBe(true);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("instance");
  });

  it("planner debris from update-field extraction reaches clarification, not a 400", async () => {
    const result = await runHandler({
      service,
      text: "move my standup",
      parameters: { subaction: "update_event", query: "standup" },
      extractedUpdate: {
        startAt: "2026-07-08T19:00:00.000Z",
        recurrenceScope: ",series:",
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      requiresInput: true,
      missing: ["recurrenceScope"],
    });
    expect(service.modifyApproval).not.toHaveBeenCalled();
  });

  it("a recurrence-rule change is implicitly a series edit", async () => {
    const result = await runHandler({
      service,
      text: "make my standup weekly on tuesdays",
      parameters: {
        subaction: "update_event",
        query: "standup",
        details: { recurrence: "RRULE:FREQ=WEEKLY;BYDAY=TU" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
    expect(request.recurrenceScope).toBe("series");
  });

  it("non-recurring events update without a scope round-trip", async () => {
    const result = await runHandler({
      service,
      text: "move my lunch with maya to 2pm",
      parameters: {
        subaction: "update_event",
        query: "lunch",
        details: { startAt: "2026-07-08T18:00:00.000Z" },
      },
    });
    expect(result.success).toBe(true);
    expect(service.modifyApproval).toHaveBeenCalledTimes(1);
    const request = service.modifyApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.eventId).toBe("evt-lunch");
    expect(request.recurrenceScope).toBeUndefined();
    expect(service.updateCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("CALENDAR delete_event on a recurring occurrence", () => {
  let service: StubService;

  beforeEach(() => {
    service = stubService([STANDUP_OCCURRENCE, LUNCH]);
  });

  it("ambiguous intent → clarification, and nothing is deleted", async () => {
    const result = await runHandler({
      service,
      text: "delete my standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(false);
    expect(result.data?.replyContext).toMatchObject({
      scenario: "clarify_delete_event_recurrence_scope",
      facts: expect.stringMatching(/occurrence.*series/s),
      context: { event: STANDUP_OCCURRENCE },
    });
    expect(service.cancelApproval).not.toHaveBeenCalled();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('"just this" phrasing → deletes only the addressed occurrence', async () => {
    const result = await runHandler({
      service,
      text: "delete just this standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("instance");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('"whole series" phrasing → exactly one series-scoped delete call', async () => {
    const result = await runHandler({
      service,
      text: "delete the whole series of my standup",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    // One approval with series scope — never an iteration over occurrences.
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("series");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('"from this one forward" phrasing → one split-scoped cancellation', async () => {
    const result = await runHandler({
      service,
      text: "delete my standup from this one forward",
      parameters: { subaction: "delete_event", query: "standup" },
    });
    expect(result.success).toBe(true);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("this_and_following");
  });

  it("explicit eventId path forwards a structured recurrenceScope", async () => {
    const result = await runHandler({
      service,
      text: "delete that recurring meeting",
      parameters: {
        subaction: "delete_event",
        details: {
          eventId: "standup_20260708T170000Z",
          recurrenceScope: "series",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.eventId).toBe("standup_20260708T170000Z");
    expect(request.recurrenceScope).toBe("series");
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("planner debris in delete scope falls back to explicit user phrasing", async () => {
    const result = await runHandler({
      service,
      text: "delete just this standup",
      parameters: {
        subaction: "delete_event",
        query: "standup",
        details: { recurrenceScope: ",series:" },
      },
    });
    expect(result.success).toBe(true);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrenceScope).toBe("instance");
  });

  it("non-recurring events delete without a scope round-trip", async () => {
    const result = await runHandler({
      service,
      text: "delete my lunch with maya",
      parameters: { subaction: "delete_event", query: "lunch" },
    });
    expect(result.success).toBe(true);
    expect(service.cancelApproval).toHaveBeenCalledTimes(1);
    const request = service.cancelApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.eventId).toBe("evt-lunch");
    expect(request.recurrenceScope).toBeUndefined();
    expect(service.deleteCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("CALENDAR create_event with recurrence", () => {
  it("carries structured RRULE recurrence into the create request", async () => {
    const service = stubService([LUNCH]);
    const result = await runHandler({
      service,
      text: "book a morning run every monday at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Morning Run",
        details: {
          startAt: "2026-07-06T13:00:00.000Z",
          durationMinutes: 30,
          timeZone: "UTC",
          recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(service.scheduleApproval).toHaveBeenCalledTimes(1);
    const request = service.scheduleApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(result.text).toContain("approval queued");
    expect(service.createCalendarEvent).not.toHaveBeenCalled();
  });

  it("accepts recurrence via the rrule alias detail key", async () => {
    const service = stubService([LUNCH]);
    await runHandler({
      service,
      text: "book a morning run every monday at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Morning Run",
        details: {
          startAt: "2026-07-06T13:00:00.000Z",
          rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
        },
      },
    });
    const request = service.scheduleApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  });

  it("one-off creates carry no recurrence", async () => {
    const service = stubService([LUNCH]);
    await runHandler({
      service,
      text: "book lunch tomorrow at 1pm UTC",
      parameters: {
        subaction: "create_event",
        title: "Lunch",
        details: { startAt: "2026-07-06T13:00:00.000Z" },
      },
    });
    const request = service.scheduleApproval.mock.calls[0]?.[0]
      ?.request as Record<string, unknown>;
    expect(request.recurrence).toBeUndefined();
  });
});
