/**
 * Calendar client methods — side-effect augmentation of the `@elizaos/ui`
 * `ElizaClient` prototype. Importing this module attaches the calendar feed /
 * event CRUD methods onto every `client` instance, so any surface that depends
 * on `@elizaos/ui` (the LifeOps dashboard, the task-coordinator
 * CalendarView, …) can call them after a single side-effect import.
 *
 * The HTTP routes are still mounted under `/api/lifeops/calendar/*`; the paths
 * are stable contract surface and intentionally unchanged by the extraction.
 */

import type {
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  CreateLifeOpsIcsCalendarSourceRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEventCancellationResult,
  LifeOpsCalendarEventMutationResult,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarFeed,
  LifeOpsCalendarImportedDataPurgeReceipt,
  LifeOpsCalendarSeedReceipt,
  LifeOpsCalendarSummary,
  LifeOpsIcsCalendarSourceMutationResponse,
  LifeOpsIcsCalendarSyncResponse,
  LifeOpsLinkedCalendarControl,
  LifeOpsLinkedCalendarControlMutationResult,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
  ListLifeOpsIcsCalendarSourcesResponse,
  PurgeLifeOpsCalendarImportedDataRequest,
  RebindLifeOpsLinkedCalendarRequest,
  RebindLifeOpsLinkedCalendarResponse,
  SeedLifeOpsCalendarRequest,
  SetLifeOpsCalendarIncludedRequest,
  SetLifeOpsCalendarIncludedResponse,
  UpdateLifeOpsIcsCalendarSourceRequest,
  UpdateLifeOpsLinkedCalendarControlRequest,
} from "@elizaos/shared";
import { ElizaClient } from "@elizaos/ui/api";
import type {
  MeetingAutoJoinPolicy,
  MeetingAutoJoinSettings,
} from "../meetings/auto-join-settings.js";

type CalendarEditorCreateRequest = CreateLifeOpsCalendarEventRequest & {
  idempotencyKey: string;
};

type CalendarEditorUpdateRequest = LifeOpsCalendarEventUpdate & {
  expectedProviderVersion: string;
  idempotencyKey: string;
};

type CalendarEditorDeleteRequest = Partial<
  Pick<
    LifeOpsCalendarEventUpdate,
    "calendarId" | "grantId" | "side" | "recurrenceScope" | "notifyAttendees"
  >
> & {
  expectedProviderVersion: string;
  idempotencyKey: string;
  cancellationMode:
    | "organizer_cancel"
    | "decline_invitation"
    | "remove_private_copy";
};

export interface CalendarClientMethods {
  rebindLinkedCalendar(
    linkId: string,
    request: RebindLifeOpsLinkedCalendarRequest,
  ): Promise<RebindLifeOpsLinkedCalendarResponse>;
  getLinkedCalendarControl(): Promise<LifeOpsLinkedCalendarControl>;
  updateLinkedCalendarControl(
    request: UpdateLifeOpsLinkedCalendarControlRequest,
  ): Promise<LifeOpsLinkedCalendarControlMutationResult>;
  getLifeOpsCalendarFeed(
    options?: GetLifeOpsCalendarFeedRequest,
    request?: Pick<RequestInit, "signal">,
  ): Promise<LifeOpsCalendarFeed>;
  getLifeOpsCalendars(
    options?: ListLifeOpsCalendarsRequest,
    request?: Pick<RequestInit, "signal">,
  ): Promise<{ calendars: LifeOpsCalendarSummary[] }>;
  setLifeOpsCalendarIncluded(
    data: SetLifeOpsCalendarIncludedRequest,
  ): Promise<SetLifeOpsCalendarIncludedResponse>;
  getLifeOpsNextCalendarEventContext(
    options?: GetLifeOpsCalendarFeedRequest,
  ): Promise<LifeOpsNextCalendarEventContext>;
  createLifeOpsCalendarEvent(
    data: CalendarEditorCreateRequest,
  ): Promise<CreateLifeOpsCalendarEventResponse>;
  updateLifeOpsCalendarEvent(
    eventId: string,
    patch: CalendarEditorUpdateRequest,
  ): Promise<LifeOpsCalendarEventMutationResult>;
  deleteLifeOpsCalendarEvent(
    eventId: string,
    options: CalendarEditorDeleteRequest,
  ): Promise<LifeOpsCalendarEventCancellationResult>;
  getMeetingAutoJoinSettings(): Promise<MeetingAutoJoinSettings>;
  setMeetingAutoJoinPolicy(
    policy: MeetingAutoJoinPolicy,
  ): Promise<MeetingAutoJoinSettings>;
  getLifeOpsIcsCalendarSources(): Promise<ListLifeOpsIcsCalendarSourcesResponse>;
  createLifeOpsIcsCalendarSource(
    data: CreateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSourceMutationResponse>;
  updateLifeOpsIcsCalendarSource(
    sourceId: string,
    data: UpdateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSourceMutationResponse>;
  deleteLifeOpsIcsCalendarSource(sourceId: string): Promise<{ deleted: true }>;
  syncLifeOpsIcsCalendarSource(
    sourceId: string,
  ): Promise<LifeOpsIcsCalendarSyncResponse>;
  purgeLifeOpsCalendarImportedData(
    data: PurgeLifeOpsCalendarImportedDataRequest,
  ): Promise<LifeOpsCalendarImportedDataPurgeReceipt>;
  seedLifeOpsCalendar(
    data: SeedLifeOpsCalendarRequest,
  ): Promise<LifeOpsCalendarSeedReceipt>;
}

// The `/api/meetings` client (requestMeetingBot / listMeetings / getMeeting /
// stopMeeting) is canonical in `@elizaos/ui` (packages/ui/src/api/client-meetings.ts)
// and already installed on this same prototype via the `@elizaos/ui/api`
// side-effect import. Do NOT re-declare meeting join/list methods here — call
// the ui client's `requestMeetingBot` / `listMeetings` directly.

declare module "@elizaos/ui/api/client-base" {
  interface ElizaClient extends CalendarClientMethods {}
}

const calendarClientPrototype = ElizaClient.prototype as ElizaClient &
  CalendarClientMethods;

calendarClientPrototype.rebindLinkedCalendar = async function (
  this: ElizaClient,
  linkId: string,
  request: RebindLifeOpsLinkedCalendarRequest,
) {
  return this.fetch<RebindLifeOpsLinkedCalendarResponse>(
    `/api/lifeops/calendar/links/${encodeURIComponent(linkId)}/rebind`,
    { method: "POST", body: JSON.stringify(request) },
  );
};

calendarClientPrototype.getLinkedCalendarControl = async function (
  this: ElizaClient,
) {
  return this.fetch<LifeOpsLinkedCalendarControl>(
    "/api/lifeops/calendar/sync-control",
  );
};

calendarClientPrototype.updateLinkedCalendarControl = async function (
  this: ElizaClient,
  request: UpdateLifeOpsLinkedCalendarControlRequest,
) {
  return this.fetch<LifeOpsLinkedCalendarControlMutationResult>(
    "/api/lifeops/calendar/sync-control",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
};

calendarClientPrototype.getLifeOpsCalendarFeed = async function (
  this: ElizaClient,
  options: GetLifeOpsCalendarFeedRequest = {},
  request?: Pick<RequestInit, "signal">,
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.grantId) params.set("grantId", options.grantId);
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.includeHiddenCalendars !== undefined) {
    params.set(
      "includeHiddenCalendars",
      String(options.includeHiddenCalendars),
    );
  }
  if (options.timeMin) params.set("timeMin", options.timeMin);
  if (options.timeMax) params.set("timeMax", options.timeMax);
  if (options.timeZone) params.set("timeZone", options.timeZone);
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  const query = params.toString();
  return this.fetch<LifeOpsCalendarFeed>(
    `/api/lifeops/calendar/feed${query ? `?${query}` : ""}`,
    request?.signal ? { signal: request.signal } : undefined,
  );
};

calendarClientPrototype.seedLifeOpsCalendar = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsCalendarSeedReceipt>("/api/lifeops/calendar/seed", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

calendarClientPrototype.purgeLifeOpsCalendarImportedData = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsCalendarImportedDataPurgeReceipt>(
    "/api/lifeops/calendar/imported-data/purge",
    { method: "POST", body: JSON.stringify(data) },
  );
};

calendarClientPrototype.getLifeOpsCalendars = async function (
  this: ElizaClient,
  options: ListLifeOpsCalendarsRequest = {},
  request?: Pick<RequestInit, "signal">,
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.grantId) params.set("grantId", options.grantId);
  const query = params.toString();
  return this.fetch<{ calendars: LifeOpsCalendarSummary[] }>(
    `/api/lifeops/calendar/calendars${query ? `?${query}` : ""}`,
    request?.signal ? { signal: request.signal } : undefined,
  );
};

calendarClientPrototype.setLifeOpsCalendarIncluded = async function (
  this: ElizaClient,
  data: SetLifeOpsCalendarIncludedRequest,
) {
  return this.fetch<SetLifeOpsCalendarIncludedResponse>(
    `/api/lifeops/calendar/calendars/${encodeURIComponent(data.calendarId)}/include`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.getLifeOpsIcsCalendarSources = async function (
  this: ElizaClient,
) {
  return this.fetch<ListLifeOpsIcsCalendarSourcesResponse>(
    "/api/lifeops/calendar/sources",
  );
};

calendarClientPrototype.createLifeOpsIcsCalendarSource = async function (
  this: ElizaClient,
  data: CreateLifeOpsIcsCalendarSourceRequest,
) {
  return this.fetch<LifeOpsIcsCalendarSourceMutationResponse>(
    "/api/lifeops/calendar/sources",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.updateLifeOpsIcsCalendarSource = async function (
  this: ElizaClient,
  sourceId: string,
  data: UpdateLifeOpsIcsCalendarSourceRequest,
) {
  return this.fetch<LifeOpsIcsCalendarSourceMutationResponse>(
    `/api/lifeops/calendar/sources/${encodeURIComponent(sourceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.deleteLifeOpsIcsCalendarSource = async function (
  this: ElizaClient,
  sourceId: string,
) {
  return this.fetch<{ deleted: true }>(
    `/api/lifeops/calendar/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
};

calendarClientPrototype.syncLifeOpsIcsCalendarSource = async function (
  this: ElizaClient,
  sourceId: string,
) {
  return this.fetch<LifeOpsIcsCalendarSyncResponse>(
    `/api/lifeops/calendar/sources/${encodeURIComponent(sourceId)}/sync`,
    { method: "POST" },
  );
};

calendarClientPrototype.getLifeOpsNextCalendarEventContext = async function (
  this: ElizaClient,
  options: GetLifeOpsCalendarFeedRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.timeMin) params.set("timeMin", options.timeMin);
  if (options.timeMax) params.set("timeMax", options.timeMax);
  if (options.timeZone) params.set("timeZone", options.timeZone);
  const query = params.toString();
  return this.fetch<LifeOpsNextCalendarEventContext>(
    `/api/lifeops/calendar/next-context${query ? `?${query}` : ""}`,
  );
};

calendarClientPrototype.createLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  data: CalendarEditorCreateRequest,
) {
  if (!data.idempotencyKey?.trim()) {
    throw new Error(
      "Calendar event creation requires a stable idempotencyKey.",
    );
  }
  return this.fetch<CreateLifeOpsCalendarEventResponse>(
    "/api/lifeops/calendar/events",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.updateLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId: string,
  patch: CalendarEditorUpdateRequest,
) {
  if (!patch.expectedProviderVersion?.trim()) {
    throw new Error("Calendar event update requires expectedProviderVersion.");
  }
  if (!patch.idempotencyKey?.trim()) {
    throw new Error("Calendar event update requires a stable idempotencyKey.");
  }
  return this.fetch<LifeOpsCalendarEventMutationResult>(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
};

calendarClientPrototype.deleteLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId: string,
  options: CalendarEditorDeleteRequest,
) {
  const params = new URLSearchParams();
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.grantId) params.set("grantId", options.grantId);
  if (options.side) params.set("side", options.side);
  if (options.recurrenceScope) {
    params.set("recurrenceScope", options.recurrenceScope);
  }
  if (options.notifyAttendees !== undefined) {
    params.set("notifyAttendees", String(options.notifyAttendees));
  }
  if (!options.expectedProviderVersion?.trim()) {
    throw new Error(
      "Calendar event deletion requires expectedProviderVersion.",
    );
  }
  params.set("expectedProviderVersion", options.expectedProviderVersion);
  if (!options.idempotencyKey?.trim()) {
    throw new Error(
      "Calendar event deletion requires a stable idempotencyKey.",
    );
  }
  params.set("idempotencyKey", options.idempotencyKey);
  if (!options.cancellationMode) {
    throw new Error(
      "Calendar event deletion requires an explicit cancellationMode.",
    );
  }
  params.set("cancellationMode", options.cancellationMode);
  const query = params.toString();
  return this.fetch<LifeOpsCalendarEventCancellationResult>(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}${query ? `?${query}` : ""}`,
    {
      method: "DELETE",
    },
  );
};

calendarClientPrototype.getMeetingAutoJoinSettings = async function (
  this: ElizaClient,
) {
  return this.fetch<MeetingAutoJoinSettings>(
    "/api/lifeops/calendar/meeting-auto-join",
  );
};

calendarClientPrototype.setMeetingAutoJoinPolicy = async function (
  this: ElizaClient,
  policy: MeetingAutoJoinPolicy,
) {
  return this.fetch<MeetingAutoJoinSettings>(
    "/api/lifeops/calendar/meeting-auto-join",
    {
      method: "PUT",
      body: JSON.stringify({ policy }),
    },
  );
};
