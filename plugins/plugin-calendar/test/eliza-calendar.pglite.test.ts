/**
 * Exercises the built-in Eliza calendar through CalendarService against the
 * production PGlite schema. External providers use disconnected or deterministic adapters so default
 * discovery, exact-once creation, feed truth, and versioned writes are proven
 * without a connector or a second event store.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
import type { LifeOpsReminderPlan } from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCalendarActionRunner } from "../src/actions/calendar-handler.js";
import { __testing } from "../src/apple-calendar.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";
import { LinkedCalendarControlRepository } from "../src/service/linked-calendar-control.js";
import { LinkedCalendarRepository } from "../src/service/linked-calendar-sync.js";

const AGENT_ID = "eliza-calendar-pglite-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const WINDOW = {
  timeMin: "2026-08-01T00:00:00.000Z",
  timeMax: "2026-09-01T00:00:00.000Z",
};

let pg: PGlite;
let service: CalendarService;
let runtime: IAgentRuntime;
const reminderPlans: LifeOpsReminderPlan[] = [];

function gate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    createReminderPlan: async (plan) => {
      reminderPlans.push(plan);
    },
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

function connectedGoogleGate(): CalendarHostGate {
  const timestamp = "2026-08-30T12:00:00.000Z";
  const grant = {
    id: "connector-account:shawgotbags",
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: "shawgotbags",
    side: "owner",
    identity: { email: "shawgotbags@gmail.com" },
    identityEmail: "shawgotbags@gmail.com",
    grantedScopes: ["https://www.googleapis.com/auth/calendar"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  return {
    ...gate(),
    getGoogleConnectorAccounts: async () => [
      {
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
        preferredByAgent: true,
        cloudConnectionId: null,
        identity: grant.identity,
        grantedCapabilities: [...grant.capabilities],
        grantedScopes: [...grant.grantedScopes],
        expiresAt: null,
        hasRefreshToken: true,
        grant,
      },
    ],
  } as CalendarHostGate;
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: (serviceType: string) =>
      serviceType === CalendarService.serviceType ? service : null,
    reportError: async () => {},
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
  __testing.setNativeCalendarBridgeForTest(null);
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.linked_calendar_control_mutations");
  await pg.query("DELETE FROM app_calendar.linked_calendar_control");
  await pg.query("DELETE FROM app_calendar.linked_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  reminderPlans.length = 0;
  service.setGate(gate());
});

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

describe("built-in Eliza calendar (real PGlite)", { timeout: 30_000 }, () => {
  async function runUpdate(
    text: string,
    details: Record<string, unknown>,
    extractedUpdate: Record<string, unknown>,
    expectedSuccess = true,
  ) {
    const action = createCalendarActionRunner({
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async ({ actionType }) =>
        actionType === "lifeops.calendar.extract_update_event"
          ? {
              rawResponse: JSON.stringify(extractedUpdate),
              parsed: extractedUpdate,
            }
          : null,
      ),
      recentConversationTexts: vi.fn(async () => []),
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-0000-0000-000000000101",
        entityId: "00000000-0000-0000-0000-000000000102",
        roomId: "00000000-0000-0000-0000-000000000103",
        content: { text },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "update_event",
          query: "Willow Harbor QA",
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "UTC",
            ...WINDOW,
            ...details,
          },
        },
      },
    );
    expect(result?.success).toBe(expectedSuccess);
    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(1);
    return feed.events[0];
  }

  const originalEvent = {
    title: "Willow Harbor QA",
    description: "Bring the revised agenda and preserve these notes.",
    location: "Meeting room 3",
    startAt: "2026-08-09T10:00:00.000Z",
    endAt: "2026-08-09T10:15:00.000Z",
    timeZone: "UTC",
    idempotencyKey: "calendar-update-field-preservation",
  };

  it.each([
    ["omitted", {}],
    [
      "blank",
      {
        title: "",
        description: "",
        location: "",
        recurrence: "",
        timeZone: "",
      },
    ],
    [
      "null",
      {
        title: null,
        description: null,
        location: null,
        recurrence: null,
        timeZone: null,
      },
    ],
  ])(
    "preserves saved metadata when a move extractor returns %s unchanged fields",
    async (_label, extracted) => {
      const created = await service.createCalendarEventMutation(
        INTERNAL_URL,
        originalEvent,
      );
      const moved = await runUpdate(
        "Move Willow Harbor QA to 11 AM and keep its 15-minute duration and notes.",
        {
          startAt: "2026-08-09T11:00:00.000Z",
          endAt: "2026-08-09T11:15:00.000Z",
        },
        extracted,
      );
      expect(moved).toMatchObject({
        id: created.event?.id,
        title: originalEvent.title,
        description: originalEvent.description,
        location: originalEvent.location,
        startAt: "2026-08-09T11:00:00.000Z",
        endAt: "2026-08-09T11:15:00.000Z",
        recurrence: null,
        timezone: "UTC",
      });
    },
  );

  it.each(["description", "location"] as const)(
    "clears only an explicitly selected %s field and preserves timing",
    async (field) => {
      await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
      const updated = await runUpdate(
        `Clear the ${field} from Willow Harbor QA and keep everything else.`,
        { clearFields: [field] },
        {
          title: "",
          description: "",
          location: "",
          startAt: "",
          endAt: "",
          timeZone: "",
          recurrence: "",
        },
      );
      expect(updated).toMatchObject({
        title: originalEvent.title,
        description: field === "description" ? "" : originalEvent.description,
        location: field === "location" ? "" : originalEvent.location,
        startAt: originalEvent.startAt,
        endAt: originalEvent.endAt,
        timezone: "UTC",
      });
    },
  );

  it("applies an explicit clear extracted from the request without clearing other fields", async () => {
    await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
    const updated = await runUpdate(
      "Remove the notes from Willow Harbor QA.",
      {},
      { clearFields: ["description"] },
    );
    expect(updated).toMatchObject({
      title: originalEvent.title,
      description: "",
      location: originalEvent.location,
      startAt: originalEvent.startAt,
      endAt: originalEvent.endAt,
    });
  });

  it("preserves explicit replacements when extraction proposes a conflicting clear", async () => {
    await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
    const updated = await runUpdate(
      "Set Willow Harbor QA's notes to Bring the slides and move it to Meeting room 4.",
      { description: "Bring the slides", location: "Meeting room 4" },
      { clearFields: ["description", "location"] },
    );
    expect(updated).toMatchObject({
      title: originalEvent.title,
      description: "Bring the slides",
      location: "Meeting room 4",
      startAt: originalEvent.startAt,
      endAt: originalEvent.endAt,
    });
  });

  it("does not mutate an event when the same update both replaces and clears a field", async () => {
    const created = await service.createCalendarEventMutation(
      INTERNAL_URL,
      originalEvent,
    );
    const unchanged = await runUpdate(
      "Update Willow Harbor QA's notes.",
      { description: "Bring the slides", clearFields: ["description"] },
      {},
      false,
    );
    expect(unchanged).toMatchObject({
      title: originalEvent.title,
      description: originalEvent.description,
      location: originalEvent.location,
      metadata: { etag: created.event?.metadata.etag },
    });
  });

  it("is the fresh writable default when no external account is connected", async () => {
    const calendars = await service.listCalendars(INTERNAL_URL);
    expect(calendars[0]).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      primary: true,
      accessRole: "owner",
    });

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed).toMatchObject({
      state: "complete",
      events: [],
      sources: [
        {
          key: {
            provider: "eliza",
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
          },
          status: "fresh",
        },
      ],
    });
  });

  it("creates once, replays idempotently, and returns the event through the canonical feed", async () => {
    const request = {
      title: "Demo with Shaw",
      startAt: "2026-08-06T23:00:00.000Z",
      endAt: "2026-08-07T00:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "demo-with-shaw-2026-08-06",
    };
    const first = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(first.event).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      title: "Demo with Shaw",
      metadata: { version: 1, etag: '"eliza-1"' },
    });
    const reminderCount = reminderPlans.length;
    expect(reminderCount).toBeGreaterThan(0);

    const replay = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(replay.event?.id).toBe(first.event?.id);
    expect(reminderPlans).toHaveLength(reminderCount);
    const rows = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_events",
    );
    expect(rows.rows[0]?.count).toBe("1");

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.events.map((event) => event.title)).toEqual(["Demo with Shaw"]);
  });

  it("uses event ETags for atomic update and delete", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Calendar rehearsal",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "calendar-rehearsal",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");

    const updated = await service.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      title: "Calendar rehearsal moved",
      expectedProviderVersion: '"eliza-1"',
    });
    expect(updated).toMatchObject({
      title: "Calendar rehearsal moved",
      metadata: { version: 2, etag: '"eliza-2"' },
    });

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        title: "Stale update",
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await service.deleteCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-2"',
    });
    expect(await service.getCalendarEventById(event.id)).toBeNull();
  });

  it("durably queues built-in create, update, and delete for the explicitly selected Google calendar", async () => {
    const controls = new LinkedCalendarControlRepository(runtime);
    const initial = await controls.read();
    const selected = await controls.selectDestination(initial.revision, {
      connectorAccountId: "shawgotbags",
      providerCalendarId: "reviewed-calendar",
    });
    await controls.resume(selected.revision);
    service.setGate(connectedGoogleGate());
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "School pickup",
      startAt: "2026-08-12T19:00:00.000Z",
      endAt: "2026-08-12T20:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "school-pickup-linked",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    await expect
      .poll(async () => {
        const row = await pg.query<{
          connector_account_id: string;
          provider_calendar_id: string;
          pending_operation: string;
        }>(
          "SELECT connector_account_id, provider_calendar_id, pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0];
      })
      .toMatchObject({
        connector_account_id: "shawgotbags",
        provider_calendar_id: "reviewed-calendar",
        pending_operation: "create",
      });

    await service.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      title: "School pickup moved",
      expectedProviderVersion: '"eliza-1"',
    });
    await expect
      .poll(async () => {
        const row = await pg.query<{ local_revision: number }>(
          "SELECT local_revision FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0]?.local_revision;
      })
      .toBe(2);

    await service.deleteCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-2"',
    });
    await expect
      .poll(async () => {
        const row = await pg.query<{ pending_operation: string }>(
          "SELECT pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0]?.pending_operation;
      })
      .toBe("delete");
  });

  it.each(["read", "write"])(
    "handles a %s failure without losing dispatch safety",
    async (failureAt) => {
      const created = await service.createCalendarEventMutation(INTERNAL_URL, {
        title: "Credential readiness",
        startAt: "2026-08-14T19:00:00.000Z",
        endAt: "2026-08-14T20:00:00.000Z",
        timeZone: "America/New_York",
        idempotencyKey: "credential-readiness",
      });
      if (!created.event)
        throw new Error("Expected a persisted built-in event");
      const event = created.event;
      const links = new LinkedCalendarRepository(runtime);
      const link = await links.create({
        agentId: AGENT_ID,
        localEventId: event.id,
        connectorAccountId: "shawgotbags",
        providerCalendarId: "reviewed-calendar",
        localRevision: 1,
      });
      let credentialsReady = failureAt === "write";
      let writes = 0;
      const google = {
        findEventByIdempotencyKey: async () => {
          if (!credentialsReady)
            throw new Error("Credential store is not ready");
          return null;
        },
        createEvent: async () => {
          writes += 1;
          if (failureAt === "write")
            throw new Error("Connection lost after dispatch");
          return {
            id: "credential-ready-event",
            title: event.title,
            start: event.startAt,
            end: event.endAt,
            timeZone: event.timezone,
            metadata: { etag: '"v1"' },
          };
        },
      };
      const scopedRuntime = {
        ...runtime,
        getService: (name: string) =>
          name === "google" ? google : runtime.getService(name),
      } as unknown as IAgentRuntime;
      const retryService = new CalendarService(scopedRuntime);
      retryService.setGate(connectedGoogleGate());
      const controls = new LinkedCalendarControlRepository(runtime);
      const initial = await controls.read();
      const selected = await controls.selectDestination(initial.revision, {
        connectorAccountId: "shawgotbags",
        providerCalendarId: "reviewed-calendar",
      });
      await controls.resume(selected.revision);
      if (failureAt === "write") {
        const failed = await retryService.executeLinkedCalendarReconciliation(
          link.id,
          {
            expectedUpdatedAt: link.updatedAt,
            idempotencyKey: "uncertain-write",
          },
        );
        expect(failed.outcome).toBe("quarantined");
        expect(writes).toBe(1);
        expect((await controls.read()).dispatch?.linkId).toBe(link.id);
        const retried = await retryService.executeLinkedCalendarReconciliation(
          link.id,
          {
            expectedUpdatedAt: failed.link.updatedAt,
            idempotencyKey: "do-not-repeat-write",
          },
        );
        expect(retried.outcome).toBe("paused");
        expect(writes).toBe(1);
        return;
      }
      await expect(
        retryService.executeLinkedCalendarReconciliation(link.id, {
          expectedUpdatedAt: link.updatedAt,
          idempotencyKey: "credential-failure",
        }),
      ).rejects.toThrow("Credential store is not ready");
      expect(writes).toBe(0);
      expect((await controls.read()).dispatch).toBeNull();
      credentialsReady = true;
      const current = await links.getById(AGENT_ID, link.id);
      if (!current) throw new Error("Expected queued link");
      const result = await retryService.executeLinkedCalendarReconciliation(
        link.id,
        {
          expectedUpdatedAt: current.updatedAt,
          idempotencyKey: "credential-retry",
        },
      );
      expect(result.outcome).toBe("pushed");
      expect(result.link.state).toBe("clean");
      expect(writes).toBe(1);
      expect((await controls.read()).dispatch).toBeNull();
    },
  );

  it("keeps existing local events unlinked until a destination is selected and activated", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Created before Google",
      startAt: "2026-08-14T19:00:00.000Z",
      endAt: "2026-08-14T20:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "created-before-google",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    expect(
      (await pg.query("SELECT id FROM app_calendar.linked_calendar_events"))
        .rows,
    ).toHaveLength(0);

    service.setGate(connectedGoogleGate());

    const controls = new LinkedCalendarControlRepository(runtime);
    const initial = await controls.read();
    expect(initial.paused).toBe(true);
    expect(
      (await pg.query("SELECT id FROM app_calendar.linked_calendar_events"))
        .rows,
    ).toHaveLength(0);
    const selected = await controls.selectDestination(initial.revision, {
      connectorAccountId: "shawgotbags",
      providerCalendarId: "reviewed-calendar",
    });
    await controls.resume(selected.revision);
    service.setGate(connectedGoogleGate());

    await expect
      .poll(async () => {
        const row = await pg.query<{
          local_event_id: string;
          connector_account_id: string;
          provider_calendar_id: string;
          pending_operation: string;
        }>(
          "SELECT local_event_id, connector_account_id, provider_calendar_id, pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0];
      })
      .toMatchObject({
        local_event_id: event.id,
        connector_account_id: "shawgotbags",
        provider_calendar_id: "reviewed-calendar",
        pending_operation: "create",
      });
  });

  it("recovers a persisted uncertain create through the owner service without resuming or sending", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Synthetic recovery",
      startAt: "2026-08-14T19:00:00.000Z",
      endAt: "2026-08-14T20:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "create-recovery-fixture",
    });
    if (!created.event) throw new Error("Expected a persisted built-in event");
    const event = created.event;
    const destination = {
      connectorAccountId: "shawgotbags",
      providerCalendarId: "reviewed-calendar",
    };
    const links = new LinkedCalendarRepository(runtime);
    let link = await links.create({
      agentId: AGENT_ID,
      localEventId: event.id,
      ...destination,
      localRevision: 1,
    });
    link = await links.save(link, {
      state: "quarantined",
      lastErrorCode: "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
    });
    const controls = new LinkedCalendarControlRepository(runtime);
    const initial = await controls.read();
    const selected = await controls.selectDestination(
      initial.revision,
      destination,
    );
    const active = await controls.resume(selected.revision);
    await controls.acquireDispatch(active.revision, link.id, destination);
    const paused = await controls.pause(active.revision);
    const lookup = vi.fn(async () => ({
      id: "provider-accepted-event",
      calendarId: destination.providerCalendarId,
      title: event.title,
      description: event.description,
      location: event.location,
      start: event.startAt,
      end: event.endAt,
      timeZone: event.timezone,
      attendees: [],
      metadata: { etag: '"accepted-v1"' },
    }));
    const google = {
      findEventByIdempotencyKey: lookup,
      listCalendars: async () => [
        {
          calendarId: destination.providerCalendarId,
          summary: "Recovery calendar",
          description: null,
          primary: false,
          accessRole: "owner",
          backgroundColor: null,
          foregroundColor: null,
          timeZone: "America/New_York",
          selected: true,
        },
      ],
      createEvent: async () => {
        throw new Error("Recovery must not create an event");
      },
      updateEvent: async () => {
        throw new Error("Recovery must not update an event");
      },
      deleteEvent: async () => {
        throw new Error("Recovery must not delete an event");
      },
    };
    const recoveryRuntime = {
      ...runtime,
      getService: (name: string) =>
        name === "google" ? google : runtime.getService(name),
    } as unknown as IAgentRuntime;
    const recovery = new CalendarService(recoveryRuntime);
    recovery.setGate(connectedGoogleGate());
    const result = await recovery.executeLinkedCalendarControl(INTERNAL_URL, {
      operation: "recover",
      expectedRevision: paused.revision,
      idempotencyKey: "recover-owner-review",
    });
    expect(result.paused).toBe(true);
    expect(result.pendingDispatch).toBeNull();
    expect(lookup).toHaveBeenCalledExactlyOnceWith({
      accountId: destination.connectorAccountId,
      calendarId: destination.providerCalendarId,
      idempotencyKey: link.idempotencyKey,
    });
    expect(await links.getById(AGENT_ID, link.id)).toMatchObject({
      state: "clean",
      pendingOperation: null,
      providerEventId: "provider-accepted-event",
    });
    await expect(
      recovery.executeLinkedCalendarControl(INTERNAL_URL, {
        operation: "resume",
        expectedRevision: paused.revision,
        idempotencyKey: "stale-resume",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("resolves an unscoped mutation target to the built-in event without hijacking external grants", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Unscoped lookup",
      startAt: "2026-08-11T18:00:00.000Z",
      endAt: "2026-08-11T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "unscoped-lookup",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");

    // A planner that omits grantId still binds to the built-in event.
    await expect(
      service.getConditionalCalendarMutationTarget(INTERNAL_URL, {
        eventId: event.externalId,
      }),
    ).resolves.toMatchObject({
      id: event.id,
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
    });

    // An unknown external id must NOT be claimed by the built-in calendar;
    // it falls through to external-provider resolution (disconnected here).
    await expect(
      service.getConditionalCalendarMutationTarget(INTERNAL_URL, {
        eventId: "google-event-id-that-is-not-built-in",
      }),
    ).rejects.toThrow();
  });

  it("rejects unsupported or invalid built-in mutations without changing the event", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Keep this event",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "built-in-mutation-guards",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    const base = {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-1"',
    };

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, { ...base, title: "   " }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_EVENT_TITLE_REQUIRED",
    });
    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        ...base,
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
    });
    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        ...base,
        notifyAttendees: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
    });

    await expect(service.getCalendarEventById(event.id)).resolves.toMatchObject(
      {
        title: "Keep this event",
        metadata: { version: 1, etag: '"eliza-1"' },
      },
    );
  });
});
