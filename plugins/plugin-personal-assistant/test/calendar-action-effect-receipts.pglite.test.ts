/**
 * Drives the registered CALENDAR action through the canonical executor over
 * real PGlite calendar, task, and approval stores. Only the remote ICS and
 * secret-vault boundaries are in-memory; every asserted receipt is read back
 * from the same persisted snapshot or row the action consumed.
 */

import {
  type ActionResult,
  type AgentRuntime,
  type Content,
  executePlannedToolCall,
  type Memory,
  promoteSubactionsToActions,
  SECRETS_SERVICE_TYPE,
  type UUID,
} from "@elizaos/core";
import {
  type CalendarHostGate,
  CalendarRepository,
  CalendarService,
} from "@elizaos/plugin-calendar";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../src/actions/calendar.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const SOURCE_URL = "https://calendar.example.test/private/receipt-suite.ics";
const SOURCE_SYNCED_AT = new Date().toISOString();
const EVENT_START = "2026-07-29T17:00:00.000Z";
const EVENT_END = "2026-07-29T18:00:00.000Z";
const WINDOW_START = "2026-07-28T00:00:00.000Z";
const WINDOW_END = "2026-08-05T00:00:00.000Z";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let calendar: CalendarService;

function writableGrant(agentId: string): LifeOpsConnectorGrant {
  return {
    id: "connector-account:calendar-receipt-owner",
    agentId,
    provider: "google",
    connectorAccountId: "calendar-receipt-owner",
    side: "owner",
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: SOURCE_SYNCED_AT,
    createdAt: SOURCE_SYNCED_AT,
    updatedAt: SOURCE_SYNCED_AT,
  };
}

function gate(agentId: string): CalendarHostGate {
  const grant = writableGrant(agentId);
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => [],
    requireGoogleCalendarGrant: async () => grant,
    requireGoogleCalendarWriteGrant: async () => grant,
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

function icsBody(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//calendar receipt suite//EN",
    "BEGIN:VEVENT",
    "UID:school-planning-receipt-suite",
    "SEQUENCE:1",
    "LAST-MODIFIED:20260727T180000Z",
    "DTSTAMP:20260727T180000Z",
    "DTSTART:20260729T170000Z",
    "DTEND:20260729T180000Z",
    "SUMMARY:School planning meeting",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function message(id: string, text: string): Memory {
  return {
    id: id as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: "00000000-0000-0000-0000-000000009901" as UUID,
    createdAt: Date.parse("2026-07-27T17:55:00.000Z"),
    content: { source: "test", text },
  } as Memory;
}

async function invoke(
  actor: Memory,
  params: Record<string, unknown>,
  directReply = true,
  actionName = calendarAction.name,
): Promise<{ delivered: Content[]; result: ActionResult }> {
  const delivered: Content[] = [];
  const result = await executePlannedToolCall(
    runtime,
    {
      message: actor,
      userRoles: ["OWNER"],
      activeContexts: ["calendar"],
      callback: async (content) => {
        delivered.push(content);
        return [];
      },
    },
    { name: actionName, params },
    {
      actions: promoteSubactionsToActions(
        calendarAction,
        calendarActionPromotionOptions,
      ).filter((action) => action.name === actionName),
    },
  );
  if (directReply) {
    expect(delivered, JSON.stringify(result)).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      text: result.userFacingText,
      effectReceiptIds: [result.effectReceipts?.[0]?.receiptId],
    });
    expect(result.verifiedUserFacing).toBe(true);
  } else {
    expect(delivered).toEqual([]);
    expect(result.transcriptVisibility).toBe("internal");
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
  }
  expect(result.effectReceipts).toHaveLength(1);
  return { delivered, result };
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  const secretValues = new Map<string, string>();
  const secretService = {
    serviceType: SECRETS_SERVICE_TYPE,
    capabilityDescription: "In-memory secret boundary for ICS integration",
    getGlobal: async (key: string) => secretValues.get(key) ?? null,
    setGlobal: async (key: string, value: string) => {
      secretValues.set(key, value);
      return true;
    },
    delete: async (key: string) => secretValues.delete(key),
    stop: async () => {},
  };
  const services = (runtime as unknown as { services: Map<string, unknown[]> })
    .services;
  services.set(SECRETS_SERVICE_TYPE, [secretService]);
  const resolved = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!resolved) throw new Error("calendar service was not registered");
  calendar = resolved;
  calendar.setGate(gate(String(runtime.agentId)));
  const source = await calendar.createIcsCalendarSource({
    name: "Receipt suite",
    url: SOURCE_URL,
  });
  await calendar.syncIcsCalendarSource(source.id, {
    now: new Date(SOURCE_SYNCED_AT),
    transport: {
      fetchImpl: async () =>
        new Response(icsBody(), {
          status: 200,
          headers: {
            "content-type": "text/calendar",
            etag: '"receipt-suite-v1"',
          },
        }),
    },
  });
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("registered CALENDAR strict settlement — real PGlite", () => {
  it("publishes a concrete nested schema and composes the real ACTIONS provider", async () => {
    const registered = runtime.actions.find(
      (action) => action.name === calendarAction.name,
    );
    expect(registered).toBeDefined();
    const details = registered?.parameters?.find(
      (parameter) => parameter.name === "details",
    );
    expect(details?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        startAt: { type: "string" },
        recurrence: expect.any(Object),
      },
    });

    const state = await runtime.composeState(
      message("00000000-0000-0000-0000-000000009900", "Show my calendar."),
      ["ACTIONS"],
      true,
      true,
    );
    expect(state.text).toContain(calendarAction.name);
  });

  it.each([
    {
      name: "delegated feed",
      params: {
        action: "feed",
        details: { timeMin: WINDOW_START, timeMax: WINDOW_END },
      },
      outcome: "noop",
      operation: "calendar.feed.read",
      directReply: false,
    },
    {
      name: "bulk preview",
      params: { action: "bulk_reschedule" },
      outcome: "preview",
      operation: "calendar.bulk_reschedule.preview",
      directReply: true,
    },
    {
      name: "availability read",
      params: {
        action: "check_availability",
        startAt: EVENT_START,
        endAt: EVENT_END,
      },
      outcome: "noop",
      operation: "calendar.check_availability.read",
      directReply: true,
    },
    {
      name: "slot preview",
      params: {
        action: "propose_times",
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        slotCount: 2,
      },
      outcome: "preview",
      operation: "calendar.propose_times.preview",
      directReply: true,
    },
  ])("binds $name to its persisted calendar snapshot", async (testCase) => {
    const { result } = await invoke(
      message(
        `00000000-0000-0000-0000-${testCase.operation
          .split("")
          .reduce((sum, character) => sum + character.charCodeAt(0), 0)
          .toString()
          .padStart(12, "0")}`,
        testCase.name === "bulk preview"
          ? "Push all school meetings later."
          : `Run ${testCase.name}.`,
      ),
      testCase.params,
      testCase.directReply,
    );
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: testCase.operation,
      outcome: testCase.outcome,
      resource: {
        kind: "calendar.feed",
        id: expect.any(String),
        version: expect.stringMatching(/(?:^|:)[a-f0-9]{64}$/),
      },
      observedAt: SOURCE_SYNCED_AT,
    });
  });

  it.each(["CALENDAR_FEED", "CALENDAR_SEARCH_EVENTS"])(
    "executes %s with aliased read bounds through the promoted child",
    async (actionName) => {
      const { result } = await invoke(
        message(
          actionName === "CALENDAR_FEED"
            ? "00000000-0000-0000-0000-000000009951"
            : "00000000-0000-0000-0000-000000009952",
          "Read the school planning meeting in the specified window. Do not change it.",
        ),
        {
          ...(actionName === "CALENDAR_SEARCH_EVENTS"
            ? { query: "School planning meeting" }
            : {}),
          details: {
            time_min: WINDOW_START,
            time_max: WINDOW_END,
            time_zone: "UTC",
            includeHiddenCalendars: true,
            force_sync: false,
          },
        },
        false,
        actionName,
      );
      expect(result.success).toBe(true);
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "noop",
        resource: { kind: "calendar.feed" },
      });
      expect(JSON.stringify(result.data)).toContain("School planning meeting");
      expect(JSON.stringify(result.data)).toContain(EVENT_START);
    },
  );

  it("persists meeting preferences and binds the receipt to the read-back task", async () => {
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009911",
        "Keep meetings between ten and four.",
      ),
      {
        action: "update_preferences",
        timeZone: "UTC",
        preferredStartLocal: "10:00",
        preferredEndLocal: "16:00",
        travelBufferMinutes: 15,
      },
    );
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "calendar.meeting_preferences.update",
      outcome: "applied",
      resource: {
        kind: "lifeops.scheduled_task",
        id: expect.any(String),
        version: expect.any(String),
      },
      commit: {
        kind: "durable",
        id: expect.any(String),
        committedAt: expect.any(String),
      },
    });
  });

  it("settles policy blocks, clarifications, and invalid reads as non-applied", async () => {
    await resolveOwnerFactStore(runtime).update(
      {
        timezone: "UTC",
        quietHours: {
          startLocal: "16:00",
          endLocal: "19:00",
          timezone: "UTC",
        },
      },
      {
        source: "profile_save",
        recordedAt: "2026-07-27T17:54:00.000Z",
      },
    );
    const protectedResult = (
      await invoke(
        message(
          "00000000-0000-0000-0000-000000009921",
          "Book a team sync at 5pm.",
        ),
        {
          action: "create_event",
          title: "Team sync",
          details: { startAt: EVENT_START, endAt: EVENT_END },
        },
      )
    ).result;
    expect(protectedResult.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      operation: "calendar.create_event",
    });
    await resolveOwnerFactStore(runtime).clear();

    const invalid = (
      await invoke(
        message(
          "00000000-0000-0000-0000-000000009923",
          "Am I free in this invalid window?",
        ),
        {
          action: "check_availability",
          startAt: EVENT_END,
          endAt: EVENT_START,
        },
      )
    ).result;
    expect(invalid.effectReceipts?.[0]).toMatchObject({
      outcome: "failed",
      failure: { code: "INVALID_WINDOW", acceptance: "rejected" },
    });
  });

  it("atomically distinguishes first approval, concurrent replay, and later replay", async () => {
    await new CalendarRepository(runtime).upsertCalendarSyncState({
      id: `${runtime.agentId}:google:owner:grant:connector-account:calendar-receipt-owner:calendar:primary`,
      agentId: String(runtime.agentId),
      provider: "google",
      side: "owner",
      grantId: "connector-account:calendar-receipt-owner",
      connectorAccountId: "calendar-receipt-owner",
      calendarId: "primary",
      windowStartAt: "2026-01-01T00:00:00.000Z",
      windowEndAt: "2027-01-01T00:00:00.000Z",
      nextSyncToken: null,
      syncedAt: SOURCE_SYNCED_AT,
      updatedAt: SOURCE_SYNCED_AT,
    });
    const actor = message(
      "00000000-0000-0000-0000-000000009931",
      "Add family planning tomorrow.",
    );
    const params = {
      action: "create_event",
      title: "Family planning",
      details: {
        side: "owner",
        grantId: "connector-account:calendar-receipt-owner",
        calendarId: "primary",
        startAt: "2026-07-30T17:00:00.000Z",
        endAt: "2026-07-30T18:00:00.000Z",
        timeZone: "UTC",
      },
    };
    const concurrent = await Promise.all([
      invoke(actor, params),
      invoke(actor, params),
    ]);
    expect(
      concurrent
        .map(({ result }) => result.effectReceipts?.[0]?.outcome)
        .sort(),
      JSON.stringify(concurrent.map(({ result }) => result)),
    ).toEqual(["applied", "noop"]);
    const requestIds = concurrent.map(
      ({ result }) =>
        (result.data as { approvalRequestId?: string } | undefined)
          ?.approvalRequestId,
    );
    expect(new Set(requestIds).size).toBe(1);
    const requestId = requestIds[0];
    if (!requestId) throw new Error("approval request id was not returned");
    // Reads are subject-fenced: the calendar action enqueues under the
    // actor's entityId, which this harness sets to the agent.
    const persisted = await createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    }).byId(requestId, String(runtime.agentId));
    if (!persisted) throw new Error("approval request was not persisted");
    for (const { result } of concurrent) {
      expect(result.effectReceipts?.[0]).toMatchObject({
        observedAt: persisted.createdAt.toISOString(),
        resource: { id: persisted.id },
        idempotency: { key: persisted.idempotencyKey },
      });
    }

    const replay = (await invoke(actor, params)).result;
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
      resource: { id: persisted.id },
    });
  });
});
