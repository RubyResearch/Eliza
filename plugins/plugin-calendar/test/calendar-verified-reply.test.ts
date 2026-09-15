/**
 * Settled built-in mutations through the real CALENDAR handler: when the
 * applied event provably matches the user's own words, the internal result
 * carries the verified, turn-completing reply (the MEMORY "Saved: …" shape) and
 * `replyContext.facts` is that same sentence; otherwise the receipt keeps the
 * evaluator-facing facts and no reply flags. The CalendarService is stubbed
 * and the fake runtime has no model; the clock is pinned so "friday" resolves
 * deterministically.
 */

import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

/** Wednesday 2026-09-16, 09:00 in America/New_York. */
const PINNED_NOW = new Date("2026-09-16T13:00:00.000Z");
const OWNER_TIME_ZONE = "America/New_York";

function localEvent(args: {
  externalId: string;
  title: string;
  startAt: string;
  endAt: string;
}): LifeOpsCalendarEvent {
  return {
    id: `agent-1:eliza:owner:grant:eliza-calendar:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: "agent-1",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: false,
    timezone: OWNER_TIME_ZONE,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: '"eliza-1"', version: 1 },
    syncedAt: "2026-09-16T13:00:00.000Z",
    updatedAt: "2026-09-16T13:00:00.000Z",
    grantId: "eliza-calendar",
    connectorAccountId: "eliza-calendar",
  };
}

/** Friday Sep 18, 3:00–4:00 PM EDT. */
const TAILOR = localEvent({
  externalId: "evt-tailor",
  title: "Tailor Appointment",
  startAt: "2026-09-18T19:00:00.000Z",
  endAt: "2026-09-18T20:00:00.000Z",
});

/** Friday Sep 18, 11:00–11:30 AM EDT. */
const HAIRCUT = localEvent({
  externalId: "evt-haircut",
  title: "Haircut",
  startAt: "2026-09-18T15:00:00.000Z",
  endAt: "2026-09-18T15:30:00.000Z",
});

function stubService(args: {
  feedEvents: LifeOpsCalendarEvent[];
  created?: LifeOpsCalendarEvent;
  updated?: LifeOpsCalendarEvent;
}) {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: args.feedEvents,
      source: "cache" as const,
      state: "complete" as const,
      sources: [{ status: "fresh" as const }],
      timeMin: "2025-09-16T00:00:00.000Z",
      timeMax: "2031-09-16T00:00:00.000Z",
      syncedAt: null,
    })),
    getConditionalCalendarMutationTarget: vi.fn(
      async (_url: URL, request: { eventId: string }) =>
        args.feedEvents.find(
          (candidate) => candidate.externalId === request.eventId,
        ) ?? null,
    ),
    prepareCalendarEventCreate: vi.fn(
      async (_url: URL, request: Record<string, unknown>) => ({
        ...request,
        side: "owner" as const,
        grantId: "eliza-calendar",
        calendarId: "primary",
      }),
    ),
    createCalendarEvent: vi.fn(async () => args.created ?? TAILOR),
    updateCalendarEvent: vi.fn(async () => args.updated ?? TAILOR),
    deleteCalendarEvent: vi.fn(async () => undefined),
    scheduleApproval: vi.fn(),
    modifyApproval: vi.fn(),
    cancelApproval: vi.fn(),
  };
}

type StubService = ReturnType<typeof stubService>;

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

function fakeRuntime(service: StubService): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    reportError: vi.fn(),
    getService: (name: string) => (name === "calendar" ? service : null),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000301",
    entityId: "00000000-0000-0000-0000-000000000302",
    roomId: "00000000-0000-0000-0000-000000000303",
    createdAt: PINNED_NOW.getTime(),
    content: { text },
  } as unknown as Memory;
}

async function runHandler(args: {
  service: StubService;
  text: string;
  parameters: Record<string, unknown>;
}): Promise<ActionResult> {
  const action = createCalendarActionRunner(fakeDeps(args.service));
  const callback = vi.fn(async () => []);
  const result = await action.handler(
    fakeRuntime(args.service),
    message(args.text),
    undefined,
    { parameters: args.parameters } as unknown as HandlerOptions,
    callback,
  );
  if (!result) throw new Error("Expected a Calendar action result");
  expect(callback).not.toHaveBeenCalled();
  expect(result.transcriptVisibility).toBe("internal");
  expect(result.effectReceipts).toHaveLength(1);
  expect(result.effectReceipts?.[0]?.outcome).toBe("applied");
  return result;
}

function replyFacts(result: ActionResult): string {
  const replyContext = result.data?.replyContext;
  const facts =
    replyContext && typeof replyContext === "object"
      ? (replyContext as { facts?: unknown }).facts
      : undefined;
  if (typeof facts !== "string") {
    throw new Error("Expected Calendar internal reply facts");
  }
  return facts;
}

function expectVerified(result: ActionResult, sentence: string): void {
  expect(result).toMatchObject({
    success: true,
    turnComplete: true,
    verifiedUserFacing: true,
    userFacingText: sentence,
    userFacingEffectReceiptIds: [result.effectReceipts?.[0]?.receiptId],
  });
  // The verified sentence is also the exact text the lifeops wrapper canonicalizes.
  expect(result.text).toBe(sentence);
  expect(replyFacts(result)).toBe(sentence);
}

function expectEvaluatorHandoff(result: ActionResult): void {
  expect(result.success).toBe(true);
  expect(result.turnComplete).not.toBe(true);
  for (const field of [
    "text",
    "userFacingText",
    "verifiedUserFacing",
    "userFacingEffectReceiptIds",
  ]) {
    expect(result).not.toHaveProperty(field);
  }
}

describe("CALENDAR self-verified settled receipts", () => {
  beforeEach(() => {
    // Only Date is faked: the handler awaits real promises.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"move my tailor appointment to friday at 4pm" applied at 4pm is verified (live shape)', async () => {
    const moved = {
      ...TAILOR,
      startAt: "2026-09-18T20:00:00.000Z",
      endAt: "2026-09-18T21:00:00.000Z",
      metadata: { etag: '"eliza-2"', version: 2 },
    };
    const service = stubService({ feedEvents: [TAILOR], updated: moved });
    const result = await runHandler({
      service,
      text: "move my tailor appointment to friday at 4pm",
      parameters: {
        subaction: "update_event",
        query: "tailor appointment",
        details: { start: "2026-09-18T16:00:00", timeZone: OWNER_TIME_ZONE },
      },
    });
    expect(service.updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: "evt-tailor",
        startAt: "2026-09-18T16:00:00",
        endAt: "2026-09-18T17:00:00",
      }),
    );
    expectVerified(
      result,
      "Moved “Tailor Appointment” to Friday, Sep 18 at 4pm EDT.",
    );
  });

  it("an applied start that is not the stated time keeps the evaluator", async () => {
    const elsewhere = {
      ...TAILOR,
      startAt: "2026-09-18T21:00:00.000Z",
      endAt: "2026-09-18T22:00:00.000Z",
      metadata: { etag: '"eliza-2"', version: 2 },
    };
    const service = stubService({ feedEvents: [TAILOR], updated: elsewhere });
    const result = await runHandler({
      service,
      text: "move my tailor appointment to friday at 4pm",
      parameters: {
        subaction: "update_event",
        query: "tailor appointment",
        details: { start: "2026-09-18T17:00:00", timeZone: OWNER_TIME_ZONE },
      },
    });
    expectEvaluatorHandoff(result);
    expect(replyFacts(result)).toBe(
      "Updated “Tailor Appointment” for Sep 18, 5:00 PM EDT.",
    );
  });

  it("a rename keeps the evaluator even when the message states a time", async () => {
    const renamed = {
      ...TAILOR,
      title: "Tailor fitting",
      metadata: { etag: '"eliza-2"', version: 2 },
    };
    const service = stubService({ feedEvents: [TAILOR], updated: renamed });
    const result = await runHandler({
      service,
      text: "rename my 3pm tailor appointment to tailor fitting",
      parameters: {
        subaction: "update_event",
        query: "tailor appointment",
        details: { newTitle: "Tailor fitting", timeZone: OWNER_TIME_ZONE },
      },
    });
    expectEvaluatorHandoff(result);
  });

  it('"add a dentist appointment friday at 3pm" created at 3pm is verified', async () => {
    const dentist = localEvent({
      externalId: "evt-dentist",
      title: "Dentist appointment",
      startAt: "2026-09-18T19:00:00.000Z",
      endAt: "2026-09-18T20:00:00.000Z",
    });
    const service = stubService({ feedEvents: [], created: dentist });
    const result = await runHandler({
      service,
      text: "add a dentist appointment friday at 3pm",
      parameters: {
        subaction: "create_event",
        title: "Dentist appointment",
        details: { start: "2026-09-18T15:00:00", timeZone: OWNER_TIME_ZONE },
      },
    });
    expect(service.createCalendarEvent).toHaveBeenCalledOnce();
    expectVerified(
      result,
      "Created “Dentist appointment” for Friday, Sep 18 at 3pm EDT.",
    );
  });

  it("a create with a place the sentence cannot show keeps the evaluator", async () => {
    const dentist = {
      ...localEvent({
        externalId: "evt-dentist",
        title: "Dentist appointment",
        startAt: "2026-09-18T19:00:00.000Z",
        endAt: "2026-09-18T20:00:00.000Z",
      }),
      location: "4 Pine St",
    };
    const service = stubService({ feedEvents: [], created: dentist });
    const result = await runHandler({
      service,
      text: "add a dentist appointment friday at 3pm at 4 Pine St",
      parameters: {
        subaction: "create_event",
        title: "Dentist appointment",
        details: {
          start: "2026-09-18T15:00:00",
          timeZone: OWNER_TIME_ZONE,
          location: "4 Pine St",
        },
      },
    });
    expectEvaluatorHandoff(result);
    expect(replyFacts(result)).toBe(
      "Created “Dentist appointment” for Sep 18, 3:00 PM EDT.",
    );
  });

  it('"cancel my haircut" deleting the one matching event is verified', async () => {
    const service = stubService({ feedEvents: [HAIRCUT] });
    const result = await runHandler({
      service,
      text: "cancel my haircut",
      parameters: { subaction: "delete_event", query: "haircut" },
    });
    expect(service.deleteCalendarEvent).toHaveBeenCalledOnce();
    expectVerified(
      result,
      "Deleted “Haircut” (Friday, Sep 18 at 11am EDT) from your calendar.",
    );
  });

  it("a delete whose hint the user never said keeps the evaluator", async () => {
    const service = stubService({ feedEvents: [HAIRCUT] });
    const result = await runHandler({
      service,
      text: "cancel that appointment",
      parameters: { subaction: "delete_event", query: "haircut" },
    });
    expect(service.deleteCalendarEvent).toHaveBeenCalledOnce();
    expectEvaluatorHandoff(result);
    expect(replyFacts(result)).toBe("Deleted “Haircut” from your calendar.");
  });
});
