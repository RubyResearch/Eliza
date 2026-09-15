/**
 * Google Calendar mutation safety through the real googleapis HTTP client
 * against a stateful loopback provider: replay recovery, ETags, notifications,
 * recurring creates, RSVP, and delete semantics.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Auth, type calendar_v3 } from "googleapis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoogleCalendarClient, type GoogleCalendarMutationError } from "./calendar.js";
import { GoogleApiClientFactory } from "./client-factory.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

interface ProviderEvent {
  id: string;
  etag: string;
  summary: string;
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  attendees: Array<{
    email: string;
    self?: boolean;
    organizer?: boolean;
    responseStatus?: string;
  }>;
  recurrence?: string[];
  extendedProperties?: {
    private?: Record<string, string>;
  };
  updated: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(): Promise<GoogleAuthClient> {
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "loopback-google-token",
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    return auth;
  }
}

let server: Server;
let baseUrl: string;
let originalBase: string | undefined;
let disconnectAfterCreate = false;
let events = new Map<string, ProviderEvent>();
let requests: RecordedRequest[] = [];
let client: GoogleCalendarClient;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("loopback request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function eventPath(pathname: string): { eventId: string | null } | null {
  const match = pathname.match(/^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
  return match ? { eventId: match[1] ? decodeURIComponent(match[1]) : null } : null;
}

function nextEtag(event: ProviderEvent): string {
  const current = Number(event.etag.replace(/\D/g, "")) || 1;
  return `"v${current + 1}"`;
}

beforeAll(async () => {
  originalBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://loopback.invalid");
      const matched = eventPath(url.pathname);
      if (!matched) {
        writeJson(response, 404, { error: { code: 404 } });
        return;
      }
      const body = await readJsonBody(request);
      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        headers: request.headers,
        query: url.searchParams,
        body,
      });
      if (request.method === "POST" && matched.eventId === null) {
        const id = String(body.id);
        if (events.has(id)) {
          writeJson(response, 409, { error: { code: 409 } });
          return;
        }
        const created: ProviderEvent = {
          id,
          etag: '"v1"',
          summary: String(body.summary),
          start: body.start as ProviderEvent["start"],
          end: body.end as ProviderEvent["end"],
          attendees: (body.attendees ?? []) as ProviderEvent["attendees"],
          recurrence: body.recurrence as string[] | undefined,
          extendedProperties: body.extendedProperties as ProviderEvent["extendedProperties"],
          updated: "2026-07-26T12:00:00.000Z",
        };
        events.set(id, created);
        if (disconnectAfterCreate) {
          disconnectAfterCreate = false;
          response.socket?.destroy();
          return;
        }
        writeJson(response, 200, created);
        return;
      }
      const eventId = matched.eventId;
      const event = eventId ? events.get(eventId) : undefined;
      if (!event) {
        writeJson(response, 404, { error: { code: 404 } });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, event);
        return;
      }
      const expectedEtag = request.headers["if-match"];
      if (expectedEtag !== undefined && expectedEtag !== event.etag) {
        writeJson(response, 412, { error: { code: 412 } });
        return;
      }
      if (request.method === "PATCH") {
        const start = { ...event.start, ...(body.start as ProviderEvent["start"] | undefined) };
        const end = { ...event.end, ...(body.end as ProviderEvent["end"] | undefined) };
        if ((start.date && start.dateTime) || (end.date && end.dateTime)) {
          writeJson(response, 400, {
            error: { code: 400, message: "Cannot combine date and dateTime" },
          });
          return;
        }
        const updated: ProviderEvent = {
          ...event,
          start,
          end,
          ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
          ...(Array.isArray(body.recurrence) ? { recurrence: body.recurrence as string[] } : {}),
          ...(Array.isArray(body.attendees)
            ? { attendees: body.attendees as ProviderEvent["attendees"] }
            : {}),
          etag: nextEtag(event),
          updated: "2026-07-26T12:01:00.000Z",
        };
        events.set(event.id, updated);
        writeJson(response, 200, updated);
        return;
      }
      if (request.method === "DELETE") {
        events.delete(event.id);
        response.writeHead(204);
        response.end();
        return;
      }
      writeJson(response, 405, { error: { code: 405 } });
    })().catch((error) => {
      writeJson(response, 500, {
        error: {
          code: 500,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/`;
  process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;
  client = new GoogleCalendarClient(new GoogleApiClientFactory(new LoopbackCredentialResolver()));
});

afterAll(async () => {
  if (originalBase === undefined) {
    delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  } else {
    process.env.ELIZA_MOCK_GOOGLE_BASE = originalBase;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  disconnectAfterCreate = false;
  events = new Map();
  requests = [];
});

describe("Google Calendar provider mutation safety", () => {
  it("recovers an accepted create and suppresses replay with one provider event", async () => {
    disconnectAfterCreate = true;
    const request = {
      accountId: "owner-account",
      calendarId: "primary",
      title: "School pickup",
      start: "2026-08-01T16:00:00.000Z",
      end: "2026-08-01T17:00:00.000Z",
      timeZone: "UTC",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
      attendees: [{ email: "coparent@example.test" }],
      sendUpdates: "all" as const,
      idempotencyKey: "approved-operation-sha256",
    };

    const recovered = await client.createEvent(request);
    const replayed = await client.createEvent(request);

    expect(recovered.id).toBe(replayed.id);
    expect(recovered.id).toMatch(/^e1[0-9a-f]{64}$/);
    expect(recovered.metadata?.etag).toBe('"v1"');
    expect(recovered.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=FR"]);
    expect(events.size).toBe(1);
    const creates = requests.filter((entry) => entry.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.query.get("sendUpdates")).toBe("all");
    expect(creates[0]?.body).toMatchObject({
      id: recovered.id,
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
      extendedProperties: {
        private: {
          elizaosIdempotencyKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
  });

  it("inspects an original create receipt without writing and rejects a foreign marker", async () => {
    const params = {
      accountId: "owner-account",
      calendarId: "disposable-recovery-calendar",
      idempotencyKey: "recovery-original-create",
    };
    expect(await client.findEventByIdempotencyKey(params)).toBeNull();
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const created = await client.createEvent({
      ...params,
      title: "Synthetic recovery event",
      start: "2026-08-01T16:00:00.000Z",
      end: "2026-08-01T17:00:00.000Z",
      timeZone: "UTC",
      sendUpdates: "none",
    });
    requests = [];
    const found = await client.findEventByIdempotencyKey(params);
    expect(found?.id).toBe(created.id);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const stored = events.get(created.id);
    if (!stored) throw new Error("Expected the provider's persisted create");
    stored.extendedProperties = { private: { elizaosIdempotencyKeySha256: "foreign" } };
    await expect(client.findEventByIdempotencyKey(params)).rejects.toMatchObject({
      code: "GOOGLE_CALENDAR_IDEMPOTENCY_CONFLICT",
    });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("converts timed events to all-day and back over real HTTP without changing identity", async () => {
    const created = await client.createEvent({
      accountId: "owner-account",
      title: "School recess",
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "school-conversion",
    });
    const createdEtag = created.metadata?.etag;
    if (typeof createdEtag !== "string") throw new Error("Missing created event ETag");
    const allDay = await client.updateEvent({
      accountId: "owner-account",
      eventId: created.id,
      start: "2026-11-01",
      end: "2026-11-03",
      timeZone: "America/New_York",
      expectedEtag: createdEtag,
      sendUpdates: "none",
    });
    expect(allDay.isAllDay).toBe(true);
    expect(allDay.end).toBe("2026-11-03T00:00:00.000Z");
    const allDayEtag = allDay.metadata?.etag;
    if (typeof allDayEtag !== "string") throw new Error("Missing all-day event ETag");
    const timed = await client.updateEvent({
      accountId: "owner-account",
      eventId: created.id,
      start: "2026-11-01T14:00:00.000Z",
      end: "2026-11-01T15:00:00.000Z",
      timeZone: "America/New_York",
      expectedEtag: allDayEtag,
      sendUpdates: "none",
    });
    expect(timed.id).toBe(created.id);
    expect(timed.isAllDay).toBe(false);
    expect(timed.start).toBe("2026-11-01T14:00:00.000Z");
    expect(events.size).toBe(1);
    expect(
      requests
        .filter((request) => request.method === "PATCH")
        .every((request) => request.query.get("sendUpdates") === "none")
    ).toBe(true);
  });

  it("enforces If-Match and explicit notification policy for update, RSVP, and delete", async () => {
    const created = await client.createEvent({
      accountId: "owner-account",
      title: "Family dinner",
      start: "2026-08-02T01:00:00.000Z",
      end: "2026-08-02T02:00:00.000Z",
      timeZone: "UTC",
      attendees: [
        {
          email: "owner@example.test",
          responseStatus: "accepted",
        },
      ],
      idempotencyKey: "family-dinner",
    });
    const providerEvent = events.get(created.id);
    if (!providerEvent) throw new Error("created provider event missing");
    providerEvent.attendees = [
      {
        email: "owner@example.test",
        self: true,
        responseStatus: "accepted",
      },
      {
        email: "host@example.test",
        organizer: true,
        responseStatus: "accepted",
      },
    ];

    await expect(
      client.updateEvent({
        accountId: "owner-account",
        eventId: created.id,
        title: "Changed without consent",
        expectedEtag: '"stale"',
      })
    ).rejects.toMatchObject<Partial<GoogleCalendarMutationError>>({
      outcome: "precondition_failed",
      code: "GOOGLE_CALENDAR_PRECONDITION_FAILED",
    });
    expect(events.get(created.id)?.summary).toBe("Family dinner");

    const updated = await client.updateEvent({
      accountId: "owner-account",
      eventId: created.id,
      title: "Family dinner downtown",
      expectedEtag: '"v1"',
      sendUpdates: "all",
    });
    expect(updated.metadata?.etag).toBe('"v2"');
    const updateRequest = requests.find(
      (entry) => entry.method === "PATCH" && entry.body.summary === "Family dinner downtown"
    );
    expect(updateRequest?.headers["if-match"]).toBe('"v1"');
    expect(updateRequest?.query.get("sendUpdates")).toBe("all");

    const declined = await client.respondToEvent({
      accountId: "owner-account",
      eventId: created.id,
      responseStatus: "declined",
      expectedEtag: '"v2"',
      sendUpdates: "none",
    });
    expect(declined.metadata?.etag).toBe('"v3"');
    const responseRequest = requests.find(
      (entry) => entry.method === "PATCH" && entry.body.attendeesOmitted === true
    );
    expect(responseRequest?.headers["if-match"]).toBe('"v2"');
    expect(responseRequest?.query.get("sendUpdates")).toBe("none");
    expect(responseRequest?.body.attendees).toEqual([
      {
        email: "owner@example.test",
        responseStatus: "declined",
      },
    ]);

    await expect(
      client.deleteEvent({
        accountId: "owner-account",
        eventId: created.id,
        expectedEtag: '"v2"',
      })
    ).rejects.toMatchObject<Partial<GoogleCalendarMutationError>>({
      outcome: "precondition_failed",
    });
    expect(events.has(created.id)).toBe(true);

    await client.deleteEvent({
      accountId: "owner-account",
      eventId: created.id,
      expectedEtag: '"v3"',
      sendUpdates: "all",
    });
    expect(events.has(created.id)).toBe(false);
    const deleteRequest = requests.at(-1);
    expect(deleteRequest?.method).toBe("DELETE");
    expect(deleteRequest?.headers["if-match"]).toBe('"v3"');
    expect(deleteRequest?.query.get("sendUpdates")).toBe("all");
  });
});
