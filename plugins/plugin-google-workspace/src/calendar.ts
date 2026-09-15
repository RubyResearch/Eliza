/**
 * Account-scoped Google Calendar reads, availability queries, and mutations
 * behind the workspace service. Page DTOs expose Google's continuation and
 * incremental-sync tokens, while array-returning methods remain convenience
 * adapters that exhaust every page. Availability responses deliberately omit
 * event content so callers can coordinate with guest calendars without
 * receiving private titles or descriptions.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError, isBlockedHostname, isPrivateIpAddress } from "@elizaos/core";
import type { calendar_v3 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleCalendarAttendee,
  GoogleCalendarAttendeeInput,
  GoogleCalendarAttendeeResponseStatus,
  GoogleCalendarBusyInterval,
  GoogleCalendarEvent,
  GoogleCalendarEventDeleteInput,
  GoogleCalendarEventInput,
  GoogleCalendarEventListPage,
  GoogleCalendarEventListPageInput,
  GoogleCalendarEventPatchInput,
  GoogleCalendarEventResponseInput,
  GoogleCalendarFreeBusyCalendar,
  GoogleCalendarFreeBusyInput,
  GoogleCalendarFreeBusyResult,
  GoogleCalendarListEntry,
  GoogleCalendarListPage,
  GoogleCalendarListPageInput,
  GoogleCalendarStopChannelInput,
  GoogleCalendarTransparency,
  GoogleCalendarVisibility,
  GoogleCalendarWatchInput,
  GoogleCalendarWatchResponse,
} from "./types.js";

const CALENDAR_LIST_PAGE_SIZE = 250;
const EVENT_LIST_PAGE_SIZE = 2_500;
const GOOGLE_CALENDAR_WATCH_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const IDEMPOTENCY_PRIVATE_PROPERTY = "elizaosIdempotencyKeySha256";

export type GoogleCalendarMutationOutcome = "not_accepted" | "precondition_failed";

/**
 * Definitive Google mutation rejection. Unknown transport outcomes deliberately
 * retain their original error so callers quarantine them instead of retrying.
 */
export class GoogleCalendarMutationError extends ElizaError {
  override readonly name = "GoogleCalendarMutationError";

  constructor(
    readonly outcome: GoogleCalendarMutationOutcome,
    code: string,
    message: string,
    context: Record<string, unknown>,
    cause: unknown
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: outcome === "not_accepted" ? "ephemeral" : "fatal",
    });
  }
}

export type GoogleCalendarSyncResource = "calendarList" | "events";

export class GoogleCalendarSyncTokenExpiredError extends ElizaError {
  override readonly name = "GoogleCalendarSyncTokenExpiredError";
  readonly resource: GoogleCalendarSyncResource;

  constructor(args: {
    resource: GoogleCalendarSyncResource;
    accountId: string;
    calendarId?: string;
    cause: unknown;
  }) {
    super("Google Calendar incremental sync token has expired; a full resync is required.", {
      code: "GOOGLE_CALENDAR_SYNC_TOKEN_EXPIRED",
      context: {
        resource: args.resource,
        accountId: args.accountId,
        ...(args.calendarId ? { calendarId: args.calendarId } : {}),
      },
      cause: args.cause,
      severity: "ephemeral",
    });
    this.resource = args.resource;
  }
}

export class GoogleCalendarClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]> {
    const calendars: GoogleCalendarListEntry[] = [];
    const pagination = createCalendarPaginationState();
    let pageToken: string | undefined;

    do {
      const page = await this.listCalendarPage({
        ...params,
        pageToken,
        minAccessRole: "reader",
        showDeleted: false,
        showHidden: false,
      });
      calendars.push(
        ...page.calendars.filter((entry) => entry.deleted !== true && entry.hidden !== true)
      );
      pageToken = nextPageToken(page.nextPageToken, pagination, "calendar list");
    } while (pageToken);

    return calendars;
  }

  async listCalendarPage(params: GoogleCalendarListPageInput): Promise<GoogleCalendarListPage> {
    validatePageSize(params.maxResults, CALENDAR_LIST_PAGE_SIZE, "calendar list");
    if (params.syncToken && params.minAccessRole) {
      throw invalidCalendarRequest(
        "Google Calendar list syncToken cannot be combined with minAccessRole.",
        { accountId: params.accountId }
      );
    }

    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.listCalendars"
    );
    try {
      const response = await calendar.calendarList.list({
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
        ...(params.syncToken ? { syncToken: params.syncToken } : {}),
        ...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
        ...(!params.syncToken && params.minAccessRole
          ? { minAccessRole: params.minAccessRole }
          : {}),
        ...(params.syncToken
          ? { showDeleted: true, showHidden: true }
          : params.showDeleted !== undefined
            ? { showDeleted: params.showDeleted }
            : {}),
        ...(!params.syncToken && params.showHidden !== undefined
          ? { showHidden: params.showHidden }
          : {}),
      });

      return {
        calendars: (response.data.items ?? [])
          .map(mapCalendarListEntry)
          .filter((entry): entry is GoogleCalendarListEntry => entry !== null),
        nextPageToken: normalizedToken(response.data.nextPageToken),
        nextSyncToken: normalizedToken(response.data.nextSyncToken),
      };
    } catch (error) {
      // error-policy:J2 Translate Google's opaque 410 into a typed resync signal and retain cause.
      if (params.syncToken && googleErrorStatus(error) === 410) {
        throw new GoogleCalendarSyncTokenExpiredError({
          resource: "calendarList",
          accountId: params.accountId,
          cause: error,
        });
      }
      throw error;
    }
  }

  async listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]> {
    validatePageSize(params.limit, EVENT_LIST_PAGE_SIZE, "event list");
    const events: GoogleCalendarEvent[] = [];
    const pagination = createCalendarPaginationState();
    let pageToken: string | undefined;

    do {
      const page = await this.listEventPage({
        accountId: params.accountId,
        calendarId: params.calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        timeZone: params.timeZone,
        pageToken,
        maxResults: params.limit,
        // This display-oriented adapter opts into chronological ordering; it
        // never carries a syncToken, so the nextSyncToken suppression that
        // orderBy causes cannot break incremental sync here.
        orderBy: "startTime",
      });
      events.push(...page.events);
      pageToken = nextPageToken(page.nextPageToken, pagination, "event list");
    } while (pageToken);

    return events;
  }

  async listEventPage(
    params: GoogleCalendarEventListPageInput
  ): Promise<GoogleCalendarEventListPage> {
    validatePageSize(params.maxResults, EVENT_LIST_PAGE_SIZE, "event list");
    if (params.syncToken && (params.timeMin || params.timeMax)) {
      throw invalidCalendarRequest(
        "Google Calendar event syncToken cannot be combined with timeMin or timeMax.",
        {
          accountId: params.accountId,
          calendarId: params.calendarId ?? "primary",
        }
      );
    }
    if (params.syncToken && params.orderBy) {
      throw invalidCalendarRequest(
        "Google Calendar event syncToken cannot be combined with orderBy.",
        {
          accountId: params.accountId,
          calendarId: params.calendarId ?? "primary",
        }
      );
    }

    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.listEvents"
    );
    const calendarId = params.calendarId ?? "primary";
    try {
      const response = await calendar.events.list({
        calendarId,
        ...(!params.syncToken && params.timeMin ? { timeMin: params.timeMin } : {}),
        ...(!params.syncToken && params.timeMax ? { timeMax: params.timeMax } : {}),
        ...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
        ...(params.syncToken ? { syncToken: params.syncToken } : {}),
        singleEvents: true,
        // orderBy is strictly opt-in: Google suppresses nextSyncToken on any
        // events.list request that carries it, which would silently disable
        // incremental sync for callers draining the full window.
        ...(params.orderBy ? { orderBy: params.orderBy } : {}),
        ...(params.syncToken
          ? { showDeleted: true }
          : params.showDeleted !== undefined
            ? { showDeleted: params.showDeleted }
            : {}),
        ...(params.timeZone ? { timeZone: params.timeZone } : {}),
      });

      return {
        events: (response.data.items ?? []).map((event) =>
          mapEvent(event, calendarId, params.timeZone)
        ),
        nextPageToken: normalizedToken(response.data.nextPageToken),
        nextSyncToken: normalizedToken(response.data.nextSyncToken),
      };
    } catch (error) {
      // error-policy:J2 Translate Google's opaque 410 into a typed resync signal and retain cause.
      if (params.syncToken && googleErrorStatus(error) === 410) {
        throw new GoogleCalendarSyncTokenExpiredError({
          resource: "events",
          accountId: params.accountId,
          calendarId,
          cause: error,
        });
      }
      throw error;
    }
  }

  async watchEvents(params: GoogleCalendarWatchInput): Promise<GoogleCalendarWatchResponse> {
    if (!params.channelId.trim() || params.channelId.length > 64) {
      throw invalidCalendarRequest(
        "Google Calendar watch channelId must contain 1 to 64 characters.",
        { accountId: params.accountId }
      );
    }
    if (!params.token.trim() || params.token.length > 256) {
      throw invalidCalendarRequest(
        "Google Calendar watch token must contain 1 to 256 characters.",
        { accountId: params.accountId, channelId: params.channelId }
      );
    }
    if (
      !Number.isInteger(params.ttlSeconds) ||
      params.ttlSeconds < 60 ||
      params.ttlSeconds > GOOGLE_CALENDAR_WATCH_MAX_TTL_SECONDS
    ) {
      throw invalidCalendarRequest(
        "Google Calendar watch ttlSeconds must be an integer from 60 through 604800.",
        { accountId: params.accountId, channelId: params.channelId }
      );
    }
    const address = validateWebhookAddress(params.address);
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.watchEvents"
    );
    const response = await calendar.events.watch({
      calendarId: params.calendarId ?? "primary",
      requestBody: {
        id: params.channelId,
        type: "web_hook",
        address,
        token: params.token,
        params: { ttl: String(params.ttlSeconds) },
      },
    });
    const channelId = response.data.id?.trim();
    const resourceId = response.data.resourceId?.trim();
    const resourceUri = response.data.resourceUri?.trim();
    const expirationMs = Number(response.data.expiration);
    if (
      !channelId ||
      !resourceId ||
      !resourceUri ||
      !Number.isFinite(expirationMs) ||
      expirationMs <= Date.now()
    ) {
      throw new ElizaError("Google Calendar returned an invalid watch channel response.", {
        code: "GOOGLE_CALENDAR_INVALID_WATCH_RESPONSE",
        context: {
          accountId: params.accountId,
          calendarId: params.calendarId ?? "primary",
          requestedChannelId: params.channelId,
        },
        severity: "fatal",
      });
    }
    return {
      channelId,
      resourceId,
      resourceUri,
      token: normalizedToken(response.data.token),
      expirationAt: new Date(expirationMs).toISOString(),
    };
  }

  async stopCalendarChannel(params: GoogleCalendarStopChannelInput): Promise<void> {
    if (!params.channelId.trim() || !params.resourceId.trim()) {
      throw invalidCalendarRequest(
        "Google Calendar channel stop requires channelId and resourceId.",
        { accountId: params.accountId }
      );
    }
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.stopChannel"
    );
    await calendar.channels.stop({
      requestBody: {
        id: params.channelId,
        resourceId: params.resourceId,
      },
    });
  }

  async queryFreeBusy(params: GoogleCalendarFreeBusyInput): Promise<GoogleCalendarFreeBusyResult> {
    if (params.calendarIds.length === 0) {
      throw invalidCalendarRequest("Google Calendar free/busy requires at least one calendar id.", {
        accountId: params.accountId,
      });
    }
    if (params.calendarIds.some((calendarId) => !calendarId.trim())) {
      throw invalidCalendarRequest("Google Calendar free/busy calendar ids cannot be empty.", {
        accountId: params.accountId,
      });
    }
    const timeMin = Date.parse(params.timeMin);
    const timeMax = Date.parse(params.timeMax);
    if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax) || timeMax <= timeMin) {
      throw invalidCalendarRequest(
        "Google Calendar free/busy requires a valid, increasing time window.",
        { accountId: params.accountId }
      );
    }
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.queryFreeBusy"
    );
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        timeZone: params.timeZone,
        groupExpansionMax: params.groupExpansionMax,
        calendarExpansionMax: params.calendarExpansionMax,
        items: params.calendarIds.map((id) => ({ id })),
      },
    });
    if (!response.data.calendars) {
      throw new ElizaError("Google Calendar returned no calendar availability payload.", {
        code: "GOOGLE_CALENDAR_INVALID_FREE_BUSY_RESPONSE",
        context: {
          accountId: params.accountId,
          requestedCalendarCount: params.calendarIds.length,
        },
        severity: "fatal",
      });
    }

    const calendars: Record<string, GoogleCalendarFreeBusyCalendar> = {};
    for (const calendarId of params.calendarIds) {
      const availability = response.data.calendars[calendarId];
      if (!availability) {
        throw new ElizaError("Google Calendar omitted a requested calendar from free/busy.", {
          code: "GOOGLE_CALENDAR_INVALID_FREE_BUSY_RESPONSE",
          context: { accountId: params.accountId, calendarId },
          severity: "fatal",
        });
      }
      calendars[calendarId] = {
        busy: (availability.busy ?? []).map((interval) =>
          mapBusyInterval(interval, params.accountId, calendarId)
        ),
        errors: (availability.errors ?? []).map((error) => ({
          domain: error.domain?.trim() || null,
          reason: error.reason?.trim() || null,
        })),
      };
    }

    return {
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      calendars,
    };
  }

  async getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.getEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const response = await calendar.events.get({
      calendarId,
      eventId: params.eventId,
    });
    return mapEvent(response.data, calendarId, params.timeZone);
  }

  /** Reads the original create receipt without retrying a provider mutation. */
  async findEventByIdempotencyKey(
    params: GoogleAccountRef & { calendarId: string; idempotencyKey: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent | null> {
    const idempotency = calendarCreateIdempotency(params.idempotencyKey);
    if (!idempotency) {
      throw new ElizaError("An idempotency key is required to inspect a calendar create.", {
        code: "GOOGLE_CALENDAR_INVALID_IDEMPOTENCY_KEY",
      });
    }
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.findEventByIdempotencyKey"
    );
    return recoverIdempotentCreate({
      calendar,
      calendarId: params.calendarId,
      idempotency,
      timeZone: params.timeZone,
    });
  }

  async createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.createEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const idempotency = calendarCreateIdempotency(params.idempotencyKey);
    try {
      const response = await calendar.events.insert({
        calendarId,
        conferenceDataVersion: params.createMeetLink ? 1 : undefined,
        sendUpdates: params.sendUpdates ?? "none",
        requestBody: {
          ...(idempotency ? { id: idempotency.eventId } : {}),
          summary: params.title,
          description: params.description,
          location: params.location,
          start: toEventDateTime(params.start, params.timeZone),
          end: toEventDateTime(params.end, params.timeZone),
          recurrence: params.recurrence,
          attendees: params.attendees?.map(toCalendarAttendee),
          ...(idempotency
            ? {
                extendedProperties: {
                  private: {
                    [IDEMPOTENCY_PRIVATE_PROPERTY]: idempotency.digest,
                  },
                },
              }
            : {}),
          conferenceData: params.createMeetLink
            ? {
                createRequest: {
                  requestId: randomUUID(),
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              }
            : undefined,
        },
      });

      return mapEvent(response.data, calendarId, params.timeZone);
    } catch (error) {
      if (
        idempotency &&
        (googleErrorStatus(error) === 409 || !isDefinitiveClientRejection(error))
      ) {
        const recovered = await recoverIdempotentCreate({
          calendar,
          calendarId,
          idempotency,
          timeZone: params.timeZone,
        });
        if (recovered) return recovered;
      }
      throwDefinitiveMutationError(error, {
        operation: "create",
        calendarId,
        eventId: idempotency?.eventId,
      });
    }
  }

  async updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.updateEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const needsExistingEventContext =
      Boolean(params.start || params.end) && (!params.timeZone || !params.start || !params.end);
    const existing = needsExistingEventContext
      ? (
          await calendar.events.get({
            calendarId,
            eventId: params.eventId,
          })
        ).data
      : null;
    const effectiveTimeZone =
      params.timeZone ?? existing?.start?.timeZone ?? existing?.end?.timeZone ?? undefined;
    const { start, end } = normalizePatchBounds({
      start: params.start,
      end: params.end,
      existing,
    });
    const requestBody: calendar_v3.Schema$Event = {};

    if (params.title !== undefined) {
      requestBody.summary = params.title;
    }
    if (params.description !== undefined) {
      requestBody.description = params.description;
    }
    if (params.location !== undefined) {
      requestBody.location = params.location;
    }
    if (start !== undefined) {
      // Google patches merge nested fields; clear the incompatible representation.
      requestBody.start = {
        ...toEventDateTime(start, effectiveTimeZone),
        ...(isDateOnly(start) ? { dateTime: null } : { date: null }),
      };
    }
    if (end !== undefined) {
      requestBody.end = {
        ...toEventDateTime(end, effectiveTimeZone),
        ...(isDateOnly(end) ? { dateTime: null } : { date: null }),
      };
    }
    if (params.attendees !== undefined) {
      requestBody.attendees = params.attendees.map(toCalendarAttendee);
    }
    if (params.recurrence !== undefined) {
      requestBody.recurrence = params.recurrence;
    }

    let updatedEvent: calendar_v3.Schema$Event;
    try {
      const patchParams = {
        calendarId,
        eventId: params.eventId,
        sendUpdates: params.sendUpdates ?? "none",
        requestBody,
      };
      const requestOptions = conditionalRequestOptions(params.expectedEtag);
      const response = requestOptions
        ? await calendar.events.patch(patchParams, requestOptions)
        : await calendar.events.patch(patchParams);
      updatedEvent = response.data;
    } catch (error) {
      throwDefinitiveMutationError(error, {
        operation: "update",
        calendarId,
        eventId: params.eventId,
      });
    }

    return mapEvent(updatedEvent, calendarId, effectiveTimeZone);
  }

  async deleteEvent(params: GoogleCalendarEventDeleteInput): Promise<void> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.deleteEvent"
    );
    try {
      const deleteParams = {
        calendarId: params.calendarId ?? "primary",
        eventId: params.eventId,
        sendUpdates: params.sendUpdates ?? "none",
      };
      const requestOptions = conditionalRequestOptions(params.expectedEtag);
      if (requestOptions) {
        await calendar.events.delete(deleteParams, requestOptions);
      } else {
        await calendar.events.delete(deleteParams);
      }
    } catch (error) {
      // error-policy:J1 DELETE is idempotent at this boundary; 410 proves the target is absent.
      if (googleErrorStatus(error) === 410) {
        return;
      }
      throwDefinitiveMutationError(error, {
        operation: "delete",
        calendarId: params.calendarId ?? "primary",
        eventId: params.eventId,
      });
    }
  }

  async respondToEvent(params: GoogleCalendarEventResponseInput): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.respondToEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const current = await calendar.events.get({
      calendarId,
      eventId: params.eventId,
    });
    const selfAttendee = current.data.attendees?.find((attendee) => attendee.self === true);
    const selfEmail = selfAttendee?.email?.trim();
    if (!selfAttendee || !selfEmail) {
      throw new GoogleCalendarMutationError(
        "not_accepted",
        "GOOGLE_CALENDAR_SELF_ATTENDEE_MISSING",
        "Google Calendar did not identify the connected account as an attendee.",
        { calendarId, eventId: params.eventId },
        undefined
      );
    }
    try {
      const patchParams = {
        calendarId,
        eventId: params.eventId,
        sendUpdates: params.sendUpdates ?? "none",
        requestBody: {
          attendeesOmitted: true,
          attendees: [
            {
              email: selfEmail,
              responseStatus: params.responseStatus,
            },
          ],
        },
      };
      const requestOptions = conditionalRequestOptions(params.expectedEtag);
      const response = requestOptions
        ? await calendar.events.patch(patchParams, requestOptions)
        : await calendar.events.patch(patchParams);
      return mapEvent(response.data, calendarId);
    } catch (error) {
      throwDefinitiveMutationError(error, {
        operation: "respond",
        calendarId,
        eventId: params.eventId,
      });
    }
  }
}

function mapCalendarListEntry(
  entry: calendar_v3.Schema$CalendarListEntry
): GoogleCalendarListEntry | null {
  const calendarId = entry.id?.trim();
  if (!calendarId) {
    return null;
  }
  return {
    calendarId,
    summary: entry.summaryOverride?.trim() || entry.summary?.trim() || calendarId,
    description: entry.description?.trim() || null,
    primary: Boolean(entry.primary),
    accessRole: entry.accessRole?.trim() || "reader",
    backgroundColor: entry.backgroundColor?.trim() || null,
    foregroundColor: entry.foregroundColor?.trim() || null,
    timeZone: entry.timeZone?.trim() || null,
    selected: entry.selected !== false,
    ...(entry.deleted ? { deleted: true } : {}),
    ...(entry.hidden ? { hidden: true } : {}),
  };
}

function mapEvent(
  event: calendar_v3.Schema$Event,
  calendarId: string,
  fallbackTimeZone?: string
): GoogleCalendarEvent {
  const eventId = event.id?.trim();
  if (!eventId) {
    throw new ElizaError("Google Calendar returned an event without an id.", {
      code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
      context: { calendarId },
      severity: "fatal",
    });
  }
  const start = readEventInstant(event.start, fallbackTimeZone);
  const end = readEventInstant(event.end, start?.timeZone ?? fallbackTimeZone);
  const originalStart = readEventInstant(
    event.originalStartTime,
    start?.timeZone ?? fallbackTimeZone
  );
  return {
    id: eventId,
    calendarId,
    title: event.summary ?? undefined,
    status: event.status ?? undefined,
    start: start?.iso ?? event.start?.dateTime ?? event.start?.date ?? undefined,
    end: end?.iso ?? event.end?.dateTime ?? event.end?.date ?? undefined,
    isAllDay: start?.isAllDay,
    timeZone: start?.timeZone ?? end?.timeZone ?? null,
    htmlLink: event.htmlLink ?? undefined,
    meetLink: readConferenceLink(event),
    attendees: event.attendees?.map(mapCalendarAttendee),
    location: event.location ?? undefined,
    description: event.description ?? undefined,
    organizer: event.organizer ? mapCalendarOrganizer(event.organizer, calendarId) : undefined,
    transparency: readTransparency(event.transparency),
    visibility: readVisibility(event.visibility),
    recurrence: event.recurrence ?? null,
    recurringEventId: event.recurringEventId ?? null,
    metadata: {
      etag: event.etag ?? null,
      sequence: event.sequence ?? null,
      iCalUID: event.iCalUID ?? null,
      recurringEventId: event.recurringEventId ?? null,
      originalStartTime: originalStart?.iso ?? null,
      originalStartIsAllDay: originalStart?.isAllDay ?? null,
      ...(event.recurrence ? { recurrence: event.recurrence } : {}),
      idempotencyKeySha256:
        event.extendedProperties?.private?.[IDEMPOTENCY_PRIVATE_PROPERTY] ?? null,
      createdAt: event.created ?? null,
      updatedAt: event.updated ?? null,
    },
  };
}

function mapCalendarOrganizer(
  organizer: NonNullable<calendar_v3.Schema$Event["organizer"]>,
  calendarId: string
): NonNullable<GoogleCalendarEvent["organizer"]> {
  const email = organizer.email?.trim();
  if (!email) {
    throw new ElizaError("Google Calendar returned an organizer without an email address.", {
      code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
      context: { calendarId },
      severity: "fatal",
    });
  }
  return {
    email,
    name: organizer.displayName?.trim() || undefined,
    self: Boolean(organizer.self),
  };
}

function mapCalendarAttendee(attendee: calendar_v3.Schema$EventAttendee): GoogleCalendarAttendee {
  const email = attendee.email?.trim();
  if (!email) {
    throw new ElizaError("Google Calendar returned an attendee without an email address.", {
      code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
      severity: "fatal",
    });
  }
  return {
    email,
    name: attendee.displayName?.trim() || undefined,
    responseStatus: readAttendeeResponseStatus(attendee.responseStatus),
    self: Boolean(attendee.self),
    organizer: Boolean(attendee.organizer),
    optional: Boolean(attendee.optional),
  };
}

function readAttendeeResponseStatus(
  value: string | null | undefined
): GoogleCalendarAttendeeResponseStatus | null {
  switch (value) {
    case "needsAction":
    case "declined":
    case "tentative":
    case "accepted":
      return value;
    case undefined:
    case null:
    case "":
      return null;
    default:
      throw new ElizaError("Google Calendar returned an unknown attendee response status.", {
        code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
        context: { responseStatus: value },
        severity: "fatal",
      });
  }
}

function readTransparency(value: string | null | undefined): GoogleCalendarTransparency {
  if (!value || value === "opaque") {
    return "opaque";
  }
  if (value === "transparent") {
    return value;
  }
  throw new ElizaError("Google Calendar returned an unknown event transparency.", {
    code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
    context: { transparency: value },
    severity: "fatal",
  });
}

function readVisibility(value: string | null | undefined): GoogleCalendarVisibility {
  if (!value || value === "default") {
    return "default";
  }
  switch (value) {
    case "public":
    case "private":
    case "confidential":
      return value;
    default:
      throw new ElizaError("Google Calendar returned an unknown event visibility.", {
        code: "GOOGLE_CALENDAR_INVALID_EVENT_RESPONSE",
        context: { visibility: value },
        severity: "fatal",
      });
  }
}

function mapBusyInterval(
  interval: calendar_v3.Schema$TimePeriod,
  accountId: string,
  calendarId: string
): GoogleCalendarBusyInterval {
  const startMs = interval.start ? Date.parse(interval.start) : Number.NaN;
  const endMs = interval.end ? Date.parse(interval.end) : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new ElizaError("Google Calendar returned an invalid free/busy interval.", {
      code: "GOOGLE_CALENDAR_INVALID_FREE_BUSY_RESPONSE",
      context: { accountId, calendarId },
      severity: "fatal",
    });
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

function validatePageSize(value: number | undefined, maximum: number, resource: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) {
    throw invalidCalendarRequest(
      `Google Calendar ${resource} maxResults must be an integer from 1 to ${maximum}.`,
      { maxResults: value }
    );
  }
}

function invalidCalendarRequest(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "GOOGLE_CALENDAR_INVALID_REQUEST",
    context,
    severity: "fatal",
  });
}

function validateWebhookAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    // error-policy:J2 Watch configuration gets a stable connector error while
    // retaining the URL parser's original failure as its cause.
    throw new ElizaError("Google Calendar watch address must be a valid HTTPS URL.", {
      code: "GOOGLE_CALENDAR_INVALID_WATCH_ADDRESS",
      context: {},
      cause: error,
      severity: "fatal",
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    isBlockedHostname(url.hostname) ||
    isPrivateIpAddress(url.hostname)
  ) {
    throw new ElizaError(
      "Google Calendar watch address must be a public HTTPS URL without credentials, query parameters, or a fragment.",
      {
        code: "GOOGLE_CALENDAR_INVALID_WATCH_ADDRESS",
        context: {},
        severity: "fatal",
      }
    );
  }
  return url.toString();
}

function normalizedToken(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

interface CalendarPaginationState {
  seenPageTokens: Set<string>;
}

function createCalendarPaginationState(): CalendarPaginationState {
  return { seenPageTokens: new Set<string>() };
}

function nextPageToken(
  value: string | null,
  state: CalendarPaginationState,
  resource: string
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (state.seenPageTokens.has(value)) {
    throw new ElizaError(`Google Calendar repeated a ${resource} page token.`, {
      code: "GOOGLE_CALENDAR_PAGINATION_LOOP",
      context: { resource },
      severity: "fatal",
    });
  }
  state.seenPageTokens.add(value);
  return value;
}

/**
 * Extract the joinable conference URL for an event. `hangoutLink` wins (it is
 * always the Meet video URL); otherwise prefer the `video` entry point over
 * phone/SIP/more entries so third-party conferences (Zoom, Teams, Webex)
 * surface their joinable URL rather than a dial-in number.
 */
export function readConferenceLink(event: calendar_v3.Schema$Event): string | undefined {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  const video = entryPoints.find((entry) => entry.entryPointType === "video");
  return video?.uri ?? entryPoints[0]?.uri ?? undefined;
}

function eventDateValue(value: calendar_v3.Schema$EventDateTime | undefined): string | undefined {
  return value?.dateTime ?? value?.date ?? undefined;
}

function readEventInstant(
  value: calendar_v3.Schema$EventDateTime | undefined,
  fallbackTimeZone?: string
): { iso: string; isAllDay: boolean; timeZone: string | null } | null {
  if (!value) {
    return null;
  }
  if (typeof value.dateTime === "string" && value.dateTime.trim().length > 0) {
    return {
      iso: new Date(value.dateTime).toISOString(),
      isAllDay: false,
      timeZone: value.timeZone?.trim() || null,
    };
  }
  if (typeof value.date === "string" && value.date.trim().length > 0) {
    const iso = new Date(`${value.date}T00:00:00.000Z`).toISOString();
    return {
      iso,
      isAllDay: true,
      timeZone: value.timeZone?.trim() || fallbackTimeZone?.trim() || null,
    };
  }
  return null;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizePatchBounds(params: {
  start?: string;
  end?: string;
  existing: calendar_v3.Schema$Event | null;
}): { start?: string; end?: string } {
  let start = params.start;
  let end = params.end;
  if (!params.existing || Boolean(start) === Boolean(end)) {
    return { start, end };
  }

  const existingStart = eventDateValue(params.existing.start);
  const existingEnd = eventDateValue(params.existing.end);
  const existingDurationMs =
    existingStart && existingEnd ? Date.parse(existingEnd) - Date.parse(existingStart) : Number.NaN;

  // The single supplied bound decides how toEventDateTime will serialize it: a
  // date-only "YYYY-MM-DD" value emits {date}, anything else emits {dateTime}.
  // The derived counterpart must match that shape, otherwise the patch body
  // mixes an all-day date with a timed dateTime and Google Calendar's
  // events.patch rejects it with HTTP 400 ("Cannot combine date and dateTime").
  const anchor = start ?? end;
  if (isDateOnly(anchor)) {
    // All-day reschedule: preserve the existing span as whole calendar days and
    // derive the missing bound as a date-only string so both bounds stay {date}.
    const spanDays =
      Number.isFinite(existingDurationMs) && existingDurationMs > 0
        ? Math.max(1, Math.round(existingDurationMs / MILLISECONDS_PER_DAY))
        : 1;
    if (start && !end) {
      end = addCalendarDays(start, spanDays);
    } else if (end && !start) {
      start = addCalendarDays(end, -spanDays);
    }
    return { start, end };
  }

  const fallbackDurationMs =
    Number.isFinite(existingDurationMs) && existingDurationMs > 0
      ? existingDurationMs
      : 60 * 60 * 1000;

  if (start && !end) {
    end = new Date(new Date(start).getTime() + fallbackDurationMs).toISOString();
  } else if (end && !start) {
    start = new Date(new Date(end).getTime() - fallbackDurationMs).toISOString();
  }

  return { start, end };
}

function isDateOnly(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addCalendarDays(dateOnly: string, days: number): string {
  const base = new Date(`${dateOnly}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function toEventDateTime(
  value: string,
  timeZone: string | undefined
): calendar_v3.Schema$EventDateTime {
  if (isDateOnly(value)) {
    return { date: value, timeZone };
  }
  return { dateTime: value, timeZone };
}

function toCalendarAttendee(
  address: GoogleCalendarAttendeeInput
): calendar_v3.Schema$EventAttendee {
  return {
    email: address.email,
    displayName: address.name,
    responseStatus: address.responseStatus,
    optional: address.optional,
  };
}

function googleErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const response = isRecord(error.response) ? error.response : undefined;
  return numericValue(response?.status) ?? numericValue(error.status) ?? numericValue(error.code);
}

function calendarCreateIdempotency(
  value: string | undefined
): { digest: string; eventId: string } | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) {
    throw new ElizaError("Google Calendar idempotencyKey cannot be empty.", {
      code: "GOOGLE_CALENDAR_INVALID_IDEMPOTENCY_KEY",
      severity: "fatal",
    });
  }
  const digest = createHash("sha256").update(normalized).digest("hex");
  return { digest, eventId: `e1${digest}` };
}

function conditionalRequestOptions(
  expectedEtag: string | undefined
): { headers: { "If-Match": string } } | undefined {
  if (expectedEtag === undefined) return undefined;
  const normalized = expectedEtag.trim();
  if (!normalized) {
    throw new ElizaError("Google Calendar expectedEtag cannot be empty.", {
      code: "GOOGLE_CALENDAR_INVALID_ETAG",
      severity: "fatal",
    });
  }
  return { headers: { "If-Match": normalized } };
}

// Google reports per-user/per-project quota exhaustion as HTTP 403 with a
// usageLimits reason code. Those are documented retry-with-backoff conditions,
// so they must surface as transient transport failures, not as a definitive
// "the mutation was rejected" outcome.
const TRANSIENT_403_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

function googleErrorReasons(error: unknown): string[] {
  if (!isRecord(error)) return [];
  const reasons: string[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (isRecord(entry) && typeof entry.reason === "string" && entry.reason.trim()) {
        reasons.push(entry.reason.trim());
      }
    }
  };
  // googleapis surfaces reason codes both on the error itself and inside the
  // response body, depending on gaxios version; read both locations.
  collect(error.errors);
  const response = isRecord(error.response) ? error.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const dataError = data && isRecord(data.error) ? data.error : undefined;
  collect(dataError?.errors);
  return reasons;
}

function isDefinitiveClientRejection(error: unknown): boolean {
  const status = googleErrorStatus(error);
  if (status === undefined || status < 400 || status >= 500) return false;
  if (status === 408 || status === 429) return false;
  if (
    status === 403 &&
    googleErrorReasons(error).some((reason) => TRANSIENT_403_REASONS.has(reason))
  ) {
    return false;
  }
  return true;
}

async function recoverIdempotentCreate(args: {
  calendar: calendar_v3.Calendar;
  calendarId: string;
  idempotency: { digest: string; eventId: string };
  timeZone: string | undefined;
}): Promise<GoogleCalendarEvent | null> {
  try {
    const existing = await args.calendar.events.get({
      calendarId: args.calendarId,
      eventId: args.idempotency.eventId,
    });
    const marker = existing.data.extendedProperties?.private?.[IDEMPOTENCY_PRIVATE_PROPERTY];
    if (marker !== args.idempotency.digest) {
      throw new GoogleCalendarMutationError(
        "not_accepted",
        "GOOGLE_CALENDAR_IDEMPOTENCY_CONFLICT",
        "The deterministic Google Calendar event id belongs to a different request.",
        {
          calendarId: args.calendarId,
          eventId: args.idempotency.eventId,
        },
        undefined
      );
    }
    return mapEvent(existing.data, args.calendarId, args.timeZone);
  } catch (error) {
    if (error instanceof GoogleCalendarMutationError) throw error;
    // error-policy:J3 A 404 is an explicit "no recoverable receipt" signal;
    // every other provider failure remains observable to the mutation caller.
    if (googleErrorStatus(error) === 404) return null;
    throw error;
  }
}

function throwDefinitiveMutationError(
  error: unknown,
  context: {
    operation: "create" | "update" | "delete" | "respond";
    calendarId: string;
    eventId?: string;
  }
): never {
  if (error instanceof GoogleCalendarMutationError) throw error;
  const status = googleErrorStatus(error);
  if (status === 412) {
    throw new GoogleCalendarMutationError(
      "precondition_failed",
      "GOOGLE_CALENDAR_PRECONDITION_FAILED",
      "Google Calendar rejected the mutation because the event changed.",
      { ...context, status },
      error
    );
  }
  if (isDefinitiveClientRejection(error)) {
    throw new GoogleCalendarMutationError(
      "not_accepted",
      "GOOGLE_CALENDAR_MUTATION_NOT_ACCEPTED",
      "Google Calendar rejected the mutation before acceptance.",
      { ...context, status },
      error
    );
  }
  throw error;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
