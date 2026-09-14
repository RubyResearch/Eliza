/**
 * Multi-account source identity and partial-failure semantics against real
 * PGlite persistence, with only the external Google transport substituted.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { GoogleCalendarSyncTokenExpiredError } from "@elizaos/plugin-google-workspace";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConflictDetectAction } from "../src/actions/conflict-detect.js";
import {
  CALENDAR_GUEST_AVAILABILITY_PURPOSE,
  type CalendarGuestAvailabilityGrant,
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

import { LinkedCalendarControlRepository } from "../src/service/linked-calendar-control.js";
import {
  LinkedCalendarRepository,
  linkedCalendarSemanticHash,
} from "../src/service/linked-calendar-sync.js";

const AGENT_ID = "calendar-source-health-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const TIME_MIN = "2026-07-27T00:00:00.000Z";
const TIME_MAX = "2026-07-28T00:00:00.000Z";

function grant(accountId: string): LifeOpsConnectorGrant {
  const timestamp = "2026-07-26T00:00:00.000Z";
  return {
    id: `connector-account:${accountId}`,
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: accountId,
    side: "owner",
    identity: { email: `${accountId}@example.test` },
    identityEmail: `${accountId}@example.test`,
    grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    capabilities: ["google.calendar.read"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function status(
  sourceGrant: LifeOpsConnectorGrant,
): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected: true,
    reason: "connected",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: sourceGrant.identity,
    grantedCapabilities: ["google.calendar.read"],
    grantedScopes: [...sourceGrant.grantedScopes],
    expiresAt: null,
    hasRefreshToken: true,
    grant: linkedSyncEnabled
      ? {
          ...sourceGrant,
          capabilities: [...sourceGrant.capabilities, "google.calendar.write"],
        }
      : sourceGrant,
  };
}

const GRANT_A = grant("account-a");
const GRANT_B = grant("account-b");
const GUEST_ONE_GRANT_ID = "gav_a93a2e0839424cb5895b76937ea99611";
const GUEST_TWO_GRANT_ID = "gav_a652ef2d80384c61a2bfc5ec80f14b88";
const GUEST_MISSING_GRANT_ID = "gav_b4d038153764446b8eafc95ea9d596aa";
const GUEST_ONE_CALENDAR = "child-one@example.test";
const GUEST_TWO_CALENDAR = "child-two@example.test";
const GUEST_MISSING_CALENDAR = "unshared-child@example.test";

function guestGrant(
  grantId: string,
  calendarId: string,
  connectorGrant: LifeOpsConnectorGrant,
): CalendarGuestAvailabilityGrant {
  return {
    grantId,
    principalEntityId: SELF_ENTITY_ID,
    guestEntityId: `guest-${grantId}`,
    provider: "google",
    side: "owner",
    connectorAccountId: connectorGrant.connectorAccountId,
    providerGrantId: connectorGrant.id,
    calendarId,
    purpose: CALENDAR_GUEST_AVAILABILITY_PURPOSE,
    consentRecordedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2099-07-01T00:00:00.000Z",
  };
}

const GUEST_GRANTS = new Map(
  [
    guestGrant(GUEST_ONE_GRANT_ID, GUEST_ONE_CALENDAR, GRANT_A),
    guestGrant(GUEST_TWO_GRANT_ID, GUEST_TWO_CALENDAR, GRANT_B),
    guestGrant(GUEST_MISSING_GRANT_ID, GUEST_MISSING_CALENDAR, GRANT_B),
  ].map((authorization) => [authorization.grantId, authorization]),
);

function googleEvent(accountId: string) {
  return {
    id: "same-provider-event-id",
    calendarId: "primary",
    title:
      accountId === "account-a" && linkedProviderTitle !== null
        ? linkedProviderTitle
        : `Family logistics (${accountId})`,
    status:
      linkedProviderDeleted && accountId === "account-a"
        ? "cancelled"
        : "confirmed",
    start: "2026-07-27T16:00:00.000Z",
    end: "2026-07-27T17:00:00.000Z",
    isAllDay: false,
    timeZone: "UTC",
    htmlLink: null,
    meetLink: null,
    attendees: [],
    location: "",
    description: "",
    organizer: null,
    recurrence: null,
    recurringEventId: null,
    metadata: linkedSyncEnabled
      ? { etag: linkedProviderTitle === null ? '"google-1"' : '"google-2"' }
      : {},
  };
}

let linkedSyncEnabled = false;
let linkedProviderTitle: string | null = null;
let linkedProviderDeleted = false;
let pg: PGlite;
let calendar: CalendarService;
let runtime: IAgentRuntime;
let failAccountA = false;
let failAccountB = false;
let incrementalSyncEnabled = false;
let expireSyncTokenForAccount: string | null = null;
let accountAAccessRole = "owner";
const freeBusyErrors = new Map<string, Set<string>>();
const freeBusyRequests: Array<{
  accountId: string;
  calendarIds: readonly string[];
}> = [];
const eventPageRequests: Array<{
  accountId: string;
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
}> = [];

async function runConflictAction(parameters: Record<string, unknown>) {
  const action = createConflictDetectAction({
    authorize: async () => true,
    resolveTimeZone: async () => "UTC",
  });
  return action.handler(
    runtime,
    {
      id: "00000000-0000-0000-0000-000000000201",
      entityId: "00000000-0000-0000-0000-000000000202",
      roomId: "00000000-0000-0000-0000-000000000203",
      content: { text: "check this time" },
    } as Memory,
    undefined,
    { parameters },
    undefined,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  // Tables come from the production drizzle schema applied through plugin-sql's
  // RuntimeMigrator — the same path agent boot runs — so schema drift fails the
  // suite instead of leaving it green against a hand-maintained copy.
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );

  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) =>
      name === "calendar"
        ? calendar
        : name === "google"
          ? {
              getEvent: async (request: { accountId: string }) =>
                googleEvent(request.accountId),
              listCalendars: async (request: { accountId: string }) => [
                {
                  calendarId: "primary",
                  summary: "Primary",
                  description: null,
                  primary: true,
                  accessRole:
                    request.accountId === "account-a"
                      ? accountAAccessRole
                      : "owner",
                  backgroundColor: null,
                  foregroundColor: null,
                  timeZone: "UTC",
                  selected: true,
                },
              ],
              listEventPage: async (request: {
                accountId: string;
                syncToken?: string;
                timeMin?: string;
                timeMax?: string;
              }) => {
                const { accountId } = request;
                eventPageRequests.push({ ...request });
                if (
                  (accountId === "account-a" && failAccountA) ||
                  (accountId === "account-b" && failAccountB)
                ) {
                  throw new Error(`calendar transport failed for ${accountId}`);
                }
                if (
                  request.syncToken &&
                  expireSyncTokenForAccount === accountId
                ) {
                  expireSyncTokenForAccount = null;
                  throw new GoogleCalendarSyncTokenExpiredError({
                    resource: "events",
                    accountId,
                    calendarId: "primary",
                    cause: new Error("HTTP 410 Gone"),
                  });
                }
                if (request.syncToken) {
                  return {
                    events:
                      accountId === "account-a"
                        ? [
                            {
                              id: "same-provider-event-id",
                              calendarId: "primary",
                              status: "cancelled",
                            },
                          ]
                        : [
                            {
                              ...googleEvent(accountId),
                              title: "Updated family logistics",
                            },
                          ],
                    nextPageToken: null,
                    nextSyncToken: `sync-${accountId}-2`,
                  };
                }
                return {
                  events: [googleEvent(accountId)],
                  nextPageToken: null,
                  nextSyncToken: incrementalSyncEnabled
                    ? `sync-${accountId}-1`
                    : null,
                };
              },
              queryFreeBusy: async (request: {
                accountId: string;
                calendarIds: readonly string[];
                timeMin: string;
                timeMax: string;
              }) => {
                freeBusyRequests.push({
                  accountId: request.accountId,
                  calendarIds: [...request.calendarIds],
                });
                const failing =
                  freeBusyErrors.get(request.accountId) ?? new Set<string>();
                return {
                  timeMin: request.timeMin,
                  timeMax: request.timeMax,
                  calendars: Object.fromEntries(
                    request.calendarIds.map((calendarId) => [
                      calendarId,
                      {
                        busy: failing.has(calendarId)
                          ? []
                          : [
                              {
                                start: "2026-07-27T15:30:00.000Z",
                                end: "2026-07-27T16:00:00.000Z",
                              },
                            ],
                        errors: failing.has(calendarId)
                          ? [{ domain: "calendar", reason: "notFound" }]
                          : [],
                      },
                    ]),
                  ),
                };
              },
            }
          : null,
  } as unknown as IAgentRuntime;

  const gate: CalendarHostGate = {
    getGoogleConnectorAccounts: async () => [status(GRANT_A), status(GRANT_B)],
    resolveGuestAvailabilityGrants: async (request) =>
      request.grantIds.map((grantId) => {
        const authorization = GUEST_GRANTS.get(grantId);
        if (
          !authorization ||
          authorization.principalEntityId !== request.principalEntityId ||
          authorization.purpose !== request.purpose
        ) {
          throw new Error("Guest availability grant is not authorized.");
        }
        return authorization;
      }),
    requireGoogleCalendarGrant: async (_requestUrl, _mode, _side, grantId) => {
      const resolved = [GRANT_A, GRANT_B].find(
        (candidate) => candidate.id === grantId,
      );
      if (!resolved) {
        throw new Error(`Unknown test grant: ${grantId}`);
      }
      return resolved;
    },
    requireGoogleCalendarWriteGrant: async () => GRANT_A,
    createReminderPlan: async () => undefined,
    updateReminderPlan: async () => undefined,
    deleteReminderPlan: async () => undefined,
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => undefined,
  };

  calendar = new CalendarService(runtime);
  calendar.setGate(gate);
});

beforeEach(async () => {
  linkedSyncEnabled = false;
  linkedProviderTitle = null;
  linkedProviderDeleted = false;
  await pg.query("DELETE FROM app_calendar.linked_calendar_control_mutations");
  await pg.query("DELETE FROM app_calendar.linked_calendar_control");
  await pg.query("DELETE FROM app_calendar.linked_calendar_events");
  failAccountA = false;
  failAccountB = false;
  incrementalSyncEnabled = false;
  expireSyncTokenForAccount = null;
  accountAAccessRole = "owner";
  freeBusyErrors.clear();
  freeBusyRequests.length = 0;
  eventPageRequests.length = 0;
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  for (const sourceGrant of [GRANT_A, GRANT_B]) {
    await calendar.setCalendarIncluded(INTERNAL_URL, {
      provider: "google",
      side: "owner",
      grantId: sourceGrant.id,
      connectorAccountId: sourceGrant.connectorAccountId,
      calendarId: "primary",
      includeInFeed: true,
      expectedVersion: 0,
    });
  }
});

afterAll(async () => {
  await pg.close();
});

describe("CalendarService source truth", () => {
  it("returns the reconciled local snapshot on the first provider edit and deletion read", async () => {
    const created = await calendar.createCalendarEventMutation(INTERNAL_URL, {
      title: googleEvent("account-a").title,
      startAt: "2026-07-27T16:00:00.000Z",
      endAt: "2026-07-27T17:00:00.000Z",
      timeZone: "UTC",
      idempotencyKey: "linked-first-response",
    });
    const event = created.event;
    if (!event) throw new Error("Expected a persisted local event");
    const links = new LinkedCalendarRepository(runtime);
    const link = await links.create({
      agentId: AGENT_ID,
      localEventId: event.id,
      connectorAccountId: "account-a",
      providerCalendarId: "primary",
      localRevision: 1,
    });
    await links.save(link, {
      providerEventId: "same-provider-event-id",
      providerEtag: '"google-1"',
      state: "clean",
      pendingOperation: null,
      lastCommonSemanticHash: linkedCalendarSemanticHash({
        title: event.title,
        description: event.description,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        timeZone: "UTC",
        isAllDay: false,
        attendees: [],
      }),
    });
    linkedSyncEnabled = true;
    const controls = new LinkedCalendarControlRepository(runtime);
    const initial = await controls.read();
    const selected = await controls.selectDestination(initial.revision, {
      connectorAccountId: "account-a",
      providerCalendarId: "primary",
    });
    await controls.resume(selected.revision);
    linkedProviderTitle = "Pickup changed in Google";
    const request = { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true };
    const edited = await calendar.getCalendarFeed(INTERNAL_URL, request);
    const localEvents = edited.events.filter(
      (item) => item.provider === "eliza",
    );
    expect(localEvents.map((item) => [item.id, item.title])).toEqual([
      [event.id, linkedProviderTitle],
    ]);
    expect(
      edited.events.filter((item) => item.connectorAccountId === "account-a"),
    ).toEqual([]);
    expect(
      edited.events
        .filter((item) => item.connectorAccountId === "account-b")
        .map((item) => item.title),
    ).toEqual(["Family logistics (account-b)"]);
    expect(localEvents[0].metadata.deduplication).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          provider: "google",
          connectorAccountId: "account-a",
        }),
      ]),
    });
    linkedProviderDeleted = true;
    const deleted = await calendar.getCalendarFeed(INTERNAL_URL, request);
    expect(
      deleted.events.some(
        (item) =>
          item.id === event.id || item.connectorAccountId === "account-a",
      ),
    ).toBe(false);
    expect(await calendar.getCalendarEventById(event.id)).toBeNull();
    expect(await links.getByLocalEvent(AGENT_ID, event.id)).toMatchObject({
      state: "paused",
      lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
    });
  });

  it("keeps identical calendar and event ids distinct across accounts", async () => {
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(2);
    expect(new Set(feed.events.map((event) => event.id)).size).toBe(2);
    expect(new Set(feed.sources.map((source) => source.key.grantId))).toEqual(
      new Set(["eliza-calendar", GRANT_A.id, GRANT_B.id]),
    );
  });

  it("returns a partial feed when one live account fails", async () => {
    failAccountB = true;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events).toHaveLength(1);
    expect(
      feed.sources.find((source) => source.key.grantId === GRANT_B.id)?.status,
    ).toBe("error");
  });

  it("retains a failed account as explicitly stale when cache exists", async () => {
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    failAccountB = true;

    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events).toHaveLength(2);
    const stale = feed.sources.find(
      (source) => source.key.grantId === GRANT_B.id,
    );
    expect(stale?.status).toBe("stale");
    expect(stale?.error?.code).toBe("CALENDAR_SOURCE_ERROR");
  });

  it("reports failed Google sources separately from the available built-in calendar", async () => {
    failAccountA = true;
    failAccountB = true;

    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.events).toEqual([]);
    expect(feed.state).toBe("partial");
    expect(
      feed.sources
        .filter((source) => source.key.provider === "google")
        .map((source) => [source.key.grantId, source.status]),
    ).toEqual([
      [GRANT_A.id, "error"],
      [GRANT_B.id, "error"],
    ]);
    expect(
      feed.sources.find((source) => source.key.provider === "eliza"),
    ).toMatchObject({ status: "fresh" });
  });

  it("applies account-scoped incremental tombstones and updates without rereading full windows", async () => {
    incrementalSyncEnabled = true;
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    eventPageRequests.length = 0;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]?.grantId).toBe(GRANT_B.id);
    expect(feed.events[0]?.title).toBe("Updated family logistics");
    expect(eventPageRequests).toHaveLength(2);
    expect(
      eventPageRequests.every(
        (request) =>
          Boolean(request.syncToken) &&
          request.timeMin === undefined &&
          request.timeMax === undefined,
      ),
    ).toBe(true);
  });

  it("recovers an expired account cursor with a full snapshot while other accounts stay incremental", async () => {
    incrementalSyncEnabled = true;
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expireSyncTokenForAccount = "account-a";
    eventPageRequests.length = 0;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(2);
    expect(
      eventPageRequests.filter((request) => request.accountId === "account-a"),
    ).toHaveLength(2);
    expect(
      eventPageRequests.some(
        (request) => request.accountId === "account-a" && !request.syncToken,
      ),
    ).toBe(true);
  });

  it("queries each guest only through the account bound by its host grant", async () => {
    const result = await calendar.getCalendarFreeBusy(INTERNAL_URL, {
      principalEntityId: SELF_ENTITY_ID,
      guestAvailabilityGrantIds: [GUEST_ONE_GRANT_ID, GUEST_TWO_GRANT_ID],
      timeMin: "2026-07-27T15:30:00.000Z",
      timeMax: "2026-07-27T16:00:00.000Z",
      timeZone: "UTC",
    });

    expect(freeBusyRequests).toEqual([
      {
        accountId: "account-a",
        calendarIds: [GUEST_ONE_CALENDAR],
      },
      {
        accountId: "account-b",
        calendarIds: [GUEST_TWO_CALENDAR],
      },
    ]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.status === "fresh")).toBe(
      true,
    );
    expect(
      result.sources.every((source) => source.visibility === "busy_only"),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(GUEST_ONE_CALENDAR);
    expect(serialized).not.toContain(GUEST_TWO_CALENDAR);
    expect(serialized).not.toContain("notFound");
  });

  it("fails closed without trying another account when a bound calendar is unavailable", async () => {
    freeBusyErrors.set("account-b", new Set([GUEST_MISSING_CALENDAR]));

    const result = await calendar.getCalendarFreeBusy(INTERNAL_URL, {
      principalEntityId: SELF_ENTITY_ID,
      guestAvailabilityGrantIds: [GUEST_ONE_GRANT_ID, GUEST_MISSING_GRANT_ID],
      timeMin: "2026-07-27T15:30:00.000Z",
      timeMax: "2026-07-27T16:00:00.000Z",
    });

    expect(result.sources.map((source) => source.status)).toEqual([
      "fresh",
      "error",
    ]);
    expect(freeBusyRequests).toEqual([
      {
        accountId: "account-a",
        calendarIds: [GUEST_ONE_CALENDAR],
      },
      {
        accountId: "account-b",
        calendarIds: [GUEST_MISSING_CALENDAR],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(GUEST_MISSING_CALENDAR);
  });

  it("uses production free/busy by default and exposes only anonymous busy conflicts", async () => {
    const result = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T15:30:00.000Z",
        end: "2026-07-27T16:00:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T15:30:00.000Z",
        endISO: "2026-07-27T16:00:00.000Z",
        attendees: ["child@example.test"],
        guestAvailabilityGrantIds: [GUEST_ONE_GRANT_ID],
      },
    })) as {
      success: boolean;
      data: {
        completeness: string;
        conflicts: Array<{
          eventA: { title: string; kind: string; attendees: string[] };
          eventB: { title: string; kind: string; attendees: string[] };
        }>;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.completeness).toBe("complete");
    const busy = result.data.conflicts
      .flatMap((conflict) => [conflict.eventA, conflict.eventB])
      .find((event) => event.kind === "guest_busy");
    expect(busy).toMatchObject({
      title: "Busy",
      kind: "guest_busy",
      attendees: [],
    });
  });

  it("propagates freeBusyReader visibility into anonymous owner-calendar conflicts", async () => {
    accountAAccessRole = "freeBusyReader";
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    const privateSource = feed.sources.find(
      (source) => source.key.grantId === GRANT_A.id,
    );
    expect(privateSource).toMatchObject({
      accessRole: "freeBusyReader",
      visibility: "busy_only",
    });

    const result = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T16:15:00.000Z",
        end: "2026-07-27T16:30:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T16:15:00.000Z",
        endISO: "2026-07-27T16:30:00.000Z",
      },
    })) as { data: { conflicts: unknown[] } };

    expect(JSON.stringify(result.data.conflicts)).not.toContain(
      "Family logistics (account-a)",
    );
    expect(JSON.stringify(result.data.conflicts)).toContain('"title":"Busy"');
  });

  it("persists idempotent travel and hold reservations that block through the real feed", async () => {
    const initial = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    const parent = initial.events.find((event) => event.grantId === GRANT_A.id);
    expect(parent).toBeDefined();
    if (!parent) return;

    await calendar.reserveTravelBuffer({
      eventId: parent.id,
      bufferMinutes: 30,
      method: "driving",
    });
    await calendar.reserveTravelBuffer({
      eventId: parent.id,
      bufferMinutes: 30,
      method: "driving",
    });
    await calendar.reserveCalendarAvailability({
      eventId: parent.id,
      kind: "hold",
      startAt: "2026-07-27T14:00:00.000Z",
      endAt: "2026-07-27T14:30:00.000Z",
      idempotencyKey: "school-pickup-hold",
    });

    const rows = await pg.query<{
      metadata_json: string;
      start_at: string;
      end_at: string;
    }>(
      "SELECT metadata_json, start_at, end_at FROM app_calendar.life_calendar_events WHERE metadata_json LIKE '%locallyManagedAvailability%' ORDER BY start_at",
    );
    expect(rows.rows).toHaveLength(2);
    const travelRow = rows.rows.find((row) =>
      row.metadata_json.includes('"availabilityKind":"travel"'),
    );
    expect(travelRow).toMatchObject({
      start_at: "2026-07-27T15:30:00.000Z",
      end_at: "2026-07-27T16:00:00.000Z",
    });

    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    const travelResult = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T15:45:00.000Z",
        end: "2026-07-27T16:00:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T15:45:00.000Z",
        endISO: "2026-07-27T16:00:00.000Z",
      },
    })) as {
      data: {
        conflicts: Array<{
          reasons: string[];
          eventA: { kind: string };
          eventB: { kind: string };
        }>;
      };
    };
    expect(
      travelResult.data.conflicts.some(
        (conflict) =>
          conflict.reasons.includes("travel") &&
          [conflict.eventA.kind, conflict.eventB.kind].includes("travel"),
      ),
    ).toBe(true);

    const holdResult = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T14:15:00.000Z",
        end: "2026-07-27T14:30:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T14:15:00.000Z",
        endISO: "2026-07-27T14:30:00.000Z",
      },
    })) as {
      data: {
        conflicts: Array<{
          eventA: { kind: string };
          eventB: { kind: string };
        }>;
      };
    };
    expect(
      holdResult.data.conflicts.some((conflict) =>
        [conflict.eventA.kind, conflict.eventB.kind].includes("hold"),
      ),
    ).toBe(true);
  });
});
