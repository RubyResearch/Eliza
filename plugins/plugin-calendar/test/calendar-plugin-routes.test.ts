/**
 * Tests the calendar plugin HTTP route registration and service-resolution
 * behaviour against a mocked `CalendarService` (no live DB or connector).
 */
import type http from "node:http";
import type { IAgentRuntime, LegacyRouteHandler } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const MockCalendarService = vi.hoisted(() =>
  Object.assign(function CalendarService() {}, {
    serviceType: "calendar",
  }),
);
const MockCalendarMigrationService = vi.hoisted(() =>
  Object.assign(function CalendarMigrationService() {}, {
    serviceType: "calendar_migration",
  }),
);

vi.mock("../src/service/CalendarService.js", () => ({
  CalendarService: MockCalendarService,
}));

vi.mock("../src/service/migration.js", () => ({
  CALENDAR_MIGRATION_SERVICE_TYPE: "calendar_migration",
  CalendarMigrationService: MockCalendarMigrationService,
}));

import { calendarPlugin } from "../src/plugin.js";
import {
  calendarHttpRoutes,
  calendarRouteHandler,
} from "../src/routes/plugin-routes.js";

type MockResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | string[]>;
  headersSent: boolean;
};

function makeRequest(args: {
  method: string;
  url: string;
  body?: unknown;
}): http.IncomingMessage {
  return {
    method: args.method,
    url: args.url,
    headers: { host: "calendar.test" },
    body: args.body,
  } as unknown as http.IncomingMessage;
}

function makeResponse(): MockResponse {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    body: "",
    headers,
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      res.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          res.setHeader(name, value);
        }
      }
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

function makeCalendarService() {
  return {
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: [],
      source: "synced",
      timeMin: "2026-06-24T00:00:00.000Z",
      timeMax: "2026-06-25T00:00:00.000Z",
      syncedAt: "2026-06-24T00:00:00.000Z",
    })),
    listCalendars: vi.fn(async () => []),
    setCalendarIncluded: vi.fn(async () => ({ calendarId: "primary" })),
    getNextCalendarEventContext: vi.fn(async () => ({ event: null })),
    createCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    updateCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    deleteCalendarEvent: vi.fn(async () => undefined),
    respondToCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    listIcsCalendarSources: vi.fn(async () => []),
    createIcsCalendarSource: vi.fn(async () => ({ id: "source-1" })),
    updateIcsCalendarSource: vi.fn(async () => ({ id: "source-1" })),
    deleteIcsCalendarSource: vi.fn(async () => undefined),
    syncIcsCalendarSource: vi.fn(async () => ({
      source: { id: "source-1" },
      outcome: "complete",
    })),
    purgeImportedCalendarData: vi.fn(async () => ({
      provider: "google",
      providerMutation: false,
      deletedEventCount: 0,
      deletedSyncStateCount: 0,
    })),
    seedImportedCalendarData: vi.fn(async () => ({
      feedState: "complete",
      selectedSourceCount: 0,
      eventCount: 0,
      duplicateEventCount: 0,
    })),
    listLinkedCalendarEvents: vi.fn(async () => []),
    listLinkedCalendarEventViews: vi.fn(async () => [
      { id: "reviewed-link", event: { title: "Library pickup" } },
    ]),
    getLinkedCalendarEvent: vi.fn(async () => null),
  };
}

function makeRuntime(service: ReturnType<typeof makeCalendarService>) {
  return {
    agentId: "agent-1",
    getService: vi.fn(() => service),
    getServiceLoadPromise: vi.fn(async () => service),
  } as unknown as IAgentRuntime;
}

describe("calendar plugin HTTP routes", () => {
  it("registers only the provider-authenticated webhook directly", () => {
    expect(calendarPlugin.dependencies).toEqual(["@elizaos/plugin-scheduling"]);
    expect(calendarPlugin.routes).toEqual(calendarHttpRoutes);
    expect(calendarHttpRoutes).toHaveLength(1);
    expect(calendarHttpRoutes[0]).toMatchObject({
      type: "POST",
      public: true,
      rawPath: true,
      handler: expect.any(Function),
    });
  });

  it("serves linked-event names through the resolved owner route service", async () => {
    const service = makeCalendarService();
    const response = makeResponse();
    await calendarRouteHandler()(
      makeRequest({
        method: "GET",
        url: "/api/lifeops/calendar/links?view=events",
      }) as never,
      response as never,
      makeRuntime(service) as never,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      links: [{ id: "reviewed-link", event: { title: "Library pickup" } }],
    });
    expect(service.listLinkedCalendarEvents).not.toHaveBeenCalled();
  });

  it("keeps the host adapter available for the owner-gated LifeOps route", async () => {
    const service = makeCalendarService();
    const runtime = makeRuntime(service);
    const res = makeResponse();
    const handler: LegacyRouteHandler = calendarRouteHandler();

    await handler(
      makeRequest({
        method: "GET",
        url: "/api/lifeops/calendar/feed?side=owner&timeMin=2026-06-24T00%3A00%3A00.000Z&timeMax=2026-06-25T00%3A00%3A00.000Z",
      }) as never,
      res as never,
      runtime as never,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      calendarId: "all",
      events: [],
    });
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(service.getCalendarFeed.mock.calls[0]?.[1]).toMatchObject({
      side: "owner",
      timeMin: "2026-06-24T00:00:00.000Z",
      timeMax: "2026-06-25T00:00:00.000Z",
    });
  });
});
