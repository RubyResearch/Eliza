/**
 * The calendar domain service — the single owner of calendar reads and
 * mutations across Google, Microsoft, Apple, and guarded ICS/webcal sources.
 *
 * Aggregates each connected account's feed, caches events via
 * `CalendarRepository`, and performs event CRUD, next-event lookup, recurrence
 * handling, and window pruning. A host-injected `CalendarConnectorGate` (from
 * `plugin-lifeops`) supplies Google account/scope selection and reminder/audit
 * hooks; the service never imports the grant registry directly, keeping the
 * dependency direction `plugin-lifeops -> plugin-calendar`.
 */
import { createHash } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  isSerializedSecretHandle,
  logger,
  SECRETS_SERVICE_TYPE,
  Service,
  SsrfBlockedError,
  stableStringify,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import type {
  GoogleCalendarEvent,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google-workspace";
// Runtime error classes come from the dependency-light calendar subpath so
// importing CalendarService never evaluates the Google Workspace root barrel
// (whose client factory eagerly imports the optional `googleapis` SDK — absent
// from lean production images, which aborted plugin import before the local
// calendar view could register). Types stay on the root barrel (erased).
import {
  GoogleCalendarMutationError,
  GoogleCalendarSyncTokenExpiredError,
} from "@elizaos/plugin-google-workspace/calendar";
import {
  type DispatchResult,
  type ScheduledTaskDispatchRecord,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  CreateLifeOpsIcsCalendarSourceRequest,
  CreateLifeOpsLinkedCalendarLinkRequest,
  DisconnectLifeOpsLinkedCalendarRequest,
  FeatureResult,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarAllDayRange,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarImportedDataPurgeReceipt,
  LifeOpsCalendarProvider,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSeedReceipt,
  LifeOpsCalendarSourceError,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSourceKey,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsIcsCalendarSource,
  LifeOpsIcsCalendarSyncResponse,
  LifeOpsLinkedCalendarControl,
  LifeOpsLinkedCalendarControlMutationResult,
  LifeOpsLinkedCalendarEventView,
  LifeOpsLinkedCalendarLink,
  LifeOpsLinkedCalendarMutationResponse,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
  PurgeLifeOpsCalendarImportedDataRequest,
  RebindLifeOpsLinkedCalendarRequest,
  RebindLifeOpsLinkedCalendarResponse,
  ResolveLifeOpsLinkedCalendarConflictRequest,
  RunLifeOpsLinkedCalendarReconciliationRequest,
  SeedLifeOpsCalendarRequest,
  SetLifeOpsCalendarIncludedRequest,
  SetLifeOpsCalendarIncludedResponse,
  UpdateLifeOpsIcsCalendarSourceRequest,
  UpdateLifeOpsLinkedCalendarControlRequest,
} from "@elizaos/shared";
import {
  APPLE_CALENDAR_ACCOUNT_LABEL,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  createNativeAppleCalendarEvent,
  deleteNativeAppleCalendarEvent,
  getNativeAppleCalendarFeed,
  getNativeAppleCalendarPermissionStatus,
  isAppleCalendarGrant,
  listNativeAppleCalendars,
  subscribeNativeAppleCalendarChanges,
  updateNativeAppleCalendarEvent,
} from "../apple-calendar.js";
import {
  type GoogleCalendarNotificationHeaders,
  type GoogleCalendarWatchChannel,
  GoogleCalendarWatchLifecycle,
  type GoogleCalendarWebhookResult,
} from "../google-watch/index.js";
import {
  fetchIcsFeed,
  fingerprintIcsSourceUrl,
  type IcsFetchTransport,
  normalizeIcsSourceUrl,
} from "../ics/fetch.js";
import { parseIcsCalendar } from "../ics/parser.js";
import {
  icsCalendarSummary,
  lifeOpsCalendarEventFromIcs,
  publicIcsCalendarSource,
} from "../ics/source.js";
import {
  availabilityReservationParentEventId,
  type CalendarOwnedAvailabilityKind,
  createCalendarAvailabilityReservation,
  isLocallyManagedAvailabilityEvent,
} from "../internal/availability-metadata.js";
import {
  buildNextCalendarEventContext,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "../internal/calendar-normalize.js";
import { DEFAULT_CALENDAR_REMINDER_STEPS } from "../internal/constants.js";
import {
  createElizaCalendarEvent,
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
  ELIZA_CALENDAR_PROVIDER,
  elizaCalendarSummary,
  isElizaCalendarEventId,
  isElizaCalendarGrant,
  updateElizaCalendarEvent,
} from "../internal/eliza-calendar.js";
import { CalendarServiceError, fail } from "../internal/errors.js";
import {
  accountIdForGrant,
  googleAccountIdFromGrantId,
  googleCalendarEventInput,
  googleCalendarEventPatchInput,
  lifeOpsCalendarEventFromGoogle,
  lifeOpsCalendarSummaryFromGoogle,
  requireGoogleServiceMethod,
} from "../internal/google-delegates.js";
import {
  normalizeOptionalBoolean,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../internal/normalize.js";
import {
  assertRecurrenceStartMatchesRule,
  buildRecurrenceSplitPlan,
  normalizeRecurrence,
  normalizeRecurrenceScope,
  recurrenceLinesFrom,
  recurrenceOriginalStartAtFrom,
  recurringEventIdFrom,
} from "../internal/recurrence.js";
import { getZonedDateParts } from "../internal/time.js";
import {
  cancelAllMeetingAutoJoinTasks,
  reconcileMeetingAutoJoin,
  restoreMeetingAutoJoinAnchors,
} from "../meetings/auto-join.js";
import {
  isMeetingAutoJoinPolicy,
  type MeetingAutoJoinSettings,
  readMeetingAutoJoinSettings,
  writeMeetingAutoJoinPolicy,
} from "../meetings/auto-join-settings.js";
import {
  DefaultMicrosoftGraphCalendarPort,
  isMicrosoftCalendarGrantId,
  MICROSOFT_CALENDAR_PROVIDER,
  type MicrosoftCalendarAccount,
  type MicrosoftGraphCalendarPort,
  type MicrosoftGraphCalendarSyncBatch,
  MicrosoftGraphDeltaExpiredError,
  type MicrosoftGraphEvent,
} from "../microsoft/index.js";
import type { CalendarAvailabilitySource } from "./availability.js";
import {
  CalendarRepository,
  createLifeOpsCalendarSyncState,
  type IcsCalendarSourceRecord,
} from "./CalendarRepository.js";
import {
  calendarFeedPreferenceKey,
  ensureCalendarFeedIncludes,
  setCalendarFeedIncluded,
} from "./feed-preferences.js";
import {
  CALENDAR_GUEST_AVAILABILITY_PURPOSE,
  type CalendarGuestAvailabilityGrant,
  type CalendarHostGate,
  createDefaultCalendarHostGate,
  createLifeOpsAuditEvent,
  createLifeOpsReminderPlan,
} from "./gate.js";
import {
  type LinkedCalendarControlMutation,
  LinkedCalendarControlRepository,
} from "./linked-calendar-control.js";
import {
  GoogleLinkedCalendarProviderPort,
  type LinkedCalendarEventRecord,
  type LinkedCalendarLocalPort,
  LinkedCalendarReconciler,
  LinkedCalendarRepository,
  type LinkedCalendarSemanticEvent,
} from "./linked-calendar-sync.js";

type AggregatedCalendarFeedSource = {
  calendar: Pick<
    LifeOpsCalendarSummary,
    | "accessRole"
    | "accountEmail"
    | "calendarId"
    | "connectorAccountId"
    | "grantId"
    | "provider"
    | "side"
    | "summary"
  >;
  feed: LifeOpsCalendarFeed;
};

type CalendarSourceDiscovery = {
  calendars: LifeOpsCalendarSummary[];
  failures: LifeOpsCalendarSourceHealth[];
};

type AppleCalendarFailure = Extract<FeatureResult<unknown>, { ok: false }>;

type GoogleCalendarSyncBatch = {
  events: GoogleCalendarEvent[];
  nextSyncToken: string | null;
};

const CALENDAR_FEED_FRESHNESS_MS = 60_000;
const DEFAULT_ICS_SYNC_LEASE_MS = 30_000;
const CALENDAR_SOURCE_UNSUPPORTED = "CALENDAR_SOURCE_UNSUPPORTED";
export const MAX_GOOGLE_CALENDAR_EVENTS = 10_000;

type CalendarSecretsService = {
  getGlobal(key: string): Promise<string | null>;
  setGlobal(key: string, value: string): Promise<boolean>;
  delete(
    key: string,
    context: {
      level: "global";
      agentId: string;
      requesterId: string;
    },
  ): Promise<boolean>;
};

function isCalendarSecretsService(
  service: unknown,
): service is CalendarSecretsService {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<CalendarSecretsService>;
  return (
    typeof candidate.getGlobal === "function" &&
    typeof candidate.setGlobal === "function" &&
    typeof candidate.delete === "function"
  );
}

function normalizeIcsSubscriptionUrl(input: string): URL {
  try {
    return normalizeIcsSourceUrl(input);
  } catch {
    // error-policy:J1 The public CRUD boundary exposes a stable validation
    // error without retaining the capability-bearing input in an error cause.
    throw new CalendarServiceError(
      400,
      "Calendar subscription URL is invalid or unsupported.",
      "ICS_INVALID_SOURCE_URL",
    );
  }
}

function shouldIncludeIcsCalendars(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (
    request.grantId &&
    (isAppleCalendarGrant(request.grantId) ||
      isMicrosoftCalendarGrantId(request.grantId) ||
      isElizaCalendarGrant(request.grantId))
  ) {
    return false;
  }
  return true;
}

function shouldIncludeElizaCalendar(request: {
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.side && request.side !== "owner") return false;
  return !request.grantId || isElizaCalendarGrant(request.grantId);
}

function googleEventIntersectsWindow(
  event: GoogleCalendarEvent,
  timeMin: string,
  timeMax: string,
): boolean {
  if (event.status === "cancelled" || !event.start || !event.end) {
    return false;
  }
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const windowStart = Date.parse(timeMin);
  const windowEnd = Date.parse(timeMax);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > windowStart &&
    start < windowEnd
  );
}

function isGoogleCalendarDisconnected(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Google Calendar is not connected." &&
    (error as Error & { status?: unknown }).status === 409
  );
}

function calendarSourceKey(
  calendar: Pick<
    LifeOpsCalendarSummary,
    "provider" | "side" | "grantId" | "connectorAccountId" | "calendarId"
  >,
): LifeOpsCalendarSourceKey {
  return {
    provider: calendar.provider,
    side: calendar.side,
    grantId: calendar.grantId,
    connectorAccountId: calendar.connectorAccountId,
    calendarId: calendar.calendarId,
  };
}

function normalizeCalendarProvider(value: unknown): LifeOpsCalendarProvider {
  const provider = requireNonEmptyString(value, "provider");
  switch (provider) {
    case "google":
    case "microsoft":
    case "apple_calendar":
    case "ics":
    case "eliza":
      return provider;
    default:
      throw new CalendarServiceError(
        400,
        "provider must identify a supported calendar source",
        "CALENDAR_SOURCE_PROVIDER_INVALID",
      );
  }
}

/**
 * Diagnostic projection of a provider HTTP failure (GaxiosError and friends
 * carry `status` / `response.data`). Feed-source failures degrade to a stale
 * or unavailable source, so this context is the only place the provider's
 * actual rejection body (e.g. a Google 400's error message) becomes visible
 * to operators.
 */
function providerResponseErrorContext(
  error: unknown,
): Record<string, string | number> {
  const context: Record<string, string | number> = {};
  const shaped = error as {
    status?: unknown;
    response?: { status?: unknown; data?: unknown };
  };
  const status = shaped.status ?? shaped.response?.status;
  if (typeof status === "number") {
    context.providerStatus = status;
  }
  const body = shaped.response?.data;
  if (typeof body === "string") {
    context.providerBody = truncateWellFormed(toWellFormedUnicode(body), 2000);
  } else if (body !== undefined && body !== null) {
    try {
      context.providerBody = truncateWellFormed(
        toWellFormedUnicode(JSON.stringify(body)),
        2000,
      );
    } catch {
      // error-policy:J3 a non-serializable provider body degrades to its type
      // tag; the raw error object still travels with the report.
      context.providerBody = Object.prototype.toString.call(body);
    }
  }
  return context;
}

function calendarSourceError(error: unknown): LifeOpsCalendarSourceError {
  if (error instanceof CalendarServiceError) {
    return {
      code: error.code ?? "CALENDAR_SOURCE_ERROR",
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  if (error instanceof ElizaError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.severity === "ephemeral",
    };
  }
  return {
    code: "CALENDAR_SOURCE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function icsCalendarSyncError(error: unknown): LifeOpsCalendarSourceError {
  if (error instanceof SsrfBlockedError) {
    return {
      code: "ICS_SOURCE_NETWORK_BLOCKED",
      message: "Calendar subscription target is blocked by network policy.",
      retryable: false,
    };
  }
  if (error instanceof CalendarServiceError || error instanceof ElizaError) {
    return calendarSourceError(error);
  }
  return {
    code: "ICS_SYNC_FAILED",
    message: "Calendar subscription sync failed.",
    retryable: true,
  };
}

function calendarSourceHealth(args: {
  calendar: Pick<
    LifeOpsCalendarSummary,
    | "provider"
    | "side"
    | "grantId"
    | "connectorAccountId"
    | "calendarId"
    | "summary"
    | "accessRole"
  >;
  status: LifeOpsCalendarSourceHealth["status"];
  syncedAt: string | null;
  error: LifeOpsCalendarSourceError | null;
}): LifeOpsCalendarSourceHealth {
  return {
    key: calendarSourceKey(args.calendar),
    summary: args.calendar.summary,
    accessRole: args.calendar.accessRole,
    visibility:
      args.calendar.accessRole === "freeBusyReader" ? "busy_only" : "details",
    status: args.status,
    syncedAt: args.syncedAt,
    error: args.error,
  };
}

function hasGoogleConnectorGrant<
  TStatus extends { grant: LifeOpsConnectorGrant | null },
>(status: TStatus): status is TStatus & { grant: LifeOpsConnectorGrant } {
  return status.grant !== null;
}

function isAppleCalendarFailure(
  result: FeatureResult<unknown>,
): result is AppleCalendarFailure {
  return result.ok === false;
}

function failAppleCalendarResult(
  result: FeatureResult<unknown>,
  operation: string,
): never {
  if (!isAppleCalendarFailure(result)) {
    fail(500, `Apple Calendar ${operation} unexpectedly succeeded.`);
  }
  if (result.reason === "permission") {
    fail(
      403,
      `Apple Calendar permission is required for ${operation}. Grant Calendar access to continue.`,
    );
  }
  if (result.reason === "not_supported") {
    fail(
      409,
      `Apple Calendar is not available on ${result.platform}; connect Google Calendar or use a native Apple platform.`,
      CALENDAR_SOURCE_UNSUPPORTED,
    );
  }
  if (
    result.reason === "native_error" &&
    /attendee|invitee|invited meeting/i.test(result.message)
  ) {
    fail(
      409,
      result.message ||
        "Apple Calendar cannot create or edit invited meetings. Connect Google Calendar or remove attendees.",
    );
  }
  fail(
    502,
    result.reason === "native_error" && result.message
      ? result.message
      : `Apple Calendar ${operation} failed through EventKit.`,
  );
}

function appleCalendarPlaceholderSummary(args: {
  calendarId?: string | null;
  timeZone?: string | null;
  side?: LifeOpsConnectorSide | null;
}): LifeOpsCalendarSummary {
  const calendarId = args.calendarId?.trim() || "primary";
  return {
    provider: APPLE_CALENDAR_PROVIDER,
    side: args.side ?? "owner",
    grantId: APPLE_CALENDAR_GRANT_ID,
    connectorAccountId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: null,
    calendarId,
    summary:
      calendarId === "primary" ? APPLE_CALENDAR_ACCOUNT_LABEL : calendarId,
    description: null,
    primary: calendarId === "primary",
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: args.timeZone ?? null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

function googleCalendarPlaceholderSummary(
  grant: LifeOpsConnectorGrant,
  calendarId = "all",
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: grant.side,
    grantId: grant.id,
    connectorAccountId: accountIdForGrant(grant),
    accountEmail: grant.identityEmail ?? null,
    calendarId,
    summary: grant.identityEmail
      ? `Google Calendar (${grant.identityEmail})`
      : "Google Calendar",
    description: null,
    primary: calendarId === "primary",
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

function microsoftCalendarPlaceholderSummary(
  account: MicrosoftCalendarAccount,
  calendarId = "all",
): LifeOpsCalendarSummary {
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    grantId: account.grant.id,
    connectorAccountId: account.account.id,
    accountEmail: account.grant.identityEmail ?? null,
    calendarId,
    summary: account.grant.identityEmail
      ? `Microsoft Calendar (${account.grant.identityEmail})`
      : "Microsoft Calendar",
    description: null,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

function microsoftDiscoveryPlaceholderSummary(
  grantId = "microsoft-discovery",
): LifeOpsCalendarSummary {
  const connectorAccountId = grantId.startsWith("connector-account:microsoft:")
    ? grantId.slice("connector-account:microsoft:".length)
    : grantId;
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: "owner",
    grantId,
    connectorAccountId,
    accountEmail: null,
    calendarId: "all",
    summary: "Microsoft Calendar",
    description: null,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

function lifeOpsCalendarSummaryFromMicrosoft(args: {
  account: MicrosoftCalendarAccount;
  calendar: {
    id: string;
    name: string;
    ownerAddress: string | null;
    isDefault: boolean;
    canEdit: boolean;
    color: string | null;
    hexColor: string | null;
  };
}): LifeOpsCalendarSummary {
  const { account, calendar } = args;
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    grantId: account.grant.id,
    connectorAccountId: account.account.id,
    accountEmail: account.grant.identityEmail ?? calendar.ownerAddress ?? null,
    calendarId: calendar.id,
    summary: calendar.name,
    description: null,
    primary: calendar.isDefault,
    accessRole:
      calendar.canEdit &&
      account.grant.capabilities.includes("microsoft.calendar.write")
        ? "writer"
        : "reader",
    backgroundColor: calendar.hexColor ?? calendar.color,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

function lifeOpsCalendarEventFromMicrosoft(args: {
  event: MicrosoftGraphEvent;
  account: MicrosoftCalendarAccount;
  calendarId: string;
  agentId: string;
  syncedAt: string;
}): LifeOpsCalendarEvent {
  const { event, account, calendarId, agentId, syncedAt } = args;
  const updatedAt =
    event.lastModifiedAt && Number.isFinite(Date.parse(event.lastModifiedAt))
      ? new Date(event.lastModifiedAt).toISOString()
      : syncedAt;
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.toLowerCase()
      : null;
  return {
    id: `${agentId}:microsoft:${account.grant.side}:grant:${account.grant.id}:calendar:${calendarId}:${event.id}`,
    externalId: event.id,
    agentId,
    provider: MICROSOFT_CALENDAR_PROVIDER,
    side: account.grant.side,
    calendarId,
    title: event.subject,
    description: event.bodyPreview,
    location: event.location,
    status: event.showAs,
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay,
    timezone: event.timeZone,
    htmlLink: event.webLink,
    conferenceLink: event.joinUrl,
    organizer: event.organizer,
    attendees: event.attendees.map((attendee) => ({
      ...attendee,
      organizer:
        attendee.organizer ||
        Boolean(
          organizerEmail && attendee.email?.toLowerCase() === organizerEmail,
        ),
    })),
    recurrence: null,
    recurringEventId: event.seriesMasterId,
    metadata: {
      microsoftGraph: true,
      eventType: event.eventType,
      iCalUId: event.iCalUId,
      originalStart: event.originalStart,
      changeKey: event.changeKey,
      graphLastModifiedAt: event.lastModifiedAt,
      sensitivity: event.sensitivity,
      recurrence: event.recurrence,
      recurringEventId: event.seriesMasterId,
      transparency: event.showAs === "free" ? "transparent" : "opaque",
    },
    syncedAt,
    updatedAt,
    connectorAccountId: account.account.id,
    grantId: account.grant.id,
    accountEmail: account.grant.identityEmail ?? undefined,
  };
}

function shouldIncludeMicrosoftCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.grantId && !isMicrosoftCalendarGrantId(request.grantId)) {
    return false;
  }
  return true;
}

function microsoftEventIntersectsWindow(
  event: MicrosoftGraphEvent,
  timeMin: string,
  timeMax: string,
): boolean {
  return (
    Date.parse(event.endAt) > Date.parse(timeMin) &&
    Date.parse(event.startAt) < Date.parse(timeMax)
  );
}

function microsoftEventRevisionMs(event: MicrosoftGraphEvent): number | null {
  if (!event.lastModifiedAt) return null;
  const parsed = Date.parse(event.lastModifiedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function cachedMicrosoftEventRevisionMs(
  event: LifeOpsCalendarEvent,
): number | null {
  const revision = event.metadata.graphLastModifiedAt;
  if (typeof revision !== "string") return null;
  const parsed = Date.parse(revision);
  return Number.isFinite(parsed) ? parsed : null;
}

function microsoftEventIsAlreadyCached(
  cached: LifeOpsCalendarEvent,
  incoming: MicrosoftGraphEvent,
): boolean {
  const cachedChangeKey = cached.metadata.changeKey;
  return (
    typeof cachedChangeKey === "string" &&
    incoming.changeKey !== null &&
    cachedChangeKey === incoming.changeKey
  );
}

function failAppleRecurrenceUnsupported(operation: string): never {
  fail(
    400,
    `Apple Calendar does not support recurring-event ${operation} through this integration. Connect Google Calendar for recurring events.`,
    "CALENDAR_RECURRENCE_UNSUPPORTED_PROVIDER",
  );
}

function failMicrosoftCalendarMutationUnsupported(operation: string): never {
  fail(
    409,
    `Microsoft Calendar ${operation} is unavailable because Microsoft Graph does not expose an atomic event-version precondition through this integration.`,
    "MICROSOFT_CALENDAR_CONDITIONAL_WRITE_UNSUPPORTED",
  );
}

function failMicrosoftRecurrenceUnsupported(operation: string): never {
  fail(
    400,
    `Microsoft Calendar recurring-event ${operation} is unavailable until RFC 5545 rules can be losslessly mapped to Microsoft Graph patterned recurrence.`,
    "MICROSOFT_CALENDAR_RECURRENCE_UNSUPPORTED",
  );
}

function failConditionalMutationUnsupported(provider: string): never {
  fail(
    409,
    `${provider} Calendar does not expose an atomic provider-version precondition through this integration.`,
    "CALENDAR_CONDITIONAL_MUTATION_UNSUPPORTED",
  );
}

function requireGoogleProviderVersion(event: LifeOpsCalendarEvent): string {
  const etag = event.metadata.etag;
  if (typeof etag !== "string" || !etag.trim()) {
    fail(
      502,
      "Google Calendar did not return the event ETag required for a conditional mutation.",
      "CALENDAR_PROVIDER_VERSION_MISSING",
    );
  }
  return etag.trim();
}

function translateGoogleMutationError(error: unknown): never {
  if (error instanceof GoogleCalendarMutationError) {
    if (error.outcome === "precondition_failed") {
      fail(
        409,
        "The calendar event changed after approval; create a fresh approval.",
        "PROVIDER_PRECONDITION_FAILED",
      );
    }
    fail(
      422,
      "Google Calendar rejected the mutation before acceptance.",
      "PROVIDER_REJECTED_PERMANENT",
    );
  }
  throw error;
}

function requireMatchingGoogleProviderVersion(
  event: LifeOpsCalendarEvent,
  expectedVersion: string | undefined,
  target: "occurrence" | "series master",
): string {
  const expected = expectedVersion?.trim();
  if (!expected) {
    fail(
      409,
      `A this-and-following mutation must bind the exact ${target} provider version.`,
      "CALENDAR_RECURRENCE_SPLIT_BINDING_REQUIRED",
    );
  }
  const current = requireGoogleProviderVersion(event);
  if (current !== expected) {
    fail(
      409,
      `The recurring ${target} changed after approval; create a fresh approval.`,
      "PROVIDER_PRECONDITION_FAILED",
    );
  }
  return current;
}

function requireVerifiedRecurrence(
  event: LifeOpsCalendarEvent,
  expected: readonly string[],
  phase: "trimmed original" | "new following series",
): void {
  const actual = normalizeRecurrence(recurrenceLinesFrom(event));
  if (
    !actual ||
    actual.length !== expected.length ||
    actual.some((line, index) => line !== expected[index])
  ) {
    fail(
      502,
      `Google Calendar did not return the expected recurrence for the ${phase}.`,
      "CALENDAR_RECURRENCE_SPLIT_VERIFICATION_FAILED",
    );
  }
}

function recurrenceSplitAttendees(
  event: LifeOpsCalendarEvent,
): CreateLifeOpsCalendarEventAttendee[] {
  return event.attendees.map((attendee, index) => {
    const email = attendee.email?.trim();
    if (!email) {
      fail(
        409,
        `The recurring series attendee at index ${index} has no email address and cannot be preserved in a lossless split.`,
        "CALENDAR_RECURRENCE_SPLIT_ATTENDEE_UNSUPPORTED",
      );
    }
    return {
      email,
      ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
      ...(attendee.optional !== undefined
        ? { optional: attendee.optional }
        : {}),
    };
  });
}

function isMicrosoftCalendarEventId(
  eventId: string | null | undefined,
  agentId: string,
): boolean {
  return Boolean(eventId?.startsWith(`${agentId}:microsoft:`));
}

function shouldIncludeAppleCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (request.grantId && !isAppleCalendarGrant(request.grantId)) return false;
  return true;
}

export function mergeAggregatedCalendarFeedEvents(
  sources: readonly AggregatedCalendarFeedSource[],
  links: readonly LinkedCalendarEventRecord[] = [],
): LifeOpsCalendarEvent[] {
  type Candidate = {
    event: LifeOpsCalendarEvent;
    source: AggregatedCalendarFeedSource["calendar"];
  };

  const eventUid = (event: LifeOpsCalendarEvent): string | null => {
    for (const key of ["iCalUID", "iCalUId", "icalUid", "icsUid"]) {
      const value = event.metadata[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };
  const recurrenceIdentity = (event: LifeOpsCalendarEvent): string => {
    for (const key of [
      "originalStartTime",
      "icsRecurrenceId",
      "originalStart",
    ]) {
      const value = event.metadata[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return event.startAt;
  };
  const allDayDateIdentity = (
    value: string,
    event: LifeOpsCalendarEvent,
  ): string | null => {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return null;
    if (event.timezone) {
      try {
        const parts = getZonedDateParts(parsed, event.timezone);
        return [parts.year, parts.month, parts.day]
          .map((part, index) =>
            index === 0 ? String(part) : String(part).padStart(2, "0"),
          )
          .join("-");
      } catch {
        // error-policy:J3 An invalid source timezone makes portable all-day
        // identity unavailable; keeping both events is safer than collapsing.
        return null;
      }
    }
    return parsed.toISOString().slice(0, 10);
  };
  const occurrenceKey = (event: LifeOpsCalendarEvent): string | null => {
    const uid = eventUid(event);
    if (!uid) return null;
    const identity = recurrenceIdentity(event);
    const normalizedIdentity = event.isAllDay
      ? allDayDateIdentity(identity, event)
      : Number.isFinite(Date.parse(identity))
        ? new Date(identity).toISOString()
        : null;
    if (!normalizedIdentity) return null;
    // RECURRENCE-ID/originalStartTime identifies a moved exception; current
    // DTSTART does not. Timed values are normalized to an instant, while
    // all-day values retain their local calendar date.
    return `${uid}\u0000${normalizedIdentity}\u0000${event.isAllDay ? "all-day" : "timed"}`;
  };
  const accessRank = (accessRole: string): number => {
    switch (accessRole.toLowerCase()) {
      case "owner":
        return 5;
      case "writer":
        return 4;
      case "reader":
        return 3;
      case "freebusyreader":
        return 2;
      case "none":
        return 0;
      default:
        return 1;
    }
  };
  const providerRank = (provider: LifeOpsCalendarProvider): number => {
    switch (provider) {
      case "google":
      case "microsoft":
        return 4;
      case "eliza":
        return 5;
      case "apple_calendar":
        return 3;
      case "ics":
        return 1;
    }
  };
  const sourceSequence = (event: LifeOpsCalendarEvent): number => {
    for (const key of ["icsSequence", "sequence"]) {
      const value = event.metadata[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (
        typeof value === "string" &&
        value.trim() &&
        Number.isFinite(Number(value))
      ) {
        return Number(value);
      }
    }
    return 0;
  };
  const candidateRank = (candidate: Candidate): readonly number[] => [
    Date.parse(candidate.event.updatedAt),
    sourceSequence(candidate.event),
    candidate.event.side === "owner" ? 1 : 0,
    accessRank(candidate.source.accessRole),
    providerRank(candidate.event.provider),
    Date.parse(candidate.event.syncedAt),
  ];
  const compareCandidates = (left: Candidate, right: Candidate): number => {
    const leftRank = candidateRank(left);
    const rightRank = candidateRank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      const leftValue = Number.isFinite(leftRank[index]) ? leftRank[index] : 0;
      const rightValue = Number.isFinite(rightRank[index])
        ? rightRank[index]
        : 0;
      if (leftValue !== rightValue) return leftValue - rightValue;
    }
    return right.event.id.localeCompare(left.event.id);
  };
  const sourceReference = (candidate: Candidate) => ({
    eventId: candidate.event.id,
    provider: candidate.event.provider,
    side: candidate.event.side,
    grantId: candidate.event.grantId ?? candidate.source.grantId,
    connectorAccountId:
      candidate.event.connectorAccountId ?? candidate.source.connectorAccountId,
    calendarId: candidate.event.calendarId,
  });
  const localEventKey = (candidate: Candidate): string =>
    JSON.stringify([
      candidate.event.provider,
      candidate.event.side,
      candidate.event.grantId ?? candidate.source.grantId,
      candidate.event.connectorAccountId ?? candidate.source.connectorAccountId,
      candidate.event.calendarId,
      candidate.event.id,
    ]);

  const linkedKeys = new Map<string, string>();
  const linkedLocalIds = new Set<string>();
  const pendingUpdateLinks = new Map<string, string>();
  const events = sources.flatMap(({ feed }) => feed.events);
  for (const link of links) {
    const pendingUpdate =
      link.state === "dirty" && link.pendingOperation === "update";
    if ((link.state !== "clean" || link.pendingOperation) && !pendingUpdate)
      continue;
    const local = events.find(
      (event) =>
        event.provider === "eliza" &&
        event.side === "owner" &&
        event.agentId === link.agentId &&
        event.id === link.localEventId &&
        event.metadata.version === link.localRevision,
    );
    const remote = events.find(
      (event) =>
        event.provider === "google" &&
        event.side === "owner" &&
        event.agentId === link.agentId &&
        event.connectorAccountId === link.connectorAccountId &&
        event.calendarId === link.providerCalendarId &&
        event.externalId === link.providerEventId &&
        event.metadata.etag === link.providerEtag,
    );
    if (!local || !remote) continue;
    // Only the canonical mapping can connect a local event without an iCalUID
    // to its provider copy. Matching titles or times never establish identity.
    const portableKey = occurrenceKey(remote);
    const key = portableKey
      ? `portable\u0000${portableKey}`
      : `linked\u0000${link.id}`;
    linkedKeys.set(local.id, key);
    linkedKeys.set(remote.id, key);
    linkedLocalIds.add(local.id);
    if (pendingUpdate) pendingUpdateLinks.set(local.id, link.id);
  }

  const groups = new Map<string, Candidate[]>();
  for (const source of sources) {
    for (const event of source.feed.events) {
      const candidate: Candidate = {
        source: source.calendar,
        event: {
          ...event,
          grantId: event.grantId ?? source.calendar.grantId,
          connectorAccountId:
            event.connectorAccountId ?? source.calendar.connectorAccountId,
          accountEmail:
            event.accountEmail ?? source.calendar.accountEmail ?? undefined,
          calendarSummary: event.calendarSummary ?? source.calendar.summary,
        },
      };
      const semanticKey = occurrenceKey(candidate.event);
      const groupKey =
        linkedKeys.get(event.id) ??
        (semanticKey
          ? `portable\u0000${semanticKey}`
          : `source\u0000${localEventKey(candidate)}`);
      const group = groups.get(groupKey);
      if (group) {
        group.push(candidate);
      } else {
        groups.set(groupKey, [candidate]);
      }
    }
  }

  return [...groups.values()]
    .map((group) => {
      const authoritative =
        group.find(({ event }) => linkedLocalIds.has(event.id)) ??
        group.reduce((winner, candidate) =>
          compareCandidates(candidate, winner) > 0 ? candidate : winner,
        );
      if (group.length === 1) return authoritative.event;
      const allSources = group
        .map(sourceReference)
        .sort((left, right) =>
          [
            left.provider,
            left.side,
            left.grantId,
            left.calendarId,
            left.eventId,
          ]
            .join("\u0000")
            .localeCompare(
              [
                right.provider,
                right.side,
                right.grantId,
                right.calendarId,
                right.eventId,
              ].join("\u0000"),
            ),
        );
      const conflictingFields = [
        "title",
        "status",
        "startAt",
        "endAt",
        "location",
        "description",
      ].filter((field) => {
        const values = new Set(
          group.map((candidate) =>
            String(
              candidate.event[
                field as keyof Pick<
                  LifeOpsCalendarEvent,
                  | "title"
                  | "status"
                  | "startAt"
                  | "endAt"
                  | "location"
                  | "description"
                >
              ],
            ),
          ),
        );
        return values.size > 1;
      });
      return {
        ...authoritative.event,
        metadata: {
          ...authoritative.event.metadata,
          deduplication: {
            identityVersion: linkedLocalIds.has(authoritative.event.id)
              ? "canonical-linked-calendar-v1"
              : "rfc5545-uid-recurrence-id-v2",
            authoritativeSource: sourceReference(authoritative),
            sources: allSources,
            conflictingFields,
            ...(pendingUpdateLinks.has(authoritative.event.id)
              ? {
                  pendingUpdate: {
                    linkId: pendingUpdateLinks.get(authoritative.event.id),
                    // Keep complete source snapshots while the provider still has the previous revision.
                    snapshots: group.map(({ event }) => event),
                  },
                }
              : {}),
          },
        },
      };
    })
    .sort(
      (left, right) =>
        left.startAt.localeCompare(right.startAt) ||
        left.id.localeCompare(right.id),
    );
}

/**
 * Owns the calendar domain: multi-provider feeds, event CRUD for writable
 * providers, the event/sync store, and next-event context. Cross-domain
 * concerns (Google connector grants, reminder plans, audit events) are reached
 * through an injected {@link CalendarHostGate}; Microsoft uses its
 * calendar-owned Graph port and the runtime connector-account registry.
 */
export class CalendarService extends Service {
  static override serviceType = "calendar";
  capabilityDescription =
    "Built-in Eliza, Google, Microsoft, Apple, and guarded ICS calendar feeds, event management, guest free/busy, and next-event context for Eliza agents.";

  private readonly repo: CalendarRepository;
  private gate: CalendarHostGate;
  private microsoftPort: MicrosoftGraphCalendarPort;
  private readonly googleWatch: GoogleCalendarWatchLifecycle;
  private readonly linkedRepo: LinkedCalendarRepository;
  private readonly linkedControl: LinkedCalendarControlRepository;
  private readonly activeLinkedDispatches = new Set<string>();
  private linkedCalendarDrain: Promise<void> | null = null;
  private linkedCalendarDrainRequested = false;
  private readonly googleSyncLocks = new Map<string, Promise<void>>();
  private readonly microsoftSyncLocks = new Map<string, Promise<void>>();
  private icsSecretCleanupDrain: Promise<void> | null = null;
  private appleCalendarChangeListener: { remove: () => Promise<void> } | null =
    null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.repo = new CalendarRepository(this.runtime);
    this.linkedRepo = new LinkedCalendarRepository(this.runtime);
    this.linkedControl = new LinkedCalendarControlRepository(this.runtime);
    this.gate = createDefaultCalendarHostGate(this.runtime);
    this.microsoftPort = new DefaultMicrosoftGraphCalendarPort(this.runtime);
    this.googleWatch = new GoogleCalendarWatchLifecycle(this.runtime, {
      syncChannel: (channel) => this.syncGoogleCalendarWatchChannel(channel),
    });
  }

  private publicLinkedCalendar(
    record: LinkedCalendarEventRecord,
  ): LifeOpsLinkedCalendarLink {
    return {
      id: record.id,
      localEventId: record.localEventId,
      connectorAccountId: record.connectorAccountId,
      providerCalendarId: record.providerCalendarId,
      providerEventId: record.providerEventId,
      providerEtag: record.providerEtag,
      localRevision: record.localRevision,
      state: record.state,
      pendingOperation: record.pendingOperation,
      lastErrorCode: record.lastErrorCode,
      lastErrorMessage: record.lastErrorMessage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private linkedSemanticEvent(
    event: LifeOpsCalendarEvent,
  ): LinkedCalendarSemanticEvent {
    return {
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      timeZone: event.timezone,
      isAllDay: event.isAllDay,
      attendees: event.attendees.flatMap((attendee) =>
        attendee.email
          ? [{ email: attendee.email, optional: attendee.optional === true }]
          : [],
      ),
    };
  }

  private linkedLocalPort(): LinkedCalendarLocalPort {
    return {
      get: async (eventId) => {
        const event = await this.repo.getCalendarEventById(
          this.agentId(),
          eventId,
        );
        if (!event || event.provider !== ELIZA_CALENDAR_PROVIDER) return null;
        const revision = Number(event.metadata.version);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new CalendarServiceError(
            500,
            "The linked Eliza event has an invalid revision.",
            "ELIZA_CALENDAR_VERSION_INVALID",
          );
        }
        return {
          eventId: event.id,
          revision,
          event: this.linkedSemanticEvent(event),
        };
      },
      applyProviderEvent: async (eventId, providerEvent, expectedRevision) => {
        const existing = await this.resolveElizaCalendarEvent({ eventId });
        if (Number(existing.metadata.version) !== expectedRevision) {
          throw new CalendarServiceError(
            409,
            "The linked Eliza event changed during reconciliation.",
            "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          );
        }
        const updated = updateElizaCalendarEvent({
          event: existing,
          title: providerEvent.title,
          description: providerEvent.description,
          location: providerEvent.location,
          startAt: providerEvent.startAt,
          endAt: providerEvent.endAt,
          isAllDay: providerEvent.isAllDay,
          ...(providerEvent.timeZone
            ? { timeZone: providerEvent.timeZone }
            : {}),
          attendees: providerEvent.attendees.map((attendee) => ({
            email: attendee.email,
            optional: attendee.optional === true,
          })),
          now: new Date(),
        });
        const expectedVersion = String(existing.metadata.etag ?? "");
        const persisted = await this.repo.replaceCalendarEventIfVersion({
          event: updated,
          expectedVersion,
        });
        if (!persisted) {
          throw new CalendarServiceError(
            409,
            "The linked Eliza event changed during reconciliation.",
            "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          );
        }
        return {
          eventId: persisted.id,
          revision: Number(persisted.metadata.version),
          event: this.linkedSemanticEvent(persisted),
        };
      },
      delete: async (eventId, expectedRevision) => {
        const existing = await this.resolveElizaCalendarEvent({ eventId });
        if (Number(existing.metadata.version) !== expectedRevision) {
          throw new CalendarServiceError(
            409,
            "The linked Eliza event changed during reconciliation.",
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
          );
        }
        const deleted = await this.repo.deleteCalendarEventByIdIfVersion({
          agentId: this.agentId(),
          eventId,
          expectedVersion: String(existing.metadata.etag ?? ""),
        });
        if (!deleted) {
          throw new CalendarServiceError(
            409,
            "The linked Eliza event changed during reconciliation.",
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
          );
        }
      },
    };
  }

  private linkedReconciler(
    onProviderMutation?: () => void,
  ): LinkedCalendarReconciler {
    const google = this.runtime.getService("google");
    if (!google || typeof google !== "object") {
      throw new CalendarServiceError(
        503,
        "Google Workspace is required for linked calendar synchronization.",
        "GOOGLE_CALENDAR_SERVICE_UNAVAILABLE",
      );
    }
    return new LinkedCalendarReconciler(
      this.linkedRepo,
      this.linkedLocalPort(),
      new GoogleLinkedCalendarProviderPort(google as IGoogleWorkspaceService),
      onProviderMutation,
    );
  }

  private async activeLinkedCalendarTarget(): Promise<{
    connectorAccountId: string;
    providerCalendarId: string;
  } | null> {
    const control = await this.linkedControl.read();
    if (control.paused || !control.destination) return null;
    const accounts = await this.gate.getGoogleConnectorAccounts(
      new URL("http://localhost/api/lifeops/calendar/linked/automatic-sync"),
      "owner",
    );
    const account = accounts.find(
      (account) =>
        account.connected &&
        account.grant?.capabilities.includes("google.calendar.read") &&
        account.grant.capabilities.includes("google.calendar.write") &&
        accountIdForGrant(account.grant) ===
          control.destination?.connectorAccountId,
    );
    if (!account) {
      throw new CalendarServiceError(
        409,
        "The selected Google calendar account is unavailable or missing permissions. Review its connection before resuming sync.",
        "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
      );
    }
    return control.destination;
  }

  private async runLinkedCalendarOperation(
    record: LinkedCalendarEventRecord,
    strategy?: "keep_eliza" | "keep_google",
  ) {
    if (record.state === "local_only") return "paused" as const;
    const control = await this.linkedControl.read();
    if (control.paused || control.dispatch) return "paused" as const;
    if (!(await this.activeLinkedCalendarTarget())) return "paused" as const;
    let providerMutationAttempted = false;
    const reconciler = this.linkedReconciler(() => {
      providerMutationAttempted = true;
    });
    const token = await this.linkedControl.acquireDispatch(
      control.revision,
      record.id,
      {
        connectorAccountId: record.connectorAccountId,
        providerCalendarId: record.providerCalendarId,
      },
    );
    // Once a provider mutation starts, thrown failures retain the receipt for
    // recovery. A failed read before dispatch cannot have changed the provider.
    this.activeLinkedDispatches.add(token);
    try {
      const outcome = strategy
        ? await reconciler.resolveConflict(record, strategy)
        : await reconciler.reconcile(record);
      if (outcome !== "quarantined") {
        await this.linkedControl.settleDispatch(token);
      }
      return outcome;
    } catch (error) {
      // error-policy:J2 Preserve the original failure while releasing only a
      // receipt whose execution never attempted an external mutation.
      if (!providerMutationAttempted)
        await this.linkedControl.settleDispatch(token);
      throw error;
    } finally {
      this.activeLinkedDispatches.delete(token);
    }
  }

  private async enqueueBuiltInCalendarMutation(
    event: LifeOpsCalendarEvent,
    operation: "create" | "update" | "delete",
  ): Promise<void> {
    let link = await this.linkedRepo.getByLocalEvent(this.agentId(), event.id);
    if (!link) {
      if (operation === "delete") return;
      const target = await this.activeLinkedCalendarTarget();
      if (!target) return;
      link = await this.linkedRepo.create({
        agentId: this.agentId(),
        localEventId: event.id,
        connectorAccountId: target.connectorAccountId,
        providerCalendarId: target.providerCalendarId,
        localRevision: Number(event.metadata.version),
      });
    } else if (link.state === "paused" && operation !== "delete") {
      const target = await this.activeLinkedCalendarTarget();
      if (!target || target.connectorAccountId !== link.connectorAccountId) {
        return;
      }
      link = await this.linkedRepo.create({
        agentId: this.agentId(),
        localEventId: event.id,
        connectorAccountId: target.connectorAccountId,
        providerCalendarId: target.providerCalendarId,
        localRevision: Number(event.metadata.version),
      });
    }
    await this.linkedRepo.markLocalDirty({
      agentId: this.agentId(),
      localEventId: event.id,
      localRevision: Number(event.metadata.version),
      operation:
        operation === "delete"
          ? "delete"
          : link.providerEventId
            ? "update"
            : "create",
    });
    this.kickLinkedCalendarDrain();
  }

  private kickLinkedCalendarDrain(): void {
    if (this.linkedCalendarDrain) {
      this.linkedCalendarDrainRequested = true;
      return;
    }
    this.linkedCalendarDrain = (async () => {
      do {
        this.linkedCalendarDrainRequested = false;
        await this.drainLinkedCalendarQueue();
      } while (this.linkedCalendarDrainRequested);
    })()
      .catch((error) => {
        // error-policy:J7 The durable queue remains authoritative after a
        // diagnostic drain failure and will be replayed on the next trigger.
        this.runtime.reportError("calendar:linked-active-sync-drain", error);
      })
      .finally(() => {
        this.linkedCalendarDrain = null;
      });
  }

  private async drainLinkedCalendarQueue(): Promise<void> {
    for (const record of await this.linkedRepo.listActionable(this.agentId())) {
      try {
        await this.runLinkedCalendarOperation(record);
      } catch (error) {
        // error-policy:J7 Durable linked-calendar work remains queued for the
        // next boot or feed refresh; one provider failure must not stop peers.
        this.runtime.reportError("calendar:linked-active-sync", error, {
          linkId: record.id,
          connectorAccountId: record.connectorAccountId,
        });
      }
    }
  }

  private async bootstrapActiveLinkedCalendarSync(): Promise<void> {
    const target = await this.activeLinkedCalendarTarget();
    if (!target) return;
    for (const event of await this.repo.listCalendarEvents(
      this.agentId(),
      ELIZA_CALENDAR_PROVIDER,
      undefined,
      undefined,
      "owner",
      ELIZA_CALENDAR_GRANT_ID,
    )) {
      const existing = await this.linkedRepo.getByLocalEvent(
        this.agentId(),
        event.id,
      );
      if (
        !existing ||
        (existing.state === "paused" &&
          existing.connectorAccountId === target.connectorAccountId)
      ) {
        await this.enqueueBuiltInCalendarMutation(event, "create");
      }
    }
    this.kickLinkedCalendarDrain();
  }

  private requireCurrentLinkedRecord(
    record: LinkedCalendarEventRecord | null,
    expectedUpdatedAt?: string,
  ): LinkedCalendarEventRecord {
    if (!record) {
      throw new CalendarServiceError(
        404,
        "Linked calendar mapping not found.",
        "LINKED_CALENDAR_NOT_FOUND",
      );
    }
    if (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt) {
      throw new CalendarServiceError(
        409,
        "The linked calendar mapping changed; refresh before retrying.",
        "LINKED_CALENDAR_STALE_WRITE",
      );
    }
    return record;
  }

  async listLinkedCalendarEvents(): Promise<LifeOpsLinkedCalendarLink[]> {
    return (await this.linkedRepo.listForAgent(this.agentId())).map((record) =>
      this.publicLinkedCalendar(record),
    );
  }

  async listLinkedCalendarEventViews(): Promise<
    LifeOpsLinkedCalendarEventView[]
  > {
    const links = await this.listLinkedCalendarEvents();
    return Promise.all(
      links.map(async (link) => {
        const event = await this.getCalendarEventById(link.localEventId);
        return {
          ...link,
          event: event
            ? {
                title: event.title,
                startAt: event.startAt,
                endAt: event.endAt,
                isAllDay: event.isAllDay,
              }
            : null,
        };
      }),
    );
  }

  async getLinkedCalendarControl(): Promise<LifeOpsLinkedCalendarControl> {
    const control = await this.linkedControl.read();
    return {
      revision: control.revision,
      paused: control.paused,
      destination: control.destination,
      pendingDispatch: control.dispatch
        ? { linkId: control.dispatch.linkId }
        : null,
    };
  }

  private async verifyLinkedDestination(
    requestUrl: URL,
    destination: NonNullable<LifeOpsLinkedCalendarControl["destination"]>,
  ): Promise<void> {
    const accounts = await this.gate.getGoogleConnectorAccounts(
      requestUrl,
      "owner",
    );
    if (
      !accounts.some(
        (account) =>
          account.connected &&
          account.grant &&
          accountIdForGrant(account.grant) === destination.connectorAccountId &&
          account.grant.capabilities.includes("google.calendar.read") &&
          account.grant.capabilities.includes("google.calendar.write"),
      )
    ) {
      throw new CalendarServiceError(
        409,
        "The selected account needs both calendar read and write permissions.",
        "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
      );
    }
    const calendars = await this.listCalendars(requestUrl, { side: "owner" });
    if (
      !calendars.some(
        (calendar) =>
          calendar.provider === "google" &&
          calendar.side === "owner" &&
          calendar.connectorAccountId === destination.connectorAccountId &&
          calendar.calendarId === destination.providerCalendarId &&
          (calendar.accessRole === "owner" || calendar.accessRole === "writer"),
      )
    ) {
      throw new CalendarServiceError(
        409,
        "The selected calendar is unavailable or is not writable. Refresh the connected calendars and select a writable destination.",
        "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
      );
    }
  }

  async executeLinkedCalendarControl(
    requestUrl: URL,
    request: UpdateLifeOpsLinkedCalendarControlRequest,
  ): Promise<LifeOpsLinkedCalendarControlMutationResult> {
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0
    ) {
      throw new CalendarServiceError(
        400,
        "expectedRevision must be a nonnegative integer.",
      );
    }
    const key =
      typeof request.idempotencyKey === "string"
        ? request.idempotencyKey.trim()
        : "";
    if (!key || key.length > 512)
      throw new CalendarServiceError(
        400,
        "A nonempty operation key of at most 512 characters is required.",
      );
    request = { ...request, idempotencyKey: key };
    const fingerprint = createHash("sha256")
      .update(stableStringify(request))
      .digest("hex");
    const current = await this.linkedControl.read();
    let replay: LinkedCalendarControlMutation | null;
    try {
      replay = await this.linkedControl.findMutation(key, fingerprint);
    } catch (error) {
      // error-policy:J1 Operation-key collisions are owner-review conflicts.
      if (
        error instanceof ElizaError &&
        error.code === "LINKED_CALENDAR_OPERATION_KEY_CONFLICT"
      )
        throw new CalendarServiceError(409, error.message, error.code, {
          cause: error,
        });
      throw error;
    }
    if (replay) {
      if (current.revision !== replay.control.revision)
        throw new CalendarServiceError(
          409,
          "A newer calendar review superseded this operation. Refresh sync status.",
          "LINKED_CALENDAR_OPERATION_SUPERSEDED",
        );
      if (request.operation === "resume")
        await this.bootstrapActiveLinkedCalendarSync();
      return this.publicLinkedControlMutation(replay);
    }
    let committed: LinkedCalendarControlMutation;
    if (current.revision !== request.expectedRevision) {
      throw new CalendarServiceError(
        409,
        "Calendar sync changed; refresh its review.",
        "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
      );
    }
    try {
      switch (request.operation) {
        case "pause":
          committed = await this.linkedControl.commitMutation(
            request,
            fingerprint,
          );
          break;
        case "select": {
          if (request.destination === undefined) {
            throw new CalendarServiceError(
              400,
              "A destination or explicit null is required.",
            );
          }
          const destination =
            request.destination === null
              ? null
              : {
                  connectorAccountId: requireNonEmptyString(
                    request.destination.connectorAccountId,
                    "connectorAccountId",
                  ),
                  providerCalendarId: requireNonEmptyString(
                    request.destination.providerCalendarId,
                    "providerCalendarId",
                  ),
                };
          if (destination)
            await this.verifyLinkedDestination(requestUrl, destination);
          committed = await this.linkedControl.commitMutation(
            { ...request, destination },
            fingerprint,
          );
          break;
        }
        case "resume": {
          if (!current.destination) {
            throw new CalendarServiceError(
              409,
              "Select and verify a destination before resuming calendar sync.",
            );
          }
          await this.verifyLinkedDestination(requestUrl, current.destination);
          const mismatched = (
            await this.linkedRepo.listForAgent(this.agentId())
          ).some(
            (link) =>
              link.state !== "paused" &&
              link.state !== "local_only" &&
              (link.connectorAccountId !==
                current.destination?.connectorAccountId ||
                link.providerCalendarId !==
                  current.destination?.providerCalendarId),
          );
          if (mismatched) {
            throw new CalendarServiceError(
              409,
              "Review existing calendar mappings before resuming with a different destination.",
              "LINKED_CALENDAR_MAPPING_REVIEW_REQUIRED",
            );
          }
          committed = await this.linkedControl.commitMutation(
            request,
            fingerprint,
          );
          await this.bootstrapActiveLinkedCalendarSync();
          break;
        }
        case "recover": {
          if (!current.paused || !current.dispatch || !current.destination) {
            throw new CalendarServiceError(
              409,
              "Pause sync and refresh the pending operation before recovery.",
              "LINKED_CALENDAR_RECOVERY_NOT_READY",
            );
          }
          if (this.activeLinkedDispatches.has(current.dispatch.token)) {
            throw new CalendarServiceError(
              409,
              "The calendar operation is still running. Wait for it to finish before recovery.",
              "LINKED_CALENDAR_DISPATCH_ACTIVE",
            );
          }
          await this.verifyLinkedDestination(requestUrl, current.destination);
          const record = await this.linkedRepo.getById(
            this.agentId(),
            current.dispatch.linkId,
          );
          if (
            !record ||
            record.connectorAccountId !==
              current.destination.connectorAccountId ||
            record.providerCalendarId !== current.destination.providerCalendarId
          ) {
            throw new CalendarServiceError(
              409,
              "The pending operation does not match the reviewed destination.",
              "LINKED_CALENDAR_RECOVERY_IDENTITY_MISMATCH",
            );
          }
          if (!(await this.linkedReconciler().recoverDispatch(record))) {
            throw new CalendarServiceError(
              409,
              "The provider outcome is still uncertain or the events differ. Sync remains paused; no provider write was retried.",
              "LINKED_CALENDAR_RECOVERY_UNRESOLVED",
            );
          }
          committed = await this.linkedControl.commitMutation(
            request,
            fingerprint,
            current.dispatch.token,
          );
          break;
        }
        default:
          throw new CalendarServiceError(
            400,
            "operation must be pause, select, resume, or recover.",
          );
      }
    } catch (error) {
      // error-policy:J1 Translate a concurrent control transition to a refreshable HTTP conflict.
      if (
        error instanceof ElizaError &&
        (error.code === "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED" ||
          error.code === "LINKED_CALENDAR_OPERATION_KEY_CONFLICT")
      ) {
        throw new CalendarServiceError(409, error.message, error.code, {
          cause: error,
        });
      }
      throw error;
    }
    return this.publicLinkedControlMutation(committed);
  }

  private publicLinkedControlMutation(
    mutation: LinkedCalendarControlMutation,
  ): LifeOpsLinkedCalendarControlMutationResult {
    return {
      revision: mutation.control.revision,
      paused: mutation.control.paused,
      destination: mutation.control.destination,
      pendingDispatch: mutation.control.dispatch
        ? { linkId: mutation.control.dispatch.linkId }
        : null,
      receipt: mutation.receipt,
    };
  }

  async getLinkedCalendarEvent(
    linkId: string,
  ): Promise<LifeOpsLinkedCalendarLink> {
    return this.publicLinkedCalendar(
      this.requireCurrentLinkedRecord(
        await this.linkedRepo.getById(this.agentId(), linkId),
      ),
    );
  }

  async executeLinkedCalendarLink(
    request: CreateLifeOpsLinkedCalendarLinkRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse> {
    if (
      !Number.isSafeInteger(request.expectedLocalRevision) ||
      request.expectedLocalRevision < 1
    ) {
      throw new CalendarServiceError(
        400,
        "expectedLocalRevision must be a positive integer.",
        "LINKED_CALENDAR_LOCAL_REVISION_INVALID",
      );
    }
    const local = await this.linkedLocalPort().get(request.localEventId);
    if (!local) {
      throw new CalendarServiceError(
        404,
        "The built-in Eliza calendar event was not found.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    if (local.revision !== request.expectedLocalRevision) {
      throw new CalendarServiceError(
        409,
        "The Eliza event changed before it could be linked.",
        "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
      );
    }
    const created = await this.linkedRepo.create({
      agentId: this.agentId(),
      localEventId: local.eventId,
      connectorAccountId: requireNonEmptyString(
        request.connectorAccountId,
        "connectorAccountId",
      ),
      providerCalendarId: requireNonEmptyString(
        request.providerCalendarId,
        "providerCalendarId",
      ),
      localRevision: local.revision,
    });
    const outcome = await this.runLinkedCalendarOperation(created);
    const current = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), created.id),
    );
    return { link: this.publicLinkedCalendar(current), outcome };
  }

  async executeLinkedCalendarReconciliation(
    linkId: string,
    request: RunLifeOpsLinkedCalendarReconciliationRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse> {
    const record = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), linkId),
      requireNonEmptyString(request.expectedUpdatedAt, "expectedUpdatedAt"),
    );
    const outcome = await this.runLinkedCalendarOperation(record);
    const current = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), linkId),
    );
    return { link: this.publicLinkedCalendar(current), outcome };
  }

  async executeLinkedCalendarConflictResolution(
    linkId: string,
    request: ResolveLifeOpsLinkedCalendarConflictRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse> {
    if (
      request.strategy !== "keep_eliza" &&
      request.strategy !== "keep_google"
    ) {
      throw new CalendarServiceError(
        400,
        "strategy must be keep_eliza or keep_google.",
        "LINKED_CALENDAR_CONFLICT_STRATEGY_INVALID",
      );
    }
    const record = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), linkId),
      requireNonEmptyString(request.expectedUpdatedAt, "expectedUpdatedAt"),
    );
    const outcome = await this.runLinkedCalendarOperation(
      record,
      request.strategy,
    );
    const current = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), linkId),
    );
    return { link: this.publicLinkedCalendar(current), outcome };
  }

  async executeLinkedCalendarRebind(
    requestUrl: URL,
    linkId: string,
    request: RebindLifeOpsLinkedCalendarRequest,
  ): Promise<RebindLifeOpsLinkedCalendarResponse> {
    if (request.retainPreviousProviderEvent !== true)
      throw new CalendarServiceError(
        400,
        "Confirm that the previous provider event will be retained",
        "LINKED_CALENDAR_RETENTION_REQUIRED",
      );
    const id = requireNonEmptyString(linkId, "linkId");
    const operationKey = requireNonEmptyString(
      request.idempotencyKey,
      "idempotencyKey",
    );
    const destination = {
      connectorAccountId: requireNonEmptyString(
        request.connectorAccountId,
        "connectorAccountId",
      ),
      providerCalendarId: requireNonEmptyString(
        request.providerCalendarId,
        "providerCalendarId",
      ),
    };
    this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), id),
    );
    await this.verifyLinkedDestination(requestUrl, destination);
    try {
      const result = await this.linkedRepo.rebindWhilePaused({
        linkId: id,
        expectedUpdatedAt: requireNonEmptyString(
          request.expectedUpdatedAt,
          "expectedUpdatedAt",
        ),
        expectedLocalRevision: request.expectedLocalRevision,
        expectedControlRevision: request.expectedControlRevision,
        ...destination,
        operationKey,
      });
      return {
        previous: this.publicLinkedCalendar(result.previous),
        link: this.publicLinkedCalendar(result.link),
        controlRevision: result.controlRevision,
        receipt: { operationKey, replayed: result.replayed },
        providerMutation: "none",
      };
    } catch (error) {
      // error-policy:J1 A stale or unsafe mapping review is an owner-visible conflict.
      if (
        error instanceof ElizaError &&
        error.code === "LINKED_CALENDAR_REBIND_CONFLICT"
      )
        throw new CalendarServiceError(409, error.message, error.code, {
          cause: error,
        });
      throw error;
    }
  }

  async executeLinkedCalendarRetainLocal(
    linkId: string,
    request: Omit<
      RebindLifeOpsLinkedCalendarRequest,
      "connectorAccountId" | "providerCalendarId"
    >,
  ): Promise<RebindLifeOpsLinkedCalendarResponse> {
    if (request.retainPreviousProviderEvent !== true)
      throw new CalendarServiceError(
        400,
        "Confirm that the previous provider event will be retained",
        "LINKED_CALENDAR_RETENTION_REQUIRED",
      );
    try {
      const operationKey = requireNonEmptyString(
        request.idempotencyKey,
        "idempotencyKey",
      );
      const result = await this.linkedRepo.retainLocalWhilePaused({
        linkId: requireNonEmptyString(linkId, "linkId"),
        expectedUpdatedAt: requireNonEmptyString(
          request.expectedUpdatedAt,
          "expectedUpdatedAt",
        ),
        expectedLocalRevision: request.expectedLocalRevision,
        expectedControlRevision: request.expectedControlRevision,
        operationKey,
      });
      return {
        previous: this.publicLinkedCalendar(result.previous),
        link: this.publicLinkedCalendar(result.link),
        controlRevision: result.controlRevision,
        receipt: { operationKey, replayed: result.replayed },
        providerMutation: "none",
      };
    } catch (error) {
      // error-policy:J1 Stale or unsafe retention reviews are owner-visible conflicts.
      if (
        error instanceof ElizaError &&
        error.code === "LINKED_CALENDAR_REBIND_CONFLICT"
      )
        throw new CalendarServiceError(409, error.message, error.code, {
          cause: error,
        });
      throw error;
    }
  }

  async executeLinkedCalendarDisconnect(
    linkId: string,
    request: DisconnectLifeOpsLinkedCalendarRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse> {
    if (request.retainEvents !== true) {
      throw new CalendarServiceError(
        400,
        "Disconnect requires retaining both independent calendar events.",
        "LINKED_CALENDAR_RETENTION_REQUIRED",
      );
    }
    const record = this.requireCurrentLinkedRecord(
      await this.linkedRepo.getById(this.agentId(), linkId),
      requireNonEmptyString(request.expectedUpdatedAt, "expectedUpdatedAt"),
    );
    const paused = await this.linkedRepo.pause(record);
    return {
      link: this.publicLinkedCalendar(paused),
      outcome: "disconnected",
    };
  }

  async executeLinkedCalendarProviderChanges(
    providerEventIds: readonly string[],
  ): Promise<void> {
    const changed = new Set(providerEventIds);
    const records = (await this.linkedRepo.listForAgent(this.agentId())).filter(
      (record) =>
        record.providerEventId !== null && changed.has(record.providerEventId),
    );
    for (const record of records) {
      await this.runLinkedCalendarOperation(record);
    }
  }

  private async reconcileLinkedGoogleChanges(
    _requestUrl: URL,
    providerEventIds: readonly string[],
  ): Promise<void> {
    if (providerEventIds.length === 0) return;
    await this.executeLinkedCalendarProviderChanges(providerEventIds);
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<CalendarService> {
    const service = new CalendarService(runtime);
    // Anchor registrations for meeting auto-join are in-memory; restore them
    // for upcoming events so persisted join tasks resolve after a restart.
    // Best-effort: the schema may not be migrated yet on first boot.
    void service.restoreMeetingAutoJoinAnchorsOnBoot();
    void service.installGoogleWatchMaintenanceOnBoot();
    void service.drainIcsSecretCleanupOnBoot();
    void service.installAppleCalendarChangeObserver();
    void service.bootstrapActiveLinkedCalendarSync().catch((error) => {
      // error-policy:J5 Startup observes the detached bootstrap rejection here.
      runtime.reportError("calendar:linked-active-sync-bootstrap", error);
    });
    return service;
  }

  override async stop(): Promise<void> {
    try {
      await this.appleCalendarChangeListener?.remove();
    } catch (error) {
      // error-policy:J6 Listener teardown is best-effort during service stop.
      logger.warn(
        { src: "calendar:apple-change-observer", error },
        "[CalendarService] Apple Calendar change observer teardown failed.",
      );
    }
    this.appleCalendarChangeListener = null;
  }

  private async installAppleCalendarChangeObserver(): Promise<void> {
    try {
      this.appleCalendarChangeListener =
        await subscribeNativeAppleCalendarChanges(() => {
          void this.invalidateAppleCalendarCache();
        });
    } catch (error) {
      // error-policy:J5 Service.start launches native observation in the
      // background; this handler observes and reports its rejection.
      this.runtime.reportError("calendar:apple-change-observer", error);
    }
  }

  private async invalidateAppleCalendarCache(): Promise<void> {
    try {
      await this.repo.deleteCalendarSyncState(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        undefined,
        "owner",
        APPLE_CALENDAR_GRANT_ID,
      );
    } catch (error) {
      // error-policy:J7 Cache invalidation failure is diagnostic and must not
      // terminate EventKit's change-notification delivery loop.
      this.runtime.reportError("calendar:apple-change-invalidation", error);
    }
  }

  private async installGoogleWatchMaintenanceOnBoot(): Promise<void> {
    try {
      await waitForScheduledTaskRunnerService(this.runtime);
      await this.googleWatch.installMaintenanceTask();
    } catch (error) {
      // error-policy:J5 Service.start launches maintenance installation in the
      // background; this handler is where its rejection is observed.
      this.runtime.reportError("calendar:google-watch-install", error);
      logger.warn(
        { src: "calendar:google-watch", error },
        "[CalendarService] Google Calendar watch maintenance was not installed.",
      );
    }
  }

  private async drainIcsSecretCleanupOnBoot(): Promise<void> {
    try {
      await this.runtime.initPromise;
      await this.drainIcsSecretCleanupAtBoundary("boot");
    } catch (error) {
      // error-policy:J5 Service.start launches the durable cleanup worker in
      // the background; this handler observes initialization rejection.
      this.runtime.reportError("calendar:ics-secret-cleanup-boot", error);
    }
  }

  private async restoreMeetingAutoJoinAnchorsOnBoot(): Promise<void> {
    try {
      const nowIso = new Date().toISOString();
      const horizonIso = new Date(
        Date.now() + 14 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const events = [
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          APPLE_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          MICROSOFT_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
        ...(await this.repo.listCalendarEvents(
          this.agentId(),
          ELIZA_CALENDAR_PROVIDER,
          nowIso,
          horizonIso,
        )),
      ];
      await restoreMeetingAutoJoinAnchors(this.runtime, this.agentId(), events);
    } catch (error) {
      // error-policy:J5 Service.start intentionally launches this restoration
      // in the background; this handler is where its rejection is observed.
      this.runtime.reportError("calendar:restore-auto-join", error);
      logger.warn(
        { src: "calendar:service", error },
        "[CalendarService] Meeting auto-join anchor restore skipped (calendar store not ready yet).",
      );
    }
  }

  async getMeetingAutoJoin(): Promise<MeetingAutoJoinSettings> {
    return readMeetingAutoJoinSettings(this.runtime);
  }

  async setMeetingAutoJoin(policy: unknown): Promise<MeetingAutoJoinSettings> {
    if (!isMeetingAutoJoinPolicy(policy)) {
      throw new CalendarServiceError(
        400,
        'policy must be one of "off", "ask", "all"',
      );
    }
    const settings = await writeMeetingAutoJoinPolicy(this.runtime, policy);
    if (policy === "off") {
      await cancelAllMeetingAutoJoinTasks(this.runtime, this.agentId());
    } else {
      // Re-reconcile upcoming events under the new policy so tasks flip
      // between direct-join and approval-gated without waiting for a sync.
      await this.reconcileUpcomingMeetingAutoJoin();
    }
    return settings;
  }

  private async reconcileUpcomingMeetingAutoJoin(): Promise<void> {
    const nowIso = new Date().toISOString();
    const horizonIso = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const events = [
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        ELIZA_CALENDAR_PROVIDER,
        nowIso,
        horizonIso,
      )),
    ];
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events,
    });
  }

  /** LifeOps injects its connector + reminder + audit implementation here. */
  setGate(gate: CalendarHostGate): void {
    this.gate = gate;
    void this.bootstrapActiveLinkedCalendarSync().catch((error) => {
      // error-policy:J5 Gate installation observes the detached durable-sync
      // bootstrap; queued rows remain authoritative for the next trigger.
      this.runtime.reportError("calendar:linked-active-sync-gate", error);
    });
  }

  /** Host/test seam for the calendar-owned Microsoft provider implementation. */
  setMicrosoftCalendarPort(port: MicrosoftGraphCalendarPort): void {
    this.microsoftPort = port;
  }

  /**
   * Resolve guest calendars through exact host-authorized bindings. Planner
   * strings never select a provider account or calendar: LifeOps resolves each
   * opaque grant id, and this service queries only the bound account. Every
   * returned source remains anonymous and contains intervals only.
   */
  async getCalendarFreeBusy(
    requestUrl: URL,
    request: {
      principalEntityId: string;
      guestAvailabilityGrantIds: readonly string[];
      timeMin: string;
      timeMax: string;
      timeZone?: string;
    },
  ): Promise<{ sources: CalendarAvailabilitySource[] }> {
    const principalEntityId = request.principalEntityId.trim();
    if (!principalEntityId) {
      throw new CalendarServiceError(
        400,
        "Guest free/busy requires an authenticated principal.",
        "CALENDAR_FREE_BUSY_PRINCIPAL_REQUIRED",
      );
    }
    const requestedGrantIds = [
      ...new Set(
        request.guestAvailabilityGrantIds
          .map((grantId) => grantId.trim())
          .filter(Boolean),
      ),
    ];
    if (requestedGrantIds.length === 0) {
      throw new CalendarServiceError(
        400,
        "At least one guest availability grant is required.",
        "CALENDAR_FREE_BUSY_GRANTS_REQUIRED",
      );
    }
    const start = Date.parse(request.timeMin);
    const end = Date.parse(request.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new CalendarServiceError(
        400,
        "Guest free/busy requires a valid, increasing time window.",
        "CALENDAR_FREE_BUSY_INVALID_RANGE",
      );
    }

    const authorizationAt = new Date().toISOString();
    const resolvedGrants = await this.gate.resolveGuestAvailabilityGrants({
      principalEntityId,
      grantIds: requestedGrantIds,
      purpose: CALENDAR_GUEST_AVAILABILITY_PURPOSE,
      at: authorizationAt,
    });
    const resolvedById = new Map<string, CalendarGuestAvailabilityGrant>();
    for (const grant of resolvedGrants) {
      if (
        resolvedById.has(grant.grantId) ||
        !requestedGrantIds.includes(grant.grantId) ||
        grant.principalEntityId !== principalEntityId ||
        (grant.provider !== "google" && grant.provider !== "microsoft") ||
        grant.purpose !== CALENDAR_GUEST_AVAILABILITY_PURPOSE ||
        grant.side !== "owner" ||
        !grant.guestEntityId.trim() ||
        !grant.connectorAccountId.trim() ||
        !grant.providerGrantId.trim() ||
        !grant.calendarId.trim() ||
        !Number.isFinite(Date.parse(grant.consentRecordedAt)) ||
        Date.parse(grant.consentRecordedAt) > Date.parse(authorizationAt) ||
        !Number.isFinite(Date.parse(grant.expiresAt)) ||
        Date.parse(grant.expiresAt) <= Date.parse(authorizationAt)
      ) {
        throw new CalendarServiceError(
          403,
          "Guest free/busy authorization is invalid.",
          "CALENDAR_FREE_BUSY_GRANT_INVALID",
        );
      }
      resolvedById.set(grant.grantId, grant);
    }
    if (
      resolvedById.size !== requestedGrantIds.length ||
      requestedGrantIds.some((grantId) => !resolvedById.has(grantId))
    ) {
      throw new CalendarServiceError(
        403,
        "Guest free/busy authorization is incomplete.",
        "CALENDAR_FREE_BUSY_GRANT_MISSING",
      );
    }
    const grants = requestedGrantIds.map((grantId) => {
      const grant = resolvedById.get(grantId);
      if (!grant) {
        throw new CalendarServiceError(
          403,
          "Guest free/busy authorization is incomplete.",
          "CALENDAR_FREE_BUSY_GRANT_MISSING",
        );
      }
      return grant;
    });

    const resolved = new Map<string, CalendarAvailabilitySource>();
    const sourceFor = (
      grant: CalendarGuestAvailabilityGrant,
      events: CalendarAvailabilitySource["events"],
    ): CalendarAvailabilitySource => {
      const sourceIndex = requestedGrantIds.indexOf(grant.grantId) + 1;
      return {
        id: `guest-freebusy-${sourceIndex}`,
        status: "fresh",
        visibility: "busy_only",
        events,
      };
    };
    const unavailableSourceFor = (
      grant: CalendarGuestAvailabilityGrant,
      status: "disconnected" | "error",
    ): CalendarAvailabilitySource => {
      const sourceIndex = requestedGrantIds.indexOf(grant.grantId) + 1;
      return {
        id: `guest-freebusy-${sourceIndex}`,
        status,
        visibility: "busy_only",
        events: [],
        error:
          status === "disconnected"
            ? "Guest free/busy provider is not connected."
            : "Guest availability source is unavailable.",
      };
    };
    const groupByTarget = (
      provider: CalendarGuestAvailabilityGrant["provider"],
    ): CalendarGuestAvailabilityGrant[][] => {
      const groups = new Map<string, CalendarGuestAvailabilityGrant[]>();
      for (const grant of grants.filter(
        (candidate) => candidate.provider === provider,
      )) {
        const key = `${grant.providerGrantId}\u0000${grant.connectorAccountId}`;
        const group = groups.get(key) ?? [];
        group.push(grant);
        groups.set(key, group);
      }
      return [...groups.values()];
    };

    for (const group of groupByTarget("google")) {
      const first = group[0];
      if (!first) continue;
      let connectorGrant: LifeOpsConnectorGrant;
      try {
        connectorGrant = await this.gate.requireGoogleCalendarGrant(
          requestUrl,
          "local",
          "owner",
          first.providerGrantId,
        );
      } catch (error) {
        // error-policy:J4 an unavailable exact connector binding becomes an
        // anonymous incomplete source; no alternate account is attempted.
        this.runtime.reportError(
          "calendar:guest-free-busy-google-binding",
          new ElizaError("A bound Google Calendar account is unavailable.", {
            code: "CALENDAR_FREE_BUSY_BOUND_ACCOUNT_UNAVAILABLE",
            context: { affectedGrantCount: group.length },
            cause: error,
            severity: "ephemeral",
          }),
        );
        for (const grant of group) {
          resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
        }
        continue;
      }
      if (
        connectorGrant.id !== first.providerGrantId ||
        accountIdForGrant(connectorGrant) !== first.connectorAccountId ||
        connectorGrant.side !== "owner" ||
        !connectorGrant.capabilities.includes("google.calendar.read")
      ) {
        for (const grant of group) {
          resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
        }
        this.runtime.reportError(
          "calendar:guest-free-busy-google-binding",
          new ElizaError(
            "A bound Google Calendar account did not match its authorization.",
            {
              code: "CALENDAR_FREE_BUSY_BOUND_ACCOUNT_MISMATCH",
              context: { affectedGrantCount: group.length },
              severity: "fatal",
            },
          ),
        );
        continue;
      }
      try {
        const queryFreeBusy = requireGoogleServiceMethod(
          this.runtime,
          "queryFreeBusy",
        );
        const calendarIds = [
          ...new Set(group.map((grant) => grant.calendarId)),
        ];
        const result = await queryFreeBusy({
          accountId: first.connectorAccountId,
          calendarIds,
          timeMin: request.timeMin,
          timeMax: request.timeMax,
          ...(request.timeZone ? { timeZone: request.timeZone } : {}),
        });
        for (const grant of group) {
          const availability = result.calendars[grant.calendarId];
          if (!availability || availability.errors.length > 0) {
            resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
            continue;
          }
          const sourceIndex = requestedGrantIds.indexOf(grant.grantId) + 1;
          resolved.set(
            grant.grantId,
            sourceFor(
              grant,
              availability.busy.map((interval, intervalIndex) => ({
                id: `guest-freebusy-${sourceIndex}-interval-${intervalIndex + 1}`,
                startISO: interval.start,
                endISO: interval.end,
                status: "busy",
                kind: "guest_busy",
              })),
            ),
          );
        }
      } catch (error) {
        // error-policy:J4 bound-provider failure remains explicit unknown
        // availability and never triggers a query through another account.
        this.runtime.reportError(
          "calendar:guest-free-busy-google-account",
          new ElizaError("A Google Calendar free/busy query failed.", {
            code: "CALENDAR_FREE_BUSY_ACCOUNT_QUERY_FAILED",
            context: { affectedGrantCount: group.length },
            cause: error,
            severity: "ephemeral",
          }),
        );
        for (const grant of group) {
          resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
        }
      }
    }

    for (const group of groupByTarget("microsoft")) {
      const first = group[0];
      if (!first) continue;
      let exactAccount: MicrosoftCalendarAccount | undefined;
      try {
        const candidates = await this.microsoftPort.listAccounts({
          side: "owner",
          grantId: first.providerGrantId,
        });
        exactAccount = candidates.find(
          (candidate) =>
            candidate.grant.id === first.providerGrantId &&
            candidate.account.id === first.connectorAccountId &&
            candidate.grant.side === "owner" &&
            candidate.grant.capabilities.includes(
              "microsoft.calendar.freebusy",
            ),
        );
      } catch (error) {
        // error-policy:J4 account lookup is constrained by the host-resolved
        // grant id; failure never widens discovery to other owner accounts.
        this.runtime.reportError(
          "calendar:guest-free-busy-microsoft-binding",
          new ElizaError("A bound Microsoft Calendar account is unavailable.", {
            code: "CALENDAR_FREE_BUSY_BOUND_ACCOUNT_UNAVAILABLE",
            context: { affectedGrantCount: group.length },
            cause: error,
            severity: "ephemeral",
          }),
        );
      }
      if (!exactAccount) {
        for (const grant of group) {
          resolved.set(
            grant.grantId,
            unavailableSourceFor(grant, "disconnected"),
          );
        }
        continue;
      }
      try {
        const calendarIds = [
          ...new Set(group.map((grant) => grant.calendarId)),
        ];
        const schedules = await this.microsoftPort.getSchedule({
          account: exactAccount,
          schedules: calendarIds,
          timeMin: request.timeMin,
          timeMax: request.timeMax,
          ...(request.timeZone ? { timeZone: request.timeZone } : {}),
        });
        const schedulesById = new Map(
          schedules.map((schedule) => [schedule.scheduleId, schedule]),
        );
        for (const grant of group) {
          const availability = schedulesById.get(grant.calendarId);
          if (!availability || availability.error) {
            resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
            continue;
          }
          const sourceIndex = requestedGrantIds.indexOf(grant.grantId) + 1;
          resolved.set(
            grant.grantId,
            sourceFor(
              grant,
              availability.intervals.map((interval, intervalIndex) => ({
                id: `guest-freebusy-${sourceIndex}-interval-${intervalIndex + 1}`,
                startISO: interval.startAt,
                endISO: interval.endAt,
                status: interval.status,
                kind: "guest_busy",
              })),
            ),
          );
        }
      } catch (error) {
        // error-policy:J4 organization limits, throttling, and permission
        // failures remain anonymous unknown availability for the exact target.
        this.runtime.reportError(
          "calendar:guest-free-busy-microsoft-account",
          new ElizaError("A Microsoft Calendar free/busy query failed.", {
            code: "CALENDAR_FREE_BUSY_ACCOUNT_QUERY_FAILED",
            context: { affectedGrantCount: group.length },
            cause: error,
            severity: "ephemeral",
          }),
        );
        for (const grant of group) {
          resolved.set(grant.grantId, unavailableSourceFor(grant, "error"));
        }
      }
    }

    return {
      sources: grants.map(
        (grant): CalendarAvailabilitySource =>
          resolved.get(grant.grantId) ?? unavailableSourceFor(grant, "error"),
      ),
    };
  }

  private agentId(): string {
    return this.runtime.agentId;
  }

  private requireIcsSecretsService(): CalendarSecretsService {
    const service = this.runtime.getService(SECRETS_SERVICE_TYPE);
    if (!isCalendarSecretsService(service)) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secrets are unavailable.",
        "ICS_SECRETS_UNAVAILABLE",
      );
    }
    return service;
  }

  private async storeIcsSourceSecret(
    service: CalendarSecretsService,
    secretRef: string,
    value: string,
  ): Promise<void> {
    try {
      if (await service.setGlobal(secretRef, value)) return;
    } catch {
      // error-policy:J1 Secret backend details are intentionally replaced at
      // the calendar boundary so they cannot reveal a subscription URL.
    }
    throw new CalendarServiceError(
      503,
      "Calendar subscription secret could not be stored.",
      "ICS_SECRET_WRITE_FAILED",
    );
  }

  private async resolveIcsSourceSecret(
    service: CalendarSecretsService,
    source: IcsCalendarSourceRecord,
  ): Promise<string> {
    let value: string | null;
    try {
      value = await service.getGlobal(source.secretRef);
    } catch {
      // error-policy:J1 Backend errors are translated without their cause
      // because a secrets implementation may include the credential in it.
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret could not be resolved.",
        "ICS_SECRET_RESOLUTION_FAILED",
      );
    }
    if (!value) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret is missing.",
        "ICS_SECRET_MISSING",
      );
    }
    if (isSerializedSecretHandle(value)) {
      throw new CalendarServiceError(
        503,
        "Calendar subscription secret requires an unsupported broker resolution path.",
        "ICS_SECRET_HANDLE_UNRESOLVED",
      );
    }
    return value;
  }

  private async deleteUncommittedIcsSourceSecretBestEffort(
    service: CalendarSecretsService,
    sourceId: string,
    secretRef: string,
  ): Promise<void> {
    try {
      await service.delete(secretRef, {
        level: "global",
        agentId: this.agentId(),
        requesterId: this.agentId(),
      });
    } catch {
      // error-policy:J6 A staged secret has not entered durable source state;
      // teardown failure is observable without exposing its capability value.
      this.runtime.reportError(
        "calendar:ics-secret-teardown",
        new ElizaError("Calendar source secret cleanup failed.", {
          code: "ICS_SECRET_DELETE_FAILED",
          context: { sourceId },
          severity: "ephemeral",
        }),
      );
    }
  }

  private async performIcsSecretCleanupDrain(): Promise<void> {
    const pending = await this.repo.listIcsSecretCleanup(this.agentId());
    if (pending.length === 0) return;
    const service = this.requireIcsSecretsService();
    for (const cleanup of pending) {
      try {
        await service.delete(cleanup.secretRef, {
          level: "global",
          agentId: this.agentId(),
          requesterId: this.agentId(),
        });
        await this.repo.acknowledgeIcsSecretCleanup(this.agentId(), cleanup.id);
      } catch {
        // error-policy:J1 The durable worker records a retryable failure
        // without acknowledging the outbox row or retaining secret material in
        // diagnostics.
        const attemptedAt = new Date().toISOString();
        try {
          await this.repo.recordIcsSecretCleanupFailure({
            agentId: this.agentId(),
            cleanupId: cleanup.id,
            attemptedAt,
            errorCode: "ICS_SECRET_DELETE_FAILED",
          });
        } catch (persistenceError) {
          throw new ElizaError(
            "Calendar secret cleanup failure could not be recorded.",
            {
              code: "ICS_SECRET_CLEANUP_PERSIST_FAILED",
              context: {
                cleanupId: cleanup.id,
                sourceId: cleanup.sourceId,
                reason: cleanup.reason,
              },
              cause: persistenceError,
              severity: "fatal",
            },
          );
        }
        this.runtime.reportError(
          "calendar:ics-secret-cleanup",
          new ElizaError("Calendar source secret cleanup will be retried.", {
            code: "ICS_SECRET_DELETE_FAILED",
            context: {
              cleanupId: cleanup.id,
              sourceId: cleanup.sourceId,
              reason: cleanup.reason,
              attemptCount: cleanup.attemptCount + 1,
            },
            severity: "ephemeral",
          }),
        );
      }
    }
  }

  private async drainIcsSecretCleanup(): Promise<void> {
    if (this.icsSecretCleanupDrain) {
      await this.icsSecretCleanupDrain;
      return;
    }
    const drain = this.performIcsSecretCleanupDrain();
    this.icsSecretCleanupDrain = drain;
    try {
      await drain;
    } finally {
      if (this.icsSecretCleanupDrain === drain) {
        this.icsSecretCleanupDrain = null;
      }
    }
  }

  private async drainIcsSecretCleanupAtBoundary(
    operation: string,
  ): Promise<void> {
    try {
      await this.drainIcsSecretCleanup();
    } catch (error) {
      // error-policy:J1 Cleanup is an independent durable effect; its boundary
      // reports an unavailable worker while preserving every unacknowledged
      // row for a later boot or ICS operation.
      this.runtime.reportError("calendar:ics-secret-cleanup-worker", error, {
        operation,
      });
    }
  }

  async listIcsCalendarSources(): Promise<LifeOpsIcsCalendarSource[]> {
    await this.drainIcsSecretCleanupAtBoundary("list");
    const sources = await this.repo.listIcsCalendarSources(this.agentId());
    return sources.map(publicIcsCalendarSource);
  }

  async createIcsCalendarSource(
    request: CreateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSource> {
    await this.drainIcsSecretCleanupAtBoundary("create");
    const name = requireNonEmptyString(request.name, "name");
    const sourceUrl = normalizeIcsSubscriptionUrl(
      requireNonEmptyString(request.url, "url"),
    );
    const enabled =
      normalizeOptionalBoolean(request.enabled, "enabled") ?? true;
    const sourceId = crypto.randomUUID();
    const secretRef = `CALENDAR_ICS_SOURCE_${sourceId
      .replaceAll("-", "")
      .toUpperCase()}_URL`;
    const secrets = this.requireIcsSecretsService();
    await this.storeIcsSourceSecret(secrets, secretRef, sourceUrl.href);
    const now = new Date().toISOString();
    try {
      const created = await this.repo.createIcsCalendarSource({
        id: sourceId,
        agentId: this.agentId(),
        provider: "ics",
        side: "owner",
        name,
        enabled,
        secretRef,
        urlFingerprint: fingerprintIcsSourceUrl(sourceUrl),
        origin: sourceUrl.origin,
        etag: null,
        lastModified: null,
        contentHash: null,
        syncStatus: "never",
        error: null,
        lastSyncedAt: null,
        lastAttemptedAt: null,
        syncGeneration: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return publicIcsCalendarSource(created);
    } catch (error) {
      // error-policy:J1 The CRUD boundary compensates the secret write and
      // translates the expected duplicate-source constraint.
      await this.deleteUncommittedIcsSourceSecretBestEffort(
        secrets,
        sourceId,
        secretRef,
      );
      if (
        error instanceof Error &&
        /calendar_sources_agent_fingerprint_unique/i.test(error.message)
      ) {
        throw new CalendarServiceError(
          409,
          "This calendar subscription is already configured.",
          "ICS_SOURCE_ALREADY_EXISTS",
        );
      }
      throw error;
    }
  }

  async updateIcsCalendarSource(
    sourceId: string,
    request: UpdateLifeOpsIcsCalendarSourceRequest,
  ): Promise<LifeOpsIcsCalendarSource> {
    await this.drainIcsSecretCleanupAtBoundary("update");
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const existing = await this.repo.getIcsCalendarSource(
      this.agentId(),
      normalizedSourceId,
    );
    if (!existing) {
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    const name =
      request.name === undefined
        ? existing.name
        : requireNonEmptyString(request.name, "name");
    const enabled =
      request.enabled === undefined
        ? undefined
        : normalizeOptionalBoolean(request.enabled, "enabled");
    if (request.enabled !== undefined && enabled === undefined) {
      throw new CalendarServiceError(400, "enabled must be a boolean");
    }
    if (
      enabled !== undefined &&
      (request.name !== undefined || request.url !== undefined)
    ) {
      throw new CalendarServiceError(
        400,
        "Update enabled separately from source metadata so the selection change can commit atomically.",
        "CALENDAR_SOURCE_SELECTION_COMBINATION_INVALID",
      );
    }
    if (
      request.enabled === undefined &&
      request.expectedSelectionVersion !== undefined
    ) {
      throw new CalendarServiceError(
        400,
        "expectedSelectionVersion is only valid when changing enabled.",
        "CALENDAR_SOURCE_VERSION_INVALID",
      );
    }
    if (enabled !== undefined) {
      const expectedVersion = request.expectedSelectionVersion;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw new CalendarServiceError(
          400,
          "expectedSelectionVersion must be a non-negative safe integer when changing enabled.",
          "CALENDAR_SOURCE_VERSION_INVALID",
        );
      }
      try {
        await setCalendarFeedIncluded(
          this.runtime,
          {
            provider: "ics",
            side: existing.side,
            grantId: existing.id,
            connectorAccountId: existing.id,
            calendarId: existing.id,
            initialIncluded: existing.enabled,
          },
          enabled,
          expectedVersion,
        );
      } catch (error) {
        // error-policy:J1 The public CRUD boundary maps durable CAS outcomes to
        // transport-stable status codes without hiding the transaction cause.
        if (error instanceof ElizaError) {
          if (error.code === "CALENDAR_SOURCE_SELECTION_CONFLICT") {
            throw new CalendarServiceError(409, error.message, error.code);
          }
          if (
            error.code === "CALENDAR_SOURCE_ATOMIC_COMMIT_FAILED" ||
            error.code === "CALENDAR_SOURCE_TRANSACTION_REQUIRED"
          ) {
            throw new CalendarServiceError(503, error.message, error.code);
          }
          if (error.code === "CALENDAR_ICS_SOURCE_NOT_FOUND") {
            throw new CalendarServiceError(404, error.message, error.code);
          }
        }
        throw error;
      }
      const selected = await this.repo.getIcsCalendarSource(
        this.agentId(),
        normalizedSourceId,
      );
      if (!selected) {
        throw new CalendarServiceError(
          404,
          "Calendar subscription source not found.",
          "ICS_SOURCE_NOT_FOUND",
        );
      }
      return publicIcsCalendarSource(selected);
    }

    let replacement:
      | {
          secretRef: string;
          urlFingerprint: string;
          origin: string;
          retiredSecretRef: string;
          cleanupId: string;
          cleanupAt: string;
        }
      | undefined;
    let replacementSecrets: CalendarSecretsService | null = null;
    if (request.url !== undefined) {
      const sourceUrl = normalizeIcsSubscriptionUrl(
        requireNonEmptyString(request.url, "url"),
      );
      const urlFingerprint = fingerprintIcsSourceUrl(sourceUrl);
      if (urlFingerprint !== existing.urlFingerprint) {
        replacementSecrets = this.requireIcsSecretsService();
        const replacementSecretRef = `CALENDAR_ICS_SOURCE_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .toUpperCase()}_URL`;
        await this.storeIcsSourceSecret(
          replacementSecrets,
          replacementSecretRef,
          sourceUrl.href,
        );
        replacement = {
          secretRef: replacementSecretRef,
          urlFingerprint,
          origin: sourceUrl.origin,
          retiredSecretRef: existing.secretRef,
          cleanupId: crypto.randomUUID(),
          cleanupAt: new Date().toISOString(),
        };
      }
    }

    let updated: IcsCalendarSourceRecord | null;
    try {
      updated = await this.repo.updateIcsCalendarSource({
        agentId: this.agentId(),
        sourceId: normalizedSourceId,
        name,
        updatedAt: new Date().toISOString(),
        replacement,
      });
    } catch (error) {
      // error-policy:J1 The URL-rotation boundary retires the staged secret
      // before translating an expected duplicate-source constraint.
      if (replacement && replacementSecrets) {
        await this.deleteUncommittedIcsSourceSecretBestEffort(
          replacementSecrets,
          normalizedSourceId,
          replacement.secretRef,
        );
      }
      if (
        error instanceof Error &&
        /calendar_sources_agent_fingerprint_unique/i.test(error.message)
      ) {
        throw new CalendarServiceError(
          409,
          "This calendar subscription is already configured.",
          "ICS_SOURCE_ALREADY_EXISTS",
        );
      }
      throw error;
    }
    if (!updated) {
      if (replacement && replacementSecrets) {
        await this.deleteUncommittedIcsSourceSecretBestEffort(
          replacementSecrets,
          normalizedSourceId,
          replacement.secretRef,
        );
      }
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    if (replacement) {
      await this.drainIcsSecretCleanupAtBoundary("url-rotation");
    }
    return publicIcsCalendarSource(updated);
  }

  async deleteIcsCalendarSource(sourceId: string): Promise<void> {
    await this.drainIcsSecretCleanupAtBoundary("delete");
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const deleted = await this.repo.deleteIcsCalendarSource(
      this.agentId(),
      normalizedSourceId,
      {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      },
    );
    if (!deleted) {
      throw new CalendarServiceError(
        404,
        "Calendar subscription source not found.",
        "ICS_SOURCE_NOT_FOUND",
      );
    }
    await this.drainIcsSecretCleanupAtBoundary("source-delete");
  }

  async syncIcsCalendarSource(
    sourceId: string,
    options: {
      now?: Date;
      leaseMs?: number;
      transport?: IcsFetchTransport;
      signal?: AbortSignal;
    } = {},
  ): Promise<LifeOpsIcsCalendarSyncResponse> {
    await this.drainIcsSecretCleanupAtBoundary("sync");
    const normalizedSourceId = requireNonEmptyString(sourceId, "sourceId");
    const now = options.now ?? new Date();
    const attemptedAt = now.toISOString();
    const leaseMs = Math.max(
      1,
      Math.floor(options.leaseMs ?? DEFAULT_ICS_SYNC_LEASE_MS),
    );
    const token = crypto.randomUUID();
    const lease = await this.repo.claimIcsCalendarSync({
      agentId: this.agentId(),
      sourceId: normalizedSourceId,
      token,
      attemptedAt,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    if (!lease) {
      const source = await this.repo.getIcsCalendarSource(
        this.agentId(),
        normalizedSourceId,
      );
      if (!source) {
        throw new CalendarServiceError(
          404,
          "Calendar subscription source not found.",
          "ICS_SOURCE_NOT_FOUND",
        );
      }
      if (!source.enabled) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription source is disabled.",
          "ICS_SOURCE_DISABLED",
        );
      }
      throw new CalendarServiceError(
        409,
        "Calendar subscription source is already syncing.",
        "ICS_SYNC_IN_PROGRESS",
      );
    }

    try {
      const secrets = this.requireIcsSecretsService();
      const sourceValue = await this.resolveIcsSourceSecret(
        secrets,
        lease.source,
      );
      const sourceUrl = normalizeIcsSourceUrl(sourceValue);
      if (fingerprintIcsSourceUrl(sourceUrl) !== lease.source.urlFingerprint) {
        throw new CalendarServiceError(
          503,
          "Calendar subscription secret does not match its source record.",
          "ICS_SECRET_FINGERPRINT_MISMATCH",
        );
      }
      const fetched = await fetchIcsFeed({
        sourceUrl: sourceUrl.href,
        validators: {
          ...(lease.source.etag ? { etag: lease.source.etag } : {}),
          ...(lease.source.lastModified
            ? { lastModified: lease.source.lastModified }
            : {}),
        },
        transport: options.transport,
        signal: options.signal,
      });
      const completedAt = (options.now ?? new Date()).toISOString();
      if (fetched.state === "not_modified") {
        if (!lease.source.contentHash || !lease.source.lastSyncedAt) {
          throw new CalendarServiceError(
            502,
            "Calendar subscription returned not-modified before any snapshot was stored.",
            "ICS_UNEXPECTED_NOT_MODIFIED",
          );
        }
        const completed = await this.repo.completeIcsCalendarNotModified({
          agentId: this.agentId(),
          sourceId: lease.source.id,
          generation: lease.generation,
          token: lease.token,
          completedAt,
          origin: fetched.finalOrigin,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
        });
        if (!completed) {
          throw new CalendarServiceError(
            409,
            "Calendar subscription sync was superseded by a newer revision.",
            "ICS_SYNC_SUPERSEDED",
          );
        }
        return {
          source: publicIcsCalendarSource(completed),
          outcome: "not_modified",
          acceptedEvents: 0,
          prunedEvents: 0,
          tombstones: 0,
        };
      }

      const parsed = parseIcsCalendar(fetched.body);
      if (parsed.state === "error") {
        throw new CalendarServiceError(
          422,
          "Calendar subscription contained no valid events.",
          "ICS_FEED_PARSE_ERROR",
        );
      }
      const events = parsed.events.map((event) =>
        lifeOpsCalendarEventFromIcs({
          event,
          source: lease.source,
          syncedAt: completedAt,
        }),
      );
      const partialError: LifeOpsCalendarSourceError | null =
        parsed.state === "partial"
          ? {
              code: "ICS_FEED_PARTIAL_PARSE",
              message: `${parsed.issues.length} calendar event${
                parsed.issues.length === 1 ? " was" : "s were"
              } rejected as invalid.`,
              retryable: false,
            }
          : null;
      const reconciled = await this.repo.reconcileIcsCalendarSnapshot({
        agentId: this.agentId(),
        sourceId: lease.source.id,
        generation: lease.generation,
        token: lease.token,
        completedAt,
        origin: fetched.finalOrigin,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        contentHash: parsed.contentHash,
        state: parsed.state,
        error: partialError,
        events,
      });
      if (!reconciled) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription sync was superseded by a newer revision.",
          "ICS_SYNC_SUPERSEDED",
        );
      }
      return {
        source: publicIcsCalendarSource(reconciled.source),
        outcome: parsed.state,
        acceptedEvents: reconciled.acceptedEvents,
        prunedEvents: reconciled.prunedEvents,
        tombstones: reconciled.tombstones,
      };
    } catch (error) {
      // error-policy:J1 The sync boundary durably records a redacted failure,
      // releases its lease, and returns only a typed calendar-domain error.
      const sourceError = icsCalendarSyncError(error);
      const failed = await this.repo.failIcsCalendarSync({
        agentId: this.agentId(),
        sourceId: lease.source.id,
        generation: lease.generation,
        token: lease.token,
        completedAt: new Date().toISOString(),
        error: sourceError,
      });
      if (!failed) {
        throw new CalendarServiceError(
          409,
          "Calendar subscription sync was superseded by a newer revision.",
          "ICS_SYNC_SUPERSEDED",
        );
      }
      this.runtime.reportError(
        "calendar:ics-sync",
        new ElizaError(sourceError.message, {
          code: sourceError.code,
          context: {
            sourceId: lease.source.id,
            sourceFingerprint: lease.source.urlFingerprint,
          },
          severity: sourceError.retryable ? "ephemeral" : "fatal",
        }),
      );
      if (error instanceof CalendarServiceError) throw error;
      throw new CalendarServiceError(
        sourceError.retryable ? 502 : 422,
        sourceError.message,
        sourceError.code,
      );
    }
  }

  async reserveCalendarAvailability(request: {
    eventId: string;
    kind: CalendarOwnedAvailabilityKind;
    startAt: string;
    endAt: string;
    idempotencyKey: string;
  }): Promise<LifeOpsCalendarEvent> {
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const parent = await this.repo.getCalendarEventById(
      this.agentId(),
      eventId,
    );
    if (!parent) {
      throw new CalendarServiceError(
        404,
        "Calendar event was not found for availability reservation.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    const reservation = createCalendarAvailabilityReservation({
      parent,
      kind: request.kind,
      startAt: request.startAt,
      endAt: request.endAt,
      idempotencyKey: request.idempotencyKey,
    });
    await this.repo.upsertCalendarEvent(reservation, parent.side);
    try {
      await this.recordCalendarEventAudit(
        reservation.id,
        "calendar availability reserved with structural metadata",
        {
          parentEventId: parent.id,
          kind: request.kind,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
        },
        { idempotencyKey: request.idempotencyKey },
        "calendar_event_updated",
      );
    } catch (error) {
      // error-policy:J7 the reservation is authoritative; audit failure is
      // reported without turning a persisted interval into a false failure.
      this.runtime.reportError(
        "calendar:availability-reservation-audit",
        error,
        {
          reservationId: reservation.id,
        },
      );
      logger.warn(
        { src: "calendar:service", reservationId: reservation.id },
        "[CalendarService] Availability reservation audit write failed.",
      );
    }
    return reservation;
  }

  async reserveTravelBuffer(request: {
    eventId: string;
    bufferMinutes: number;
    method: string;
  }): Promise<LifeOpsCalendarEvent> {
    if (
      !Number.isInteger(request.bufferMinutes) ||
      request.bufferMinutes <= 0 ||
      request.bufferMinutes > 24 * 60
    ) {
      throw new CalendarServiceError(
        400,
        "Travel buffer minutes must be an integer between 1 and 1440.",
        "CALENDAR_TRAVEL_BUFFER_INVALID",
      );
    }
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const parent = await this.repo.getCalendarEventById(
      this.agentId(),
      eventId,
    );
    if (!parent) {
      throw new CalendarServiceError(
        404,
        "Calendar event was not found for travel reservation.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    const end = Date.parse(parent.startAt);
    if (!Number.isFinite(end)) {
      throw new CalendarServiceError(
        500,
        "Calendar event has an invalid start time.",
        "CALENDAR_EVENT_INVALID_START",
      );
    }
    return this.reserveCalendarAvailability({
      eventId,
      kind: "travel",
      startAt: new Date(end - request.bufferMinutes * 60_000).toISOString(),
      endAt: new Date(end).toISOString(),
      idempotencyKey: "travel-before-event",
    });
  }

  private async deleteAvailabilityReservationsForParentIds(
    parentEventIds: readonly string[],
  ): Promise<void> {
    if (parentEventIds.length === 0) return;
    const parents = new Set(parentEventIds);
    const events = [
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        undefined,
        undefined,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        undefined,
        undefined,
      )),
      ...(await this.repo.listCalendarEvents(
        this.agentId(),
        ELIZA_CALENDAR_PROVIDER,
        undefined,
        undefined,
      )),
    ];
    const reservations = events.filter((event) => {
      const parentEventId = availabilityReservationParentEventId(event);
      return parentEventId ? parents.has(parentEventId) : false;
    });
    for (const reservation of reservations) {
      await this.repo.deleteCalendarEventById(this.agentId(), reservation.id);
    }
  }

  private async discoverCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<CalendarSourceDiscovery> {
    const mode = normalizeOptionalConnectorMode(request?.mode, "mode");
    const side = normalizeOptionalConnectorSide(request?.side, "side");
    const targetsNonGoogleProvider =
      isMicrosoftCalendarGrantId(request?.grantId) ||
      isAppleCalendarGrant(request?.grantId) ||
      isElizaCalendarGrant(request?.grantId);
    const statuses = targetsNonGoogleProvider
      ? []
      : await this.gate.getGoogleConnectorAccounts(requestUrl, side);
    const grants = statuses
      .filter(hasGoogleConnectorGrant)
      .map((status) => status.grant)
      .filter((grant) =>
        request?.grantId ? grant.id === request.grantId : true,
      )
      .filter((grant) => (mode ? grant.mode === mode : true))
      .filter((grant) => grant.capabilities.includes("google.calendar.read"));
    const summaries: LifeOpsCalendarSummary[] = [];
    const failures: LifeOpsCalendarSourceHealth[] = [];
    if (shouldIncludeElizaCalendar({ side, grantId: request?.grantId })) {
      summaries.push(elizaCalendarSummary());
    }
    if (grants.length > 0) {
      const listCalendars = requireGoogleServiceMethod(
        this.runtime,
        "listCalendars",
      );
      for (const grant of grants) {
        try {
          const entries = await listCalendars({
            accountId: accountIdForGrant(grant),
          });
          summaries.push(
            ...entries.map((entry) =>
              lifeOpsCalendarSummaryFromGoogle({ entry, grant }),
            ),
          );
        } catch (error) {
          // error-policy:J4 Feed discovery retains the failed source so a
          // working second account is presented as partial, never complete.
          const calendar = googleCalendarPlaceholderSummary(grant);
          this.runtime.reportError("calendar:list-source", error, {
            source: calendarSourceKey(calendar),
          });
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: calendarSourceError(error),
            }),
          );
        }
      }
    }
    if (shouldIncludeMicrosoftCalendar({ mode, grantId: request?.grantId })) {
      let microsoftAccounts: MicrosoftCalendarAccount[] = [];
      try {
        microsoftAccounts = await this.microsoftPort.listAccounts({
          side,
          grantId: request?.grantId,
        });
      } catch (error) {
        // error-policy:J4 Microsoft discovery remains an explicit failed
        // source so healthy Google/Apple accounts still produce a partial feed.
        const calendar = microsoftDiscoveryPlaceholderSummary(request?.grantId);
        this.runtime.reportError("calendar:list-microsoft-accounts", error, {
          source: calendarSourceKey(calendar),
        });
        failures.push(
          calendarSourceHealth({
            calendar,
            status: "error",
            syncedAt: null,
            error: calendarSourceError(error),
          }),
        );
      }
      if (
        microsoftAccounts.length === 0 &&
        isMicrosoftCalendarGrantId(request?.grantId)
      ) {
        const calendar = microsoftDiscoveryPlaceholderSummary(request?.grantId);
        failures.push(
          calendarSourceHealth({
            calendar,
            status: "disconnected",
            syncedAt: null,
            error: {
              code: "MICROSOFT_CALENDAR_DISCONNECTED",
              message:
                "The selected Microsoft calendar account is not connected.",
              retryable: true,
            },
          }),
        );
      }
      for (const account of microsoftAccounts) {
        if (
          !account.grant.capabilities.includes("microsoft.calendar.read_basic")
        ) {
          const calendar = microsoftCalendarPlaceholderSummary(account);
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: {
                code: "MICROSOFT_CALENDAR_PERMISSION_MISSING",
                message:
                  "Microsoft Calendar discovery requires delegated Calendars.ReadBasic permission.",
                retryable: false,
              },
            }),
          );
          continue;
        }
        try {
          const calendars = await this.microsoftPort.listCalendars(account);
          summaries.push(
            ...calendars.map((calendar) =>
              lifeOpsCalendarSummaryFromMicrosoft({ account, calendar }),
            ),
          );
        } catch (error) {
          // error-policy:J4 Per-account discovery failure remains visible and
          // cannot turn another account's success into a complete feed.
          const calendar = microsoftCalendarPlaceholderSummary(account);
          this.runtime.reportError("calendar:list-microsoft-source", error, {
            source: calendarSourceKey(calendar),
          });
          failures.push(
            calendarSourceHealth({
              calendar,
              status: "error",
              syncedAt: null,
              error: calendarSourceError(error),
            }),
          );
        }
      }
    }
    if (shouldIncludeAppleCalendar({ mode, side, grantId: request?.grantId })) {
      const appleCalendars = await listNativeAppleCalendars({
        agentId: this.agentId(),
        side: "owner",
        runtime: this.runtime,
      });
      if (appleCalendars.ok) {
        summaries.push(...appleCalendars.data);
      } else if (
        appleCalendars.reason === "native_error" ||
        isAppleCalendarGrant(request?.grantId)
      ) {
        const calendar = appleCalendarPlaceholderSummary({
          calendarId: "all",
          side,
        });
        failures.push(
          calendarSourceHealth({
            calendar,
            status:
              appleCalendars.reason === "not_supported"
                ? "disconnected"
                : "error",
            syncedAt: null,
            error: {
              code:
                appleCalendars.reason === "permission"
                  ? "CALENDAR_PERMISSION_REQUIRED"
                  : appleCalendars.reason === "not_supported"
                    ? CALENDAR_SOURCE_UNSUPPORTED
                    : "CALENDAR_SOURCE_ERROR",
              message:
                appleCalendars.reason === "not_supported"
                  ? `Apple Calendar is unavailable on ${appleCalendars.platform}.`
                  : appleCalendars.reason === "permission"
                    ? "Apple Calendar permission is required."
                    : appleCalendars.message,
              retryable: appleCalendars.reason !== "not_supported",
            },
          }),
        );
      }
    }
    if (shouldIncludeIcsCalendars({ mode, side, grantId: request?.grantId })) {
      const icsSources = await this.repo.listIcsCalendarSources(this.agentId());
      summaries.push(
        ...icsSources
          .filter((source) =>
            request?.grantId ? source.id === request.grantId : true,
          )
          .map(icsCalendarSummary),
      );
    }
    const preferences = await ensureCalendarFeedIncludes(
      this.runtime,
      summaries.map((summary) => ({
        provider: summary.provider,
        side: summary.side,
        grantId: summary.grantId,
        connectorAccountId: summary.connectorAccountId,
        calendarId: summary.calendarId,
        // The built-in calendar is the zero-config product surface. External
        // accounts remain discoverable but enter the aggregate feed only after
        // the owner explicitly enables them in Calendar Sources.
        initialIncluded:
          summary.provider === ELIZA_CALENDAR_PROVIDER ||
          (summary.provider === "ics" && summary.includeInFeed),
      })),
    );
    return {
      calendars: summaries.map((summary) => {
        const preferenceKey = calendarFeedPreferenceKey({
          provider: summary.provider,
          side: summary.side,
          grantId: summary.grantId,
          connectorAccountId: summary.connectorAccountId,
          calendarId: summary.calendarId,
        });
        const includeInFeed = preferences.calendarFeedIncludes[preferenceKey];
        const selectionVersion =
          preferences.calendarFeedVersions[preferenceKey];
        if (
          typeof includeInFeed !== "boolean" ||
          !Number.isSafeInteger(selectionVersion)
        ) {
          throw new ElizaError(
            "Calendar source preference initialization returned an incomplete row.",
            {
              code: "CALENDAR_SOURCE_PREFERENCE_INCOMPLETE",
              context: {
                source: calendarSourceKey(summary),
                includeInFeed,
                selectionVersion,
              },
              severity: "fatal",
            },
          );
        }
        return {
          ...summary,
          includeInFeed,
          selectionVersion,
        };
      }),
      failures,
    };
  }

  async listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]> {
    const discovery = await this.discoverCalendars(requestUrl, request);
    if (discovery.calendars.length === 0 && discovery.failures.length > 0) {
      throw new CalendarServiceError(
        503,
        discovery.failures
          .map((source) => source.error?.message)
          .filter((message): message is string => Boolean(message))
          .join(" "),
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    return discovery.calendars;
  }

  async setCalendarIncluded(
    requestUrl: URL,
    request: SetLifeOpsCalendarIncludedRequest,
  ): Promise<SetLifeOpsCalendarIncludedResponse> {
    const provider = normalizeCalendarProvider(request.provider);
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (!side) {
      throw new CalendarServiceError(400, "side is required");
    }
    const grantId = requireNonEmptyString(request.grantId, "grantId");
    const connectorAccountId = requireNonEmptyString(
      request.connectorAccountId,
      "connectorAccountId",
    );
    const calendarId = requireNonEmptyString(request.calendarId, "calendarId");
    const includeInFeed = normalizeOptionalBoolean(
      request.includeInFeed,
      "includeInFeed",
    );
    if (includeInFeed === undefined) {
      throw new CalendarServiceError(400, "includeInFeed must be a boolean");
    }
    if (
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0
    ) {
      throw new CalendarServiceError(
        400,
        "expectedVersion must be a non-negative safe integer",
        "CALENDAR_SOURCE_VERSION_INVALID",
      );
    }
    const calendars = await this.listCalendars(requestUrl, {
      side,
      mode: request.mode,
      grantId,
    });
    const calendar = calendars.find(
      (entry) =>
        entry.provider === provider &&
        entry.side === side &&
        entry.grantId === grantId &&
        entry.connectorAccountId === connectorAccountId &&
        entry.calendarId === calendarId &&
        entry.selectionVersion === request.expectedVersion,
    );
    if (!calendar) {
      const sameIdentity = calendars.find(
        (entry) =>
          entry.provider === provider &&
          entry.side === side &&
          entry.grantId === grantId &&
          entry.connectorAccountId === connectorAccountId &&
          entry.calendarId === calendarId,
      );
      if (sameIdentity) {
        throw new CalendarServiceError(
          409,
          "Calendar source selection changed after it was listed. Refresh sources before retrying.",
          "CALENDAR_SOURCE_SELECTION_CONFLICT",
        );
      }
      throw new CalendarServiceError(
        404,
        "The exact calendar source was not found.",
        "CALENDAR_SOURCE_NOT_FOUND",
      );
    }
    try {
      const receipt = await setCalendarFeedIncluded(
        this.runtime,
        {
          provider: calendar.provider,
          side: calendar.side,
          grantId: calendar.grantId,
          connectorAccountId: calendar.connectorAccountId,
          calendarId,
          initialIncluded: calendar.includeInFeed,
        },
        includeInFeed,
        request.expectedVersion,
      );
      return {
        calendar: {
          ...calendar,
          includeInFeed: receipt.included,
          selectionVersion: receipt.currentVersion,
        },
        previousVersion: receipt.previousVersion,
        currentVersion: receipt.currentVersion,
        changed: receipt.changed,
        acceptedAt: receipt.updatedAt,
      };
    } catch (error) {
      // error-policy:J1 CalendarService is the public domain boundary. Preserve
      // stable conflict/retry codes while the SQL layer retains rollback cause.
      if (
        error instanceof ElizaError &&
        error.code === "CALENDAR_SOURCE_SELECTION_CONFLICT"
      ) {
        throw new CalendarServiceError(409, error.message, error.code);
      }
      if (
        error instanceof ElizaError &&
        error.code === "CALENDAR_SOURCE_ATOMIC_COMMIT_FAILED"
      ) {
        throw new CalendarServiceError(503, error.message, error.code);
      }
      if (
        error instanceof ElizaError &&
        error.code === "CALENDAR_SOURCE_TRANSACTION_REQUIRED"
      ) {
        throw new CalendarServiceError(503, error.message, error.code);
      }
      if (
        error instanceof ElizaError &&
        error.code === "CALENDAR_ICS_SOURCE_NOT_FOUND"
      ) {
        throw new CalendarServiceError(404, error.message, error.code);
      }
      throw error;
    }
  }

  private async recordCalendarEventAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
    eventType:
      | "calendar_event_created"
      | "calendar_event_updated"
      | "calendar_event_deleted" = "calendar_event_created",
  ): Promise<void> {
    await this.gate.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "calendar_event",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  private async syncCalendarReminderPlans(
    events: LifeOpsCalendarEvent[],
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    const existingPlans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    const plansByOwnerId = new Map(
      existingPlans.map((plan) => [plan.ownerId, plan]),
    );
    for (const event of events) {
      const existing = plansByOwnerId.get(event.id);
      if (existing) {
        await this.gate.updateReminderPlan({
          ...existing,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await this.gate.createReminderPlan(
        createLifeOpsReminderPlan({
          agentId: this.agentId(),
          ownerType: "calendar_event",
          ownerId: event.id,
          steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }),
      );
    }
  }

  private async deleteCalendarReminderPlansForEvents(
    eventIds: string[],
  ): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const plans = await this.gate.listReminderPlansForOwners(
      this.agentId(),
      "calendar_event",
      eventIds,
    );
    for (const plan of plans) {
      await this.gate.deleteReminderPlan(this.agentId(), plan.id);
    }
  }

  private async loadGoogleCalendarSyncBatch(args: {
    accountId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
    syncToken?: string;
  }): Promise<GoogleCalendarSyncBatch> {
    const listEventPage = requireGoogleServiceMethod(
      this.runtime,
      "listEventPage",
    );
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    do {
      const page = await listEventPage({
        accountId: args.accountId,
        calendarId: args.calendarId,
        maxResults: 2500,
        pageToken,
        timeZone: args.timeZone,
        ...(args.syncToken
          ? { syncToken: args.syncToken }
          : { timeMin: args.timeMin, timeMax: args.timeMax }),
      });
      if (page.events.length > MAX_GOOGLE_CALENDAR_EVENTS - events.length) {
        throw new ElizaError(
          "Google Calendar event sync exceeded the retained event limit.",
          {
            code: "GOOGLE_CALENDAR_EVENT_LIMIT_EXCEEDED",
            context: {
              accountId: args.accountId,
              calendarId: args.calendarId,
              maxEvents: MAX_GOOGLE_CALENDAR_EVENTS,
            },
            severity: "fatal",
          },
        );
      }
      events.push(...page.events);
      if (page.nextSyncToken) {
        nextSyncToken = page.nextSyncToken;
      }
      if (page.nextPageToken && seenPageTokens.has(page.nextPageToken)) {
        throw new ElizaError("Google Calendar repeated an event page token.", {
          code: "GOOGLE_CALENDAR_REPEATED_PAGE_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
            pageToken: page.nextPageToken,
          },
          severity: "fatal",
        });
      }
      pageToken = page.nextPageToken ?? undefined;
      if (pageToken) {
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);

    if (args.syncToken && !nextSyncToken) {
      throw new ElizaError(
        "Google Calendar incremental sync completed without a replacement sync token.",
        {
          code: "GOOGLE_CALENDAR_MISSING_SYNC_TOKEN",
          context: {
            accountId: args.accountId,
            calendarId: args.calendarId,
          },
          severity: "fatal",
        },
      );
    }

    return { events, nextSyncToken };
  }

  private async withGoogleSyncLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.googleSyncLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.googleSyncLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.googleSyncLocks.get(key) === tail) {
        this.googleSyncLocks.delete(key);
      }
    }
  }

  private async syncGoogleCalendarFeed(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const key = [
      this.agentId(),
      args.requestedSide ?? "owner",
      args.grantId ?? "",
      args.calendarId,
    ].join(":");
    const feed = await this.withGoogleSyncLock(key, () =>
      this.syncGoogleCalendarFeedUnlocked(args),
    );
    const source = feed.sources[0];
    if (!source) return feed;
    try {
      await this.googleWatch.ensureForSource({
        grantId: source.key.grantId,
        connectorAccountId: source.key.connectorAccountId,
        side: source.key.side,
        calendarId: source.key.calendarId,
        calendarSummary: source.summary,
        calendarAccessRole: source.accessRole,
        timeZone: args.timeZone,
        windowStartAt: args.timeMin,
        windowEndAt: args.timeMax,
      });
    } catch (error) {
      // error-policy:J4 The data snapshot remains explicitly fresh while the
      // independent push-delivery health reports its degraded state.
      this.runtime.reportError("calendar:google-watch-create", error, {
        source: source.key,
      });
    }
    source.changeDelivery = await this.googleWatch.sourceHealth(source.key);
    return feed;
  }

  private async syncGoogleCalendarFeedUnlocked(args: {
    requestUrl: URL;
    requestedMode?: LifeOpsConnectorMode;
    requestedSide?: LifeOpsConnectorSide;
    grantId?: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const grant = await this.gate.requireGoogleCalendarGrant(
      args.requestUrl,
      args.requestedMode,
      args.requestedSide,
      args.grantId,
    );
    const syncedAt = new Date().toISOString();
    const accountId = accountIdForGrant(grant);
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      "google",
      args.calendarId,
      grant.side,
      grant.id,
    );
    let incremental = Boolean(
      syncState?.nextSyncToken &&
        syncState.windowStartAt <= args.timeMin &&
        syncState.windowEndAt >= args.timeMax,
    );
    let batch: GoogleCalendarSyncBatch;
    try {
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
        ...(incremental && syncState?.nextSyncToken
          ? { syncToken: syncState.nextSyncToken }
          : {}),
      });
    } catch (error) {
      // error-policy:J1 The calendar sync boundary translates Google's
      // expected 410 cursor expiry into the provider-prescribed full snapshot.
      if (!(error instanceof GoogleCalendarSyncTokenExpiredError)) {
        throw error;
      }
      incremental = false;
      batch = await this.loadGoogleCalendarSyncBatch({
        accountId,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
      });
    }

    let nextEvents: LifeOpsCalendarEvent[];
    const removedEventIds = new Set<string>();
    const changedEvents: LifeOpsCalendarEvent[] = [];
    let stateWindowStartAt = args.timeMin;
    let stateWindowEndAt = args.timeMax;

    if (incremental && syncState) {
      stateWindowStartAt = syncState.windowStartAt;
      stateWindowEndAt = syncState.windowEndAt;
      const cached = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
        grant.side,
        grant.id,
      );
      const cachedByExternalId = new Map(
        cached
          .filter((event) => event.calendarId === args.calendarId)
          .map((event) => [event.externalId, event] as const),
      );

      for (const googleEvent of batch.events) {
        const cachedEvent = cachedByExternalId.get(googleEvent.id);
        if (
          !googleEventIntersectsWindow(
            googleEvent,
            stateWindowStartAt,
            stateWindowEndAt,
          )
        ) {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            "google",
            args.calendarId,
            googleEvent.id,
            grant.side,
            grant.id,
          );
          if (cachedEvent) {
            removedEventIds.add(cachedEvent.id);
          }
          continue;
        }
        const event = lifeOpsCalendarEventFromGoogle({
          event: googleEvent,
          grant,
          agentId: this.agentId(),
          syncedAt,
        });
        await this.repo.upsertCalendarEvent(event, grant.side);
        changedEvents.push(event);
      }
      nextEvents = (
        await this.repo.listCalendarEvents(
          this.agentId(),
          "google",
          args.timeMin,
          args.timeMax,
          grant.side,
          grant.id,
        )
      ).filter((event) => event.calendarId === args.calendarId);
    } else {
      const existingEvents = await this.repo.listCalendarEvents(
        this.agentId(),
        "google",
        args.timeMin,
        args.timeMax,
        grant.side,
        grant.id,
      );
      const existingEventsForCalendar = existingEvents.filter(
        (event) => event.calendarId === args.calendarId,
      );
      const localAvailabilityEvents = existingEventsForCalendar.filter(
        isLocallyManagedAvailabilityEvent,
      );
      const fullEvents = batch.events.filter(
        (event) => event.status !== "cancelled",
      );
      const providerEvents = fullEvents.map((event) =>
        lifeOpsCalendarEventFromGoogle({
          event,
          grant,
          agentId: this.agentId(),
          syncedAt,
        }),
      );
      nextEvents = [...providerEvents, ...localAvailabilityEvents];
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      for (const event of existingEventsForCalendar) {
        if (!nextEventIds.has(event.id)) {
          removedEventIds.add(event.id);
        }
      }
      await this.repo.pruneCalendarEventsInWindow(
        this.agentId(),
        "google",
        args.calendarId,
        args.timeMin,
        args.timeMax,
        [
          ...fullEvents.map((event) => event.id),
          ...localAvailabilityEvents.map((event) => event.externalId),
        ],
        grant.side,
        grant.id,
      );
      for (const event of nextEvents) {
        await this.repo.upsertCalendarEvent(event, grant.side);
      }
      changedEvents.push(...providerEvents);
    }

    const removedIds = [...removedEventIds];
    await this.deleteAvailabilityReservationsForParentIds(removedIds);
    if (removedIds.length > 0) {
      const removedParents = new Set(removedIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedIds);
    await this.syncCalendarReminderPlans(changedEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: changedEvents,
      removedEventIds: removedIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: "google",
        side: grant.side,
        grantId: grant.id,
        connectorAccountId: accountId,
        calendarId: args.calendarId,
        windowStartAt: stateWindowStartAt,
        windowEndAt: stateWindowEndAt,
        nextSyncToken: batch.nextSyncToken,
        syncedAt,
      }),
    );
    try {
      const linkedProviderEventIds = new Set(
        batch.events.map((event) => event.id),
      );
      if (!incremental) {
        for (const link of await this.linkedRepo.listForAgent(this.agentId())) {
          if (
            link.connectorAccountId === accountId &&
            link.providerCalendarId === args.calendarId &&
            link.providerEventId
          ) {
            linkedProviderEventIds.add(link.providerEventId);
          }
        }
      }
      await this.reconcileLinkedGoogleChanges(args.requestUrl, [
        ...linkedProviderEventIds,
      ]);
    } catch (error) {
      // error-policy:J4 The provider cache remains fresh, while linked-event
      // reconciliation is explicitly surfaced for owner intervention.
      this.runtime.reportError("calendar:linked-google-reconciliation", error, {
        calendarId: args.calendarId,
        grantId: grant.id,
      });
    }
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: "google",
            side: grant.side,
            grantId: grant.id,
            connectorAccountId: accountId,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async syncGoogleCalendarWatchChannel(
    channel: GoogleCalendarWatchChannel,
  ): Promise<void> {
    const requestUrl = new URL(channel.webhookUrl);
    const grant = await this.gate.requireGoogleCalendarGrant(
      requestUrl,
      "local",
      channel.side,
      channel.grantId,
    );
    if (
      grant.id !== channel.grantId ||
      grant.side !== channel.side ||
      accountIdForGrant(grant) !== channel.connectorAccountId
    ) {
      throw new ElizaError(
        "Google Calendar watch account binding no longer matches its connector grant.",
        {
          code: "GOOGLE_CALENDAR_WATCH_BINDING_MISMATCH",
          context: {
            channelId: channel.channelId,
            grantId: channel.grantId,
            connectorAccountId: channel.connectorAccountId,
          },
          severity: "fatal",
        },
      );
    }
    const key = [
      this.agentId(),
      channel.side,
      channel.grantId,
      channel.calendarId,
    ].join(":");
    await this.withGoogleSyncLock(key, () =>
      this.syncGoogleCalendarFeedUnlocked({
        requestUrl,
        requestedMode: "local",
        requestedSide: channel.side,
        grantId: channel.grantId,
        calendarId: channel.calendarId,
        calendarSummary: channel.calendarSummary,
        calendarAccessRole: channel.calendarAccessRole,
        timeMin: channel.windowStartAt,
        timeMax: channel.windowEndAt,
        timeZone: channel.timeZone,
      }),
    );
  }

  async handleGoogleCalendarNotification(
    headers: GoogleCalendarNotificationHeaders,
  ): Promise<GoogleCalendarWebhookResult> {
    return this.googleWatch.handleNotification(headers);
  }

  async runGoogleCalendarWatchScheduledTask(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined> {
    if (record.metadata?.calendarGoogleWatchOperation === "maintenance") {
      await this.drainIcsSecretCleanupAtBoundary("maintenance");
    }
    return this.googleWatch.runScheduledTask(record);
  }

  async revokeGoogleCalendarWatchesByAccount(
    connectorAccountId: string,
  ): Promise<void> {
    await this.googleWatch.revokeAccount(connectorAccountId);
  }

  private async withMicrosoftSyncLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.microsoftSyncLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.microsoftSyncLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.microsoftSyncLocks.get(key) === tail) {
        this.microsoftSyncLocks.delete(key);
      }
    }
  }

  private async syncMicrosoftCalendarFeed(args: {
    requestedSide: LifeOpsConnectorSide;
    grantId: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
  }): Promise<LifeOpsCalendarFeed> {
    const key = [
      this.agentId(),
      args.requestedSide,
      args.grantId,
      args.calendarId,
    ].join(":");
    return this.withMicrosoftSyncLock(key, () =>
      this.syncMicrosoftCalendarFeedUnlocked(args),
    );
  }

  private async syncMicrosoftCalendarFeedUnlocked(args: {
    requestedSide: LifeOpsConnectorSide;
    grantId: string;
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
  }): Promise<LifeOpsCalendarFeed> {
    const accounts = await this.microsoftPort.listAccounts({
      side: args.requestedSide,
      grantId: args.grantId,
    });
    const account = accounts[0];
    if (!account) {
      throw new ElizaError(
        "The selected Microsoft calendar account is not connected.",
        {
          code: "MICROSOFT_CALENDAR_ACCOUNT_DISCONNECTED",
          context: {
            grantId: args.grantId,
            side: args.requestedSide,
          },
          severity: "fatal",
        },
      );
    }

    const syncedAt = new Date().toISOString();
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      MICROSOFT_CALENDAR_PROVIDER,
      args.calendarId,
      account.grant.side,
      account.grant.id,
    );
    let incremental = Boolean(
      syncState?.nextSyncToken &&
        syncState.windowStartAt <= args.timeMin &&
        syncState.windowEndAt >= args.timeMax,
    );
    let batch: MicrosoftGraphCalendarSyncBatch;
    try {
      batch = await this.microsoftPort.syncCalendarView({
        account,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        ...(incremental && syncState?.nextSyncToken
          ? { deltaLink: syncState.nextSyncToken }
          : {}),
      });
    } catch (error) {
      // error-policy:J1 The calendar sync boundary translates Graph's expired
      // delta cursor into the provider-prescribed full snapshot.
      if (!(error instanceof MicrosoftGraphDeltaExpiredError)) {
        throw error;
      }
      incremental = false;
      batch = await this.microsoftPort.syncCalendarView({
        account,
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
      });
    }

    const allCached = (
      await this.repo.listCalendarEvents(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        undefined,
        undefined,
        account.grant.side,
        account.grant.id,
      )
    ).filter((event) => event.calendarId === args.calendarId);
    const cachedByExternalId = new Map(
      allCached.map((event) => [event.externalId, event] as const),
    );
    const removedEventIds = new Set<string>();
    const changedEvents: LifeOpsCalendarEvent[] = [];
    let nextEvents: LifeOpsCalendarEvent[];
    let stateWindowStartAt = args.timeMin;
    let stateWindowEndAt = args.timeMax;

    if (incremental && syncState) {
      stateWindowStartAt = syncState.windowStartAt;
      stateWindowEndAt = syncState.windowEndAt;
      for (const change of batch.changes) {
        const externalId =
          change.kind === "tombstone" ? change.eventId : change.event.id;
        const cached = cachedByExternalId.get(externalId);
        if (change.kind === "tombstone") {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.eventId,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          cachedByExternalId.delete(change.eventId);
          continue;
        }
        if (
          !microsoftEventIntersectsWindow(
            change.event,
            stateWindowStartAt,
            stateWindowEndAt,
          )
        ) {
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.event.id,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          cachedByExternalId.delete(change.event.id);
          continue;
        }
        const incomingRevision = microsoftEventRevisionMs(change.event);
        const cachedRevision = cached
          ? cachedMicrosoftEventRevisionMs(cached)
          : null;
        if (
          cached &&
          ((incomingRevision !== null &&
            cachedRevision !== null &&
            cachedRevision > incomingRevision) ||
            microsoftEventIsAlreadyCached(cached, change.event))
        ) {
          continue;
        }
        const event = lifeOpsCalendarEventFromMicrosoft({
          event: change.event,
          account,
          calendarId: args.calendarId,
          agentId: this.agentId(),
          syncedAt,
        });
        await this.repo.upsertCalendarEvent(event, account.grant.side);
        cachedByExternalId.set(change.event.id, event);
        changedEvents.push(event);
      }
      nextEvents = (
        await this.repo.listCalendarEvents(
          this.agentId(),
          MICROSOFT_CALENDAR_PROVIDER,
          args.timeMin,
          args.timeMax,
          account.grant.side,
          account.grant.id,
        )
      ).filter((event) => event.calendarId === args.calendarId);
    } else {
      const eventsByExternalId = new Map<string, MicrosoftGraphEvent>();
      for (const change of batch.changes) {
        if (change.kind === "tombstone") {
          eventsByExternalId.delete(change.eventId);
          const cached = cachedByExternalId.get(change.eventId);
          await this.repo.deleteCalendarEventByExternalId(
            this.agentId(),
            MICROSOFT_CALENDAR_PROVIDER,
            args.calendarId,
            change.eventId,
            account.grant.side,
            account.grant.id,
          );
          if (cached) removedEventIds.add(cached.id);
          continue;
        }
        if (
          !microsoftEventIntersectsWindow(
            change.event,
            args.timeMin,
            args.timeMax,
          )
        ) {
          continue;
        }
        const previous = eventsByExternalId.get(change.event.id);
        const previousRevision = previous
          ? microsoftEventRevisionMs(previous)
          : null;
        const incomingRevision = microsoftEventRevisionMs(change.event);
        if (
          previous &&
          previousRevision !== null &&
          incomingRevision !== null &&
          previousRevision > incomingRevision
        ) {
          continue;
        }
        eventsByExternalId.set(change.event.id, change.event);
      }
      const existingEventsForWindow = allCached.filter(
        (event) =>
          Date.parse(event.endAt) > Date.parse(args.timeMin) &&
          Date.parse(event.startAt) < Date.parse(args.timeMax),
      );
      const localAvailabilityEvents = existingEventsForWindow.filter(
        isLocallyManagedAvailabilityEvent,
      );
      const providerRecords = [...eventsByExternalId.values()].map(
        (incoming) => ({
          incoming,
          event: lifeOpsCalendarEventFromMicrosoft({
            event: incoming,
            account,
            calendarId: args.calendarId,
            agentId: this.agentId(),
            syncedAt,
          }),
        }),
      );
      const providerEvents = providerRecords.map((record) => record.event);
      nextEvents = [...providerEvents, ...localAvailabilityEvents];
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      for (const event of existingEventsForWindow) {
        if (!nextEventIds.has(event.id)) {
          removedEventIds.add(event.id);
        }
      }
      await this.repo.pruneCalendarEventsInWindow(
        this.agentId(),
        MICROSOFT_CALENDAR_PROVIDER,
        args.calendarId,
        args.timeMin,
        args.timeMax,
        [
          ...providerEvents.map((event) => event.externalId),
          ...localAvailabilityEvents.map((event) => event.externalId),
        ],
        account.grant.side,
        account.grant.id,
      );
      for (const event of nextEvents) {
        await this.repo.upsertCalendarEvent(event, account.grant.side);
      }
      changedEvents.push(
        ...providerRecords
          .filter(({ event, incoming }) => {
            const cached = cachedByExternalId.get(event.externalId);
            return !cached || !microsoftEventIsAlreadyCached(cached, incoming);
          })
          .map((record) => record.event),
      );
    }

    const removedIds = [...removedEventIds];
    await this.deleteAvailabilityReservationsForParentIds(removedIds);
    if (removedIds.length > 0) {
      const removedParents = new Set(removedIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedIds);
    await this.syncCalendarReminderPlans(changedEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: changedEvents,
      removedEventIds: removedIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: MICROSOFT_CALENDAR_PROVIDER,
        side: account.grant.side,
        grantId: account.grant.id,
        connectorAccountId: account.account.id,
        calendarId: args.calendarId,
        windowStartAt: stateWindowStartAt,
        windowEndAt: stateWindowEndAt,
        nextSyncToken: batch.deltaLink,
        syncedAt,
      }),
    );
    // Quarantined events keep the batch and cursor moving, so they must
    // surface as a partial source instead of silently narrowing the feed.
    const quarantineError: LifeOpsCalendarSourceError | null =
      batch.issues.length > 0
        ? {
            code: "MICROSOFT_GRAPH_EVENTS_QUARANTINED",
            message: `${batch.issues.length} Microsoft calendar event${
              batch.issues.length === 1 ? " was" : "s were"
            } quarantined as invalid.`,
            retryable: false,
          }
        : null;
    if (quarantineError) {
      this.runtime.reportError(
        "calendar:microsoft-sync",
        new ElizaError(quarantineError.message, {
          code: quarantineError.code,
          context: {
            grantId: account.grant.id,
            calendarId: args.calendarId,
            issueCount: batch.issues.length,
            issues: batch.issues.slice(0, 20),
          },
          severity: "fatal",
        }),
      );
    }
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: quarantineError ? "partial" : "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: MICROSOFT_CALENDAR_PROVIDER,
            side: account.grant.side,
            grantId: account.grant.id,
            connectorAccountId: account.account.id,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: quarantineError ? "stale" : "fresh",
          syncedAt,
          error: quarantineError,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async syncAppleCalendarFeed(args: {
    calendarId: string;
    calendarSummary: string;
    calendarAccessRole: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<LifeOpsCalendarFeed> {
    const syncedAt = new Date().toISOString();
    const existingEvents = await this.repo.listCalendarEvents(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.timeMin,
      args.timeMax,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    const existingEventsForCalendar =
      args.calendarId === "all"
        ? existingEvents
        : existingEvents.filter(
            (event) => event.calendarId === args.calendarId,
          );
    const localAvailabilityEvents = existingEventsForCalendar.filter(
      isLocallyManagedAvailabilityEvent,
    );
    const nativeFeed = await getNativeAppleCalendarFeed({
      agentId: this.agentId(),
      calendarId: args.calendarId === "all" ? null : args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeFeed.ok) {
      failAppleCalendarResult(nativeFeed, "feed");
    }
    const providerEvents = nativeFeed.data.events.map((event) => ({
      ...event,
      syncedAt,
      updatedAt: syncedAt,
    }));
    let nextEvents = [...providerEvents, ...localAvailabilityEvents];
    const nextEventIds = new Set(nextEvents.map((event) => event.id));
    const removedEventIds = existingEventsForCalendar
      .map((event) => event.id)
      .filter((eventId) => !nextEventIds.has(eventId));

    await this.repo.pruneCalendarEventsInWindow(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      args.calendarId,
      args.timeMin,
      args.timeMax,
      nextEvents.map((event) => event.externalId),
      "owner",
    );
    await this.deleteAvailabilityReservationsForParentIds(removedEventIds);
    if (removedEventIds.length > 0) {
      const removedParents = new Set(removedEventIds);
      nextEvents = nextEvents.filter((event) => {
        const parentEventId = availabilityReservationParentEventId(event);
        return parentEventId ? !removedParents.has(parentEventId) : true;
      });
    }
    await this.deleteCalendarReminderPlansForEvents(removedEventIds);
    for (const event of providerEvents) {
      await this.repo.upsertCalendarEvent(event, "owner");
    }
    await this.syncCalendarReminderPlans(providerEvents);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: providerEvents,
      removedEventIds,
    });
    await this.repo.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId: this.agentId(),
        provider: APPLE_CALENDAR_PROVIDER,
        side: "owner",
        grantId: APPLE_CALENDAR_GRANT_ID,
        connectorAccountId: APPLE_CALENDAR_GRANT_ID,
        calendarId: args.calendarId,
        windowStartAt: args.timeMin,
        windowEndAt: args.timeMax,
        nextSyncToken: null,
        syncedAt,
      }),
    );
    return {
      calendarId: args.calendarId,
      events: nextEvents,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: {
            provider: APPLE_CALENDAR_PROVIDER,
            side: "owner",
            grantId: APPLE_CALENDAR_GRANT_ID,
            connectorAccountId: APPLE_CALENDAR_GRANT_ID,
            calendarId: args.calendarId,
            summary: args.calendarSummary,
            accessRole: args.calendarAccessRole,
          },
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  private async readCachedCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    now: Date;
    allowStale: boolean;
    error: LifeOpsCalendarSourceError | null;
  }): Promise<LifeOpsCalendarFeed | null> {
    const syncState = await this.repo.getCalendarSyncState(
      this.agentId(),
      args.calendar.provider,
      args.calendar.calendarId,
      args.calendar.side,
      args.calendar.grantId,
    );
    if (!syncState) {
      return null;
    }
    const coversWindow =
      syncState.windowStartAt <= args.timeMin &&
      syncState.windowEndAt >= args.timeMax;
    const ageMs = args.now.getTime() - Date.parse(syncState.syncedAt);
    const fresh =
      coversWindow &&
      Number.isFinite(ageMs) &&
      ageMs >= 0 &&
      ageMs <= CALENDAR_FEED_FRESHNESS_MS;
    if (!fresh && !args.allowStale) {
      return null;
    }
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.calendar.provider,
      args.timeMin,
      args.timeMax,
      args.calendar.side,
      args.calendar.grantId,
    );
    const health = calendarSourceHealth({
      calendar: args.calendar,
      status: fresh ? "fresh" : "stale",
      syncedAt: syncState.syncedAt,
      error: args.error,
    });
    if (args.calendar.provider === "google") {
      health.changeDelivery = await this.googleWatch.sourceHealth(health.key);
    }
    return {
      calendarId: args.calendar.calendarId,
      events,
      source: "cache",
      state: fresh ? "complete" : "partial",
      sources: [health],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: syncState.syncedAt,
    };
  }

  private async readCachedIcsCalendarFeed(args: {
    source: IcsCalendarSourceRecord;
    timeMin: string;
    timeMax: string;
    now: Date;
    allowStale: boolean;
    error?: LifeOpsCalendarSourceError | null;
    sourceKind?: LifeOpsCalendarFeed["source"];
  }): Promise<LifeOpsCalendarFeed | null> {
    const lastAttempt = args.source.lastAttemptedAt
      ? Date.parse(args.source.lastAttemptedAt)
      : Number.NaN;
    const attemptAge = args.now.getTime() - lastAttempt;
    const recentlyAttempted =
      Number.isFinite(attemptAge) &&
      attemptAge >= 0 &&
      attemptAge <= CALENDAR_FEED_FRESHNESS_MS;
    const sourceError =
      args.error === undefined ? args.source.error : args.error;
    const fresh =
      args.source.syncStatus === "fresh" &&
      sourceError === null &&
      recentlyAttempted;
    const hasSnapshot = args.source.lastSyncedAt !== null;
    if (!fresh && !args.allowStale && !(hasSnapshot && recentlyAttempted)) {
      return null;
    }
    if (!hasSnapshot && !fresh) {
      return null;
    }
    const events = (
      await this.repo.listCalendarEvents(
        this.agentId(),
        "ics",
        args.timeMin,
        args.timeMax,
        "owner",
        args.source.id,
      )
    ).filter((event) => event.status !== "cancelled");
    const calendar = icsCalendarSummary(args.source);
    return {
      calendarId: args.source.id,
      events,
      source: args.sourceKind ?? "cache",
      state: fresh ? "complete" : "partial",
      sources: [
        calendarSourceHealth({
          calendar,
          status: fresh ? "fresh" : "stale",
          syncedAt: args.source.lastSyncedAt,
          error: sourceError,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: args.source.lastSyncedAt,
    };
  }

  private async syncIcsCalendarFeed(args: {
    source: IcsCalendarSourceRecord;
    timeMin: string;
    timeMax: string;
    now: Date;
  }): Promise<LifeOpsCalendarFeed> {
    await this.syncIcsCalendarSource(args.source.id, { now: args.now });
    const current = await this.repo.getIcsCalendarSource(
      this.agentId(),
      args.source.id,
    );
    if (!current) {
      throw new ElizaError(
        "Calendar subscription disappeared after synchronization.",
        {
          code: "ICS_SOURCE_SYNC_INVARIANT",
          context: { sourceId: args.source.id },
          severity: "fatal",
        },
      );
    }
    const feed = await this.readCachedIcsCalendarFeed({
      source: current,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      now: args.now,
      allowStale: true,
      sourceKind: "synced",
    });
    if (!feed) {
      throw new ElizaError(
        "Calendar subscription synchronization produced no durable snapshot.",
        {
          code: "ICS_SOURCE_SNAPSHOT_INVARIANT",
          context: { sourceId: args.source.id },
          severity: "fatal",
        },
      );
    }
    return feed;
  }

  private unavailableCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
    error: LifeOpsCalendarSourceError;
  }): LifeOpsCalendarFeed {
    return {
      calendarId: args.calendar.calendarId,
      events: [],
      source: "cache",
      state: "unavailable",
      sources: [
        calendarSourceHealth({
          calendar: args.calendar,
          status: "error",
          syncedAt: null,
          error: args.error,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: null,
    };
  }

  private async readElizaCalendarFeed(args: {
    calendar: LifeOpsCalendarSummary;
    timeMin: string;
    timeMax: string;
  }): Promise<LifeOpsCalendarFeed> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      ELIZA_CALENDAR_PROVIDER,
      args.timeMin,
      args.timeMax,
      "owner",
      ELIZA_CALENDAR_GRANT_ID,
    );
    // The built-in source is authoritative local state, not a polled remote.
    // Its observation token therefore advances only when stored events change;
    // stamping every read with wall-clock time would make receipts non-replayable.
    const syncedAt =
      events
        .map((event) => event.updatedAt)
        .filter((value) => Number.isFinite(Date.parse(value)))
        .sort()
        .at(-1) ?? null;
    return {
      calendarId: args.calendar.calendarId,
      events,
      source: "synced",
      state: "complete",
      sources: [
        calendarSourceHealth({
          calendar: args.calendar,
          status: "fresh",
          syncedAt,
          error: null,
        }),
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt,
    };
  }

  async getCalendarFeed(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsCalendarFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const explicitCalendarId = normalizeOptionalString(request.calendarId);
    const includeHiddenCalendars =
      normalizeOptionalBoolean(
        request.includeHiddenCalendars,
        "includeHiddenCalendars",
      ) ?? false;
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveCalendarWindow({
      now,
      timeZone,
      requestedTimeMin: request.timeMin,
      requestedTimeMax: request.timeMax,
    });
    const forceSync =
      normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;

    const discovery = await this.discoverCalendars(requestUrl, {
      mode,
      side,
      grantId: request.grantId,
    });
    const listedCalendars = discovery.calendars;
    const discoveryFailures = discovery.failures.filter((source) => {
      if (request.grantId && source.key.grantId !== request.grantId) {
        return false;
      }
      return explicitCalendarId
        ? source.key.calendarId === "all" ||
            source.key.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    const calendars = listedCalendars.filter((calendar) => {
      if (calendar.provider === "ics" && !calendar.includeInFeed) {
        return false;
      }
      if (
        !includeHiddenCalendars &&
        !explicitCalendarId &&
        !calendar.includeInFeed
      ) {
        return false;
      }
      return explicitCalendarId
        ? calendar.calendarId === normalizeCalendarId(explicitCalendarId)
        : true;
    });
    if (calendars.length === 0) {
      if (discoveryFailures.length > 0) {
        return {
          calendarId: explicitCalendarId ?? "all",
          events: [],
          source: "cache",
          state: "unavailable",
          sources: discoveryFailures,
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
      if (
        explicitCalendarId &&
        request.grantId &&
        !isAppleCalendarGrant(request.grantId)
      ) {
        calendars.push(
          isMicrosoftCalendarGrantId(request.grantId)
            ? {
                ...microsoftDiscoveryPlaceholderSummary(request.grantId),
                calendarId: normalizeCalendarId(explicitCalendarId),
                summary: explicitCalendarId,
                primary: false,
                timeZone,
              }
            : {
                provider: "google",
                side: side ?? "owner",
                grantId: request.grantId,
                connectorAccountId:
                  googleAccountIdFromGrantId(request.grantId) ??
                  request.grantId,
                accountEmail: null,
                calendarId: normalizeCalendarId(explicitCalendarId),
                summary: explicitCalendarId,
                description: null,
                primary: explicitCalendarId === "primary",
                accessRole: "reader",
                backgroundColor: null,
                foregroundColor: null,
                timeZone,
                selected: true,
                includeInFeed: true,
                selectionVersion: 0,
              },
        );
      } else if (
        shouldIncludeAppleCalendar({ mode, side, grantId: request.grantId })
      ) {
        calendars.push(
          appleCalendarPlaceholderSummary({
            calendarId: explicitCalendarId
              ? normalizeCalendarId(explicitCalendarId)
              : "all",
            timeZone,
            side,
          }),
        );
      } else {
        const disconnected: LifeOpsCalendarSummary = {
          provider: "google",
          side: side ?? "owner",
          grantId: request.grantId ?? "disconnected",
          connectorAccountId: request.grantId ?? "disconnected",
          accountEmail: null,
          calendarId: explicitCalendarId ?? "all",
          summary: "Google Calendar",
          description: null,
          primary: explicitCalendarId === "primary",
          accessRole: "none",
          backgroundColor: null,
          foregroundColor: null,
          timeZone,
          selected: false,
          includeInFeed: false,
          selectionVersion: 0,
        };
        return {
          calendarId: disconnected.calendarId,
          events: [],
          source: "cache",
          state: "unavailable",
          sources: [
            calendarSourceHealth({
              calendar: disconnected,
              status: "disconnected",
              syncedAt: null,
              error: {
                code: "CALENDAR_SOURCE_DISCONNECTED",
                message: "No authorized calendar source is connected.",
                retryable: true,
              },
            }),
          ],
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
    }
    return this.aggregateCalendarFeedsAcrossCalendars(
      requestUrl,
      calendars,
      timeMin,
      timeMax,
      timeZone,
      forceSync,
      now,
      discoveryFailures,
    );
  }

  private async aggregateCalendarFeedsAcrossCalendars(
    requestUrl: URL,
    calendars: LifeOpsCalendarSummary[],
    timeMin: string,
    timeMax: string,
    timeZone: string,
    forceSync: boolean,
    now = new Date(),
    discoveryFailures: readonly LifeOpsCalendarSourceHealth[] = [],
  ): Promise<LifeOpsCalendarFeed> {
    const sources: (AggregatedCalendarFeedSource & {
      calendar: LifeOpsCalendarSummary;
    })[] = [];
    for (const calendar of calendars) {
      if (calendar.provider === ELIZA_CALENDAR_PROVIDER) {
        sources.push({
          calendar,
          feed: await this.readElizaCalendarFeed({
            calendar,
            timeMin,
            timeMax,
          }),
        });
        continue;
      }
      if (calendar.provider === "ics") {
        const source = await this.repo.getIcsCalendarSource(
          this.agentId(),
          calendar.grantId,
        );
        if (!source?.enabled) {
          continue;
        }
        let feed = forceSync
          ? null
          : await this.readCachedIcsCalendarFeed({
              source,
              timeMin,
              timeMax,
              now,
              allowStale: false,
            });
        if (!feed) {
          try {
            feed = await this.syncIcsCalendarFeed({
              source,
              timeMin,
              timeMax,
              now,
            });
          } catch (error) {
            // error-policy:J4 A failed subscription retains its last snapshot
            // as explicitly stale; a never-synced source is unavailable.
            const sourceError = icsCalendarSyncError(error);
            const current =
              (await this.repo.getIcsCalendarSource(
                this.agentId(),
                source.id,
              )) ?? source;
            feed =
              (await this.readCachedIcsCalendarFeed({
                source: current,
                timeMin,
                timeMax,
                now,
                allowStale: true,
                error: sourceError,
              })) ??
              this.unavailableCalendarFeed({
                calendar,
                timeMin,
                timeMax,
                error: sourceError,
              });
          }
        }
        sources.push({ calendar, feed });
        continue;
      }
      let feed = forceSync
        ? null
        : await this.readCachedCalendarFeed({
            calendar,
            timeMin,
            timeMax,
            now,
            allowStale: false,
            error: null,
          });
      if (!feed) {
        try {
          feed =
            calendar.provider === APPLE_CALENDAR_PROVIDER
              ? await this.syncAppleCalendarFeed({
                  calendarId: calendar.calendarId,
                  calendarSummary: calendar.summary,
                  calendarAccessRole: calendar.accessRole,
                  timeMin,
                  timeMax,
                  timeZone,
                })
              : calendar.provider === MICROSOFT_CALENDAR_PROVIDER
                ? await this.syncMicrosoftCalendarFeed({
                    requestedSide: calendar.side,
                    grantId: calendar.grantId,
                    calendarId: calendar.calendarId,
                    calendarSummary: calendar.summary,
                    calendarAccessRole: calendar.accessRole,
                    timeMin,
                    timeMax,
                  })
                : await this.syncGoogleCalendarFeed({
                    requestUrl,
                    requestedSide: calendar.side,
                    grantId: calendar.grantId,
                    calendarId: calendar.calendarId,
                    calendarSummary: calendar.summary,
                    calendarAccessRole: calendar.accessRole,
                    timeMin,
                    timeMax,
                    timeZone,
                  });
        } catch (error) {
          // error-policy:J4 A stale/error source is returned explicitly so one
          // failed account cannot masquerade as either a complete or empty feed.
          const sourceError = calendarSourceError(error);
          if (sourceError.code !== CALENDAR_SOURCE_UNSUPPORTED) {
            this.runtime.reportError("calendar:feed-source", error, {
              source: calendarSourceKey(calendar),
              timeMin,
              timeMax,
              ...providerResponseErrorContext(error),
            });
          }
          feed =
            (await this.readCachedCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              now,
              allowStale: true,
              error: sourceError,
            })) ??
            this.unavailableCalendarFeed({
              calendar,
              timeMin,
              timeMax,
              error: sourceError,
            });
        }
      }
      sources.push({ calendar, feed });
    }
    // Provider synchronization can update or delete the linked local event.
    // Read local snapshots afterwards so this response reflects that change.
    for (const source of sources) {
      if (source.calendar.provider === ELIZA_CALENDAR_PROVIDER) {
        source.feed = await this.readElizaCalendarFeed({
          calendar: source.calendar,
          timeMin,
          timeMax,
        });
      }
    }
    const hasLinkedCandidates =
      sources.some(
        ({ calendar, feed }) =>
          calendar.provider === "eliza" && feed.events.length > 0,
      ) &&
      sources.some(
        ({ calendar, feed }) =>
          calendar.provider === "google" && feed.events.length > 0,
      );
    const links = hasLinkedCandidates
      ? await this.linkedRepo.listForAgent(this.agentId())
      : [];
    const health = [
      ...discoveryFailures,
      ...sources.flatMap((source) => source.feed.sources),
    ];
    const allFresh = health.every((source) => source.status === "fresh");
    const hasUsableSource = health.some(
      (source) => source.status === "fresh" || source.status === "stale",
    );
    const state = allFresh
      ? "complete"
      : hasUsableSource
        ? "partial"
        : "unavailable";
    const syncedTimes = health
      .map((source) => source.syncedAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      calendarId: calendars.length === 1 ? calendars[0].calendarId : "all",
      events: mergeAggregatedCalendarFeedEvents(sources, links),
      source: sources.every((source) => source.feed.source === "synced")
        ? "synced"
        : "cache",
      state,
      sources: health,
      timeMin,
      timeMax,
      syncedAt: syncedTimes.at(-1) ?? null,
    };
  }

  private async findCachedCalendarEventOwnerIds(args: {
    provider: "google" | typeof APPLE_CALENDAR_PROVIDER;
    externalEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId?: string | null;
  }): Promise<string[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      args.provider,
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter((event) => event.externalId === args.externalEventId)
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) => (args.grantId ? event.grantId === args.grantId : true))
      .map((event) => event.id);
  }

  private async resolveMicrosoftCalendarWriteTarget(args: {
    grantId: string;
    calendarId: string;
    side?: LifeOpsConnectorSide | null;
  }): Promise<{
    account: MicrosoftCalendarAccount;
    calendarId: string;
  }> {
    const accounts = await this.microsoftPort.listAccounts({
      grantId: args.grantId,
      side: args.side ?? undefined,
    });
    if (accounts.length !== 1) {
      fail(
        409,
        accounts.length === 0
          ? "The selected Microsoft calendar account is not connected."
          : "The Microsoft calendar source is ambiguous; select one account.",
        accounts.length === 0
          ? "MICROSOFT_CALENDAR_DISCONNECTED"
          : "MICROSOFT_CALENDAR_ACCOUNT_AMBIGUOUS",
      );
    }
    const account = accounts[0];
    if (!account.grant.capabilities.includes("microsoft.calendar.write")) {
      fail(
        403,
        "Microsoft Calendar creation requires delegated Calendars.ReadWrite permission.",
        "MICROSOFT_CALENDAR_WRITE_PERMISSION_MISSING",
      );
    }
    const calendars = await this.microsoftPort.listCalendars(account);
    const calendar =
      args.calendarId === "primary"
        ? calendars.find((candidate) => candidate.isDefault)
        : calendars.find((candidate) => candidate.id === args.calendarId);
    if (!calendar) {
      fail(
        404,
        "The selected Microsoft calendar no longer exists.",
        "MICROSOFT_CALENDAR_NOT_FOUND",
      );
    }
    if (!calendar.canEdit) {
      fail(
        403,
        "The selected Microsoft calendar is read-only for this account.",
        "MICROSOFT_CALENDAR_READ_ONLY",
      );
    }
    return { account, calendarId: calendar.id };
  }

  /**
   * Resolve a conversational create into one concrete writable source and
   * absolute interval without performing the write. Approval callers persist
   * this exact binding so execution cannot silently switch providers,
   * calendars, or relative-time interpretations.
   */
  async prepareCalendarEventCreate(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<
    CreateLifeOpsCalendarEventRequest & {
      side: LifeOpsConnectorSide;
      grantId: string;
      calendarId: string;
      startAt: string;
      endAt: string;
      timeZone: string;
    }
  > {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    const recurrence = normalizeRecurrence(request.recurrence);
    const range = resolveCalendarEventRange(request, now);
    if (!request.grantId || isElizaCalendarGrant(request.grantId)) {
      if (calendarId !== ELIZA_CALENDAR_ID) {
        fail(
          404,
          "The built-in Eliza calendar has one primary calendar.",
          "ELIZA_CALENDAR_NOT_FOUND",
        );
      }
      if (recurrence) {
        fail(
          400,
          "Recurring events require a connected calendar provider.",
          "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
        );
      }
      return {
        ...request,
        side: "owner",
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        startAt: range.startAt,
        endAt: range.endAt,
        timeZone: range.timeZone,
        ...(recurrence ? { recurrence } : {}),
      };
    }
    if (isAppleCalendarGrant(request.grantId)) {
      failConditionalMutationUnsupported("Apple");
    }
    if (isMicrosoftCalendarGrantId(request.grantId)) {
      if (recurrence) {
        failMicrosoftRecurrenceUnsupported("creation");
      }
      const microsoftGrantId = requireNonEmptyString(
        request.grantId,
        "grantId",
      );
      const target = await this.resolveMicrosoftCalendarWriteTarget({
        grantId: microsoftGrantId,
        calendarId,
        side,
      });
      return {
        ...request,
        side: target.account.grant.side,
        grantId: target.account.grant.id,
        calendarId: target.calendarId,
        startAt: range.startAt,
        endAt: range.endAt,
        timeZone: range.timeZone,
      };
    }
    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      if (!request.grantId && isGoogleCalendarDisconnected(error)) {
        failConditionalMutationUnsupported("Apple");
      }
      throw error;
    }
    return {
      ...request,
      side: grant.side,
      grantId: grant.id,
      calendarId,
      startAt: range.startAt,
      endAt: range.endAt,
      timeZone: range.timeZone,
      ...(recurrence ? { recurrence } : {}),
    };
  }

  async createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarEvent> {
    const result = await this.createCalendarEventMutation(
      requestUrl,
      request,
      now,
      { acceptWriteOnlyReceipt: false },
    );
    if (result.outcome === "accepted_without_readback") {
      throw new CalendarServiceError(
        500,
        "Apple Calendar accepted the event without readback, but the caller cannot preserve its receipt.",
        "APPLE_CALENDAR_WRITE_ONLY_RECEIPT_DROPPED",
      );
    }
    return result.event;
  }

  async getAppleCalendarCreateAccess(): Promise<{
    provider: typeof APPLE_CALENDAR_PROVIDER;
    grantId: typeof APPLE_CALENDAR_GRANT_ID;
    accessLevel: "full_access" | "write_only";
    readBackAvailable: boolean;
  }> {
    const permission = await getNativeAppleCalendarPermissionStatus();
    if (!permission.ok) {
      failAppleCalendarResult(permission, "check create access");
    }
    if (permission.data.calendar === "write_only") {
      return {
        provider: APPLE_CALENDAR_PROVIDER,
        grantId: APPLE_CALENDAR_GRANT_ID,
        accessLevel: "write_only",
        readBackAvailable: false,
      };
    }
    if (permission.data.calendar === "granted") {
      return {
        provider: APPLE_CALENDAR_PROVIDER,
        grantId: APPLE_CALENDAR_GRANT_ID,
        accessLevel: "full_access",
        readBackAvailable: true,
      };
    }
    throw new CalendarServiceError(
      403,
      "Apple Calendar create access has not been granted.",
      "APPLE_CALENDAR_PERMISSION_REQUIRED",
    );
  }

  /**
   * Force-syncs the owner's calendars for the requested window and returns a
   * receipt counted over the selected sources. The receipt is issued only when
   * every source is fresh; a partial or unavailable feed fails the seed so the
   * caller never shows a healthy count over a gap.
   */
  async seedImportedCalendarData(
    requestUrl: URL,
    request: SeedLifeOpsCalendarRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarSeedReceipt> {
    if (!Array.isArray(request.calendars) || request.calendars.length === 0) {
      throw new CalendarServiceError(
        400,
        "Calendar seeding requires at least one selected calendar.",
        "CALENDAR_SEED_SELECTION_REQUIRED",
      );
    }
    const feed = await this.getCalendarFeed(
      requestUrl,
      {
        side: request.side,
        timeMin: request.timeMin,
        timeMax: request.timeMax,
        timeZone: request.timeZone,
        forceSync: true,
        // The request already carries an explicit exact-source selection, so
        // hidden feed preferences must not make a valid selected source look
        // absent during authorization/receipt validation.
        includeHiddenCalendars: true,
      },
      now,
    );
    const serializedSourceKey = (source: LifeOpsCalendarSourceKey) =>
      JSON.stringify([
        source.provider,
        source.side,
        source.grantId,
        source.connectorAccountId,
        source.calendarId,
      ]);
    const requestedSourceKeys = request.calendars.map(serializedSourceKey);
    const selected = new Set(requestedSourceKeys);
    if (selected.size !== requestedSourceKeys.length) {
      throw new CalendarServiceError(
        400,
        "Calendar seed selection contains the same exact source more than once.",
        "CALENDAR_SEED_SELECTION_DUPLICATE",
      );
    }
    const selectedFeedSources = feed.sources.filter(
      (source) => source.key && selected.has(serializedSourceKey(source.key)),
    );
    const selectedFailures = selectedFeedSources
      .filter((source) => source.status !== "fresh" || source.error !== null)
      .map((source) => source.summary);
    const legacyUnkeyedFailures = feed.sources
      .filter((source) => !source.key && source.error !== null)
      .map((source) => source.summary);
    if (
      selectedFailures.length > 0 ||
      (feed.state !== "complete" &&
        selectedFeedSources.length === 0 &&
        feed.sources.every((source) => !source.key))
    ) {
      throw new CalendarServiceError(
        409,
        selectedFailures.length > 0 || legacyUnkeyedFailures.length > 0
          ? `Calendar seed did not complete: ${[...selectedFailures, ...legacyUnkeyedFailures].join(", ")} could not be synchronized. No receipt was issued.`
          : "Calendar seed did not complete because a selected authoritative calendar source could not be read. No receipt was issued.",
        "CALENDAR_SEED_INCOMPLETE",
      );
    }
    const authorizedFreshSources = new Set(
      feed.sources
        .filter((source) => source.status === "fresh")
        .map((source) => serializedSourceKey(source.key)),
    );
    if (
      requestedSourceKeys.some(
        (sourceKey) => !authorizedFreshSources.has(sourceKey),
      )
    ) {
      throw new CalendarServiceError(
        409,
        "Calendar seed selection does not match the exact fresh sources authorized in the forced feed.",
        "CALENDAR_SEED_SOURCE_MISMATCH",
      );
    }
    const serializedUnknownSourceKey = (value: unknown): string | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const source = value as Record<string, unknown>;
      const fields = [
        source.provider,
        source.side,
        source.grantId,
        source.connectorAccountId,
        source.calendarId,
      ];
      return fields.every((field) => typeof field === "string")
        ? JSON.stringify(fields)
        : null;
    };
    const selectedSourceMatches = (event: LifeOpsCalendarEvent): number => {
      const sourceKeys = new Set<string>();
      const directKey = serializedSourceKey({
        provider: event.provider,
        side: event.side,
        grantId: event.grantId ?? "",
        connectorAccountId: event.connectorAccountId ?? "",
        calendarId: event.calendarId,
      });
      sourceKeys.add(directKey);
      const deduplication = event.metadata?.deduplication;
      if (
        deduplication &&
        typeof deduplication === "object" &&
        !Array.isArray(deduplication)
      ) {
        const sources = (deduplication as Record<string, unknown>).sources;
        if (Array.isArray(sources)) {
          for (const source of sources) {
            const sourceKey = serializedUnknownSourceKey(source);
            if (sourceKey) sourceKeys.add(sourceKey);
          }
        }
      }
      return [...sourceKeys].filter((sourceKey) => selected.has(sourceKey))
        .length;
    };
    const selectedEvents = feed.events
      .map((event) => ({
        event,
        selectedSourceMatches: selectedSourceMatches(event),
      }))
      .filter(({ selectedSourceMatches }) => selectedSourceMatches > 0);
    const identities = new Set(
      selectedEvents.map(({ event }) =>
        JSON.stringify([
          event.provider,
          event.side,
          event.grantId ?? "",
          event.connectorAccountId ?? "",
          event.calendarId,
          event.externalId,
          event.recurringEventId ?? "",
          event.startAt,
        ]),
      ),
    );
    return {
      timeMin: feed.timeMin,
      timeMax: feed.timeMax,
      feedState: "complete",
      selectedSourceCount: selected.size,
      eventCount: identities.size,
      duplicateEventCount:
        selectedEvents.length -
        identities.size +
        selectedEvents.reduce(
          (count, event) => count + event.selectedSourceMatches - 1,
          0,
        ),
      seededAt: now.toISOString(),
    };
  }

  async purgeImportedCalendarData(
    request: PurgeLifeOpsCalendarImportedDataRequest,
    now = new Date(),
  ): Promise<LifeOpsCalendarImportedDataPurgeReceipt> {
    if (request.confirmAction !== true) {
      throw new CalendarServiceError(
        409,
        "Removing imported calendar data requires explicit confirmation immediately before deletion.",
        "CALENDAR_IMPORTED_DATA_CONFIRMATION_REQUIRED",
      );
    }
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      request.provider,
      undefined,
      undefined,
      request.side,
      request.grantId,
    );
    const exactEvents = events.filter(
      (event) => event.connectorAccountId === request.connectorAccountId,
    );
    await this.deleteCalendarReminderPlansForEvents(
      exactEvents.map((event) => event.id),
    );
    const deleted = await this.repo.purgeImportedCalendarProjection({
      agentId: this.agentId(),
      provider: request.provider,
      side: request.side,
      grantId: request.grantId,
      connectorAccountId: request.connectorAccountId,
    });
    return {
      provider: request.provider,
      side: request.side,
      grantId: request.grantId,
      connectorAccountId: request.connectorAccountId,
      ...deleted,
      providerMutation: false,
      purgedAt: now.toISOString(),
    };
  }

  async getCalendarEventById(
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const normalized = requireNonEmptyString(eventId, "eventId");
    return this.repo.getCalendarEventById(this.agentId(), normalized);
  }

  async createCalendarEventMutation(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now = new Date(),
    options: { acceptWriteOnlyReceipt?: boolean } = {},
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const calendarId = normalizeCalendarId(request.calendarId);
    // Validate recurrence up front so an invalid rule fails the request
    // instead of silently creating a one-off event.
    const recurrence = normalizeRecurrence(request.recurrence);
    const range = resolveCalendarEventRange(request, now);
    const { startAt, endAt, timeZone, isAllDay } = range;
    if (!request.grantId || isElizaCalendarGrant(request.grantId)) {
      if (calendarId !== ELIZA_CALENDAR_ID) {
        fail(
          404,
          "The built-in Eliza calendar has one primary calendar.",
          "ELIZA_CALENDAR_NOT_FOUND",
        );
      }
      const event = createElizaCalendarEvent({
        agentId: this.agentId(),
        request: {
          ...request,
          calendarId: ELIZA_CALENDAR_ID,
          grantId: ELIZA_CALENDAR_GRANT_ID,
          side: "owner",
        },
        startAt,
        endAt,
        timeZone,
        isAllDay,
        attendees: normalizeCalendarAttendees(request.attendees),
        now,
      });
      const receipt = await this.repo.insertCalendarEventIfAbsent(event);
      const persisted = receipt.event;
      if (receipt.inserted) {
        await this.enqueueBuiltInCalendarMutation(persisted, "create");
        await this.syncCalendarReminderPlans([persisted]);
        await reconcileMeetingAutoJoin({
          runtime: this.runtime,
          agentId: this.agentId(),
          events: [persisted],
        });
        await this.recordCalendarEventAudit(
          persisted.id,
          "calendar event created in the built-in Eliza calendar",
          {
            calendarId: persisted.calendarId,
            title: request.title,
          },
          {
            externalId: persisted.externalId,
            providerVersion: persisted.metadata.etag,
          },
        );
      }
      return {
        outcome: "event",
        event: persisted,
        writeOnlyReceipt: null,
      };
    }
    if (isMicrosoftCalendarGrantId(request.grantId)) {
      if (recurrence) {
        failMicrosoftRecurrenceUnsupported("creation");
      }
      const microsoftGrantId = requireNonEmptyString(
        request.grantId,
        "grantId",
      );
      const target = await this.resolveMicrosoftCalendarWriteTarget({
        grantId: microsoftGrantId,
        calendarId,
        side,
      });
      const microsoftEvent = await this.microsoftPort.createEvent({
        account: target.account,
        calendarId: target.calendarId,
        title: requireNonEmptyString(request.title, "title"),
        description: normalizeOptionalString(request.description),
        location: normalizeOptionalString(request.location),
        startAt,
        endAt,
        isAllDay,
        attendees: normalizeCalendarAttendees(request.attendees),
        notifyAttendees: request.notifyAttendees === true,
        idempotencyKey: requireNonEmptyString(
          request.idempotencyKey,
          "idempotencyKey",
        ),
      });
      const syncedAt = new Date().toISOString();
      const event = lifeOpsCalendarEventFromMicrosoft({
        event: microsoftEvent,
        account: target.account,
        calendarId: target.calendarId,
        agentId: this.agentId(),
        syncedAt,
      });
      await this.repo.upsertCalendarEvent(event, target.account.grant.side);
      await this.syncCalendarReminderPlans([event]);
      await reconcileMeetingAutoJoin({
        runtime: this.runtime,
        agentId: this.agentId(),
        events: [event],
      });
      await this.recordCalendarEventAudit(
        event.id,
        "calendar event created through Microsoft Graph",
        {
          calendarId: target.calendarId,
          title: request.title,
          notifyAttendees: request.notifyAttendees === true,
        },
        {
          externalId: event.externalId,
          changeKey: microsoftEvent.changeKey,
        },
      );
      return {
        outcome: "event",
        event,
        writeOnlyReceipt: null,
      };
    }
    if (isAppleCalendarGrant(request.grantId)) {
      if (recurrence) {
        failAppleRecurrenceUnsupported("create");
      }
      await this.requireReceiptAwareAppleCreate(options);
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (recurrence) {
        failAppleRecurrenceUnsupported("create");
      }
      await this.requireReceiptAwareAppleCreate(options);
      return this.createAppleCalendarEvent(request, calendarId, {
        startAt,
        endAt,
        timeZone,
      });
    }
    const createEvent = requireGoogleServiceMethod(this.runtime, "createEvent");
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await createEvent(
        googleCalendarEventInput({
          accountId: accountIdForGrant(grant),
          calendarId,
          title: requireNonEmptyString(request.title, "title"),
          startAt: range.startDate ?? startAt,
          endAt: range.endDateExclusive ?? endAt,
          timeZone,
          description: normalizeOptionalString(request.description),
          location: normalizeOptionalString(request.location),
          attendees: normalizeCalendarAttendees(request.attendees),
          recurrence,
          idempotencyKey: request.idempotencyKey,
          notifyAttendees: request.notifyAttendees === true,
        }),
      );
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event created through plugin-google-workspace",
      { calendarId, title: request.title },
      { externalId: event.externalId },
    );
    return {
      outcome: "event",
      event,
      writeOnlyReceipt: null,
    };
  }

  private async requireReceiptAwareAppleCreate(options: {
    acceptWriteOnlyReceipt?: boolean;
  }): Promise<void> {
    if (options.acceptWriteOnlyReceipt !== false) return;
    const access = await this.getAppleCalendarCreateAccess();
    if (access.accessLevel === "write_only") {
      throw new CalendarServiceError(
        409,
        "Apple Calendar has add-only access. Use the receipt-aware calendar mutation boundary.",
        "APPLE_CALENDAR_WRITE_ONLY_RECEIPT_REQUIRED",
      );
    }
  }

  private async createAppleCalendarEvent(
    request: CreateLifeOpsCalendarEventRequest,
    calendarId: string,
    range: { startAt: string; endAt: string; timeZone: string },
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    if (normalizeRecurrence(request.recurrence)) {
      failAppleRecurrenceUnsupported("create");
    }
    const nativeEvent = await createNativeAppleCalendarEvent({
      agentId: this.agentId(),
      request: {
        ...request,
        calendarId,
        startAt: range.startAt,
        endAt: range.endAt,
        timeZone: range.timeZone,
      },
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "create");
    }
    if (nativeEvent.data.kind === "accepted_without_readback") {
      await this.recordCalendarEventAudit(
        `apple-write-only:${request.idempotencyKey ?? nativeEvent.data.receipt.acceptedAt}`,
        "calendar event accepted through Apple Calendar add-only access",
        {
          calendarId: nativeEvent.data.receipt.calendarId,
          title: request.title,
        },
        {
          accessLevel: "write_only",
          readBackAvailable: false,
          providerEventId: null,
        },
      );
      return {
        outcome: "accepted_without_readback",
        event: null,
        writeOnlyReceipt: nativeEvent.data.receipt,
      };
    }
    const event = nativeEvent.data.event;
    await this.repo.upsertCalendarEvent(event, "owner");
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event created through native Apple Calendar",
      { calendarId, title: request.title },
      { externalId: event.externalId },
    );
    return {
      outcome: "event",
      event,
      writeOnlyReceipt: null,
    };
  }

  private async resolveElizaCalendarEvent(args: {
    eventId: string;
    calendarId?: string | null;
  }): Promise<LifeOpsCalendarEvent> {
    const eventId = requireNonEmptyString(args.eventId, "eventId");
    const event = isElizaCalendarEventId(eventId, this.agentId())
      ? await this.repo.getCalendarEventById(this.agentId(), eventId)
      : await this.repo.getCalendarEventByExternalId({
          agentId: this.agentId(),
          provider: ELIZA_CALENDAR_PROVIDER,
          externalEventId: eventId,
          calendarId: args.calendarId,
          side: "owner",
          grantId: ELIZA_CALENDAR_GRANT_ID,
        });
    if (!event || event.provider !== ELIZA_CALENDAR_PROVIDER) {
      throw new CalendarServiceError(
        404,
        "The built-in calendar event was not found.",
        "CALENDAR_EVENT_NOT_FOUND",
      );
    }
    return event;
  }

  private async updateBuiltInCalendarEvent(args: {
    request: {
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      allDay?: LifeOpsCalendarAllDayRange;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
    };
    now?: Date;
  }): Promise<LifeOpsCalendarEvent> {
    if (args.request.recurrence?.length || args.request.recurrenceScope) {
      fail(
        400,
        "Recurring events require a connected calendar provider.",
        "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
      );
    }
    if (args.request.notifyAttendees === true) {
      fail(
        400,
        "The built-in Eliza calendar cannot email attendees. Connect an external calendar to send updates.",
        "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
      );
    }
    const expectedVersion = requireNonEmptyString(
      args.request.expectedProviderVersion,
      "expectedProviderVersion",
    );
    const existing = await this.resolveElizaCalendarEvent(args.request);
    const updated = updateElizaCalendarEvent({
      event: existing,
      ...(args.request.title !== undefined
        ? { title: args.request.title }
        : {}),
      ...(args.request.description !== undefined
        ? { description: args.request.description }
        : {}),
      ...(args.request.location !== undefined
        ? { location: args.request.location }
        : {}),
      ...(args.request.startAt !== undefined
        ? { startAt: args.request.startAt }
        : {}),
      ...(args.request.endAt !== undefined
        ? { endAt: args.request.endAt }
        : {}),
      ...(args.request.allDay !== undefined
        ? { isAllDay: true }
        : args.request.startAt !== undefined || args.request.endAt !== undefined
          ? { isAllDay: false }
          : {}),
      ...(args.request.timeZone !== undefined
        ? { timeZone: args.request.timeZone }
        : {}),
      attendees:
        args.request.attendees === undefined || args.request.attendees === null
          ? undefined
          : normalizeCalendarAttendees(args.request.attendees),
      now: args.now ?? new Date(),
    });
    const persisted = await this.repo.replaceCalendarEventIfVersion({
      event: updated,
      expectedVersion,
    });
    if (!persisted) {
      fail(
        409,
        "The built-in calendar event changed after approval; refresh and retry.",
        "PROVIDER_PRECONDITION_FAILED",
      );
    }
    await this.enqueueBuiltInCalendarMutation(persisted, "update");
    await this.syncCalendarReminderPlans([persisted]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [persisted],
    });
    await this.recordCalendarEventAudit(
      persisted.id,
      "calendar event updated in the built-in Eliza calendar",
      { eventId: existing.externalId },
      { providerVersion: persisted.metadata.etag },
      "calendar_event_updated",
    );
    return persisted;
  }

  private async deleteBuiltInCalendarEvent(args: {
    eventId: string;
    calendarId?: string | null;
    expectedProviderVersion?: string;
    recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    notifyAttendees?: boolean;
  }): Promise<void> {
    if (args.recurrenceScope) {
      fail(
        400,
        "Recurring events require a connected calendar provider.",
        "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
      );
    }
    if (args.notifyAttendees === true) {
      fail(
        400,
        "The built-in Eliza calendar cannot email attendees.",
        "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
      );
    }
    const expectedVersion = requireNonEmptyString(
      args.expectedProviderVersion,
      "expectedProviderVersion",
    );
    const event = await this.resolveElizaCalendarEvent(args);
    const deleted = await this.repo.deleteCalendarEventByIdIfVersion({
      agentId: this.agentId(),
      eventId: event.id,
      expectedVersion,
    });
    if (!deleted) {
      fail(
        409,
        "The built-in calendar event changed after approval; refresh and retry.",
        "PROVIDER_PRECONDITION_FAILED",
      );
    }
    await this.enqueueBuiltInCalendarMutation(event, "delete");
    await this.deleteAvailabilityReservationsForParentIds([event.id]);
    await this.deleteCalendarReminderPlansForEvents([event.id]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: [event.id],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event deleted from the built-in Eliza calendar",
      { eventId: event.externalId },
      { deleted: true, providerVersion: expectedVersion },
      "calendar_event_deleted",
    );
  }

  async updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      allDay?: LifeOpsCalendarAllDayRange;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failMicrosoftCalendarMutationUnsupported("event updates");
    }
    const recurrence = normalizeRecurrence(request.recurrence);
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    if (recurrence && recurrenceScope === "instance") {
      fail(
        400,
        'Recurrence rules apply to the whole series. Use recurrenceScope "series" to change how an event repeats.',
        "CALENDAR_RECURRENCE_SCOPE_CONFLICT",
      );
    }
    const timeZone = request.timeZone
      ? normalizeCalendarTimeZone(request.timeZone)
      : undefined;
    const parseTimeZone = timeZone ?? normalizeCalendarTimeZone(undefined);
    const allDayRange = request.allDay
      ? resolveCalendarEventRange(
          {
            title: request.title ?? "Calendar event",
            allDay: request.allDay,
            timeZone,
          },
          new Date(),
        )
      : null;
    if (
      allDayRange &&
      (request.startAt !== undefined || request.endAt !== undefined)
    ) {
      fail(400, "allDay cannot be combined with timed bounds");
    }
    const nativePatch = {
      calendarId: request.calendarId ?? undefined,
      title: request.title,
      description: request.description,
      location: request.location,
      startAt:
        allDayRange?.startAt ??
        (request.startAt
          ? normalizeCalendarDateTimeInTimeZone(
              request.startAt,
              "startAt",
              parseTimeZone,
            )
          : undefined),
      endAt:
        allDayRange?.endAt ??
        (request.endAt
          ? normalizeCalendarDateTimeInTimeZone(
              request.endAt,
              "endAt",
              parseTimeZone,
            )
          : undefined),
      timeZone,
      isAllDay:
        allDayRange !== null
          ? true
          : request.startAt !== undefined || request.endAt !== undefined
            ? false
            : undefined,
      attendees:
        request.attendees === undefined
          ? undefined
          : normalizeCalendarAttendees(request.attendees),
    };
    if (
      isElizaCalendarGrant(request.grantId) ||
      isElizaCalendarEventId(request.eventId, this.agentId())
    ) {
      return this.updateBuiltInCalendarEvent({
        request: {
          ...request,
          ...nativePatch,
          allDay: request.allDay,
          recurrence,
          recurrenceScope,
        },
      });
    }
    if (isAppleCalendarGrant(request.grantId)) {
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrence || recurrenceScope) {
        failAppleRecurrenceUnsupported("update");
      }
      return this.updateAppleCalendarEvent(request.eventId, nativePatch);
    }
    if (recurrenceScope === "this_and_following") {
      return this.updateGoogleThisAndFollowing({
        requestUrl,
        grant,
        request,
        recurrence,
        timeZone,
        parseTimeZone,
      });
    }
    let targetEventId = requireNonEmptyString(request.eventId, "eventId");
    // A series edit addressed through a flattened occurrence must patch the
    // series master; a recurrence-rule change is always a series edit.
    if (recurrenceScope === "series" || (recurrence && !recurrenceScope)) {
      targetEventId = await this.resolveSeriesMasterEventId({
        grant,
        calendarId: request.calendarId,
        eventId: targetEventId,
      });
    }
    const updateEvent = requireGoogleServiceMethod(this.runtime, "updateEvent");
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await updateEvent(
        googleCalendarEventPatchInput({
          accountId: accountIdForGrant(grant),
          calendarId: request.calendarId,
          eventId: targetEventId,
          recurrence,
          title: request.title,
          description: request.description,
          location: request.location,
          startAt:
            allDayRange?.startDate ??
            (request.startAt
              ? normalizeCalendarDateTimeInTimeZone(
                  request.startAt,
                  "startAt",
                  parseTimeZone,
                )
              : undefined),
          endAt:
            allDayRange?.endDateExclusive ??
            (request.endAt
              ? normalizeCalendarDateTimeInTimeZone(
                  request.endAt,
                  "endAt",
                  parseTimeZone,
                )
              : undefined),
          timeZone,
          attendees:
            request.attendees === undefined
              ? undefined
              : normalizeCalendarAttendees(request.attendees),
          notifyAttendees: request.notifyAttendees === true,
          expectedProviderVersion: request.expectedProviderVersion,
        }),
      );
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.syncCalendarReminderPlans([event]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar event updated through plugin-google-workspace",
      { eventId: request.eventId },
      { externalId: event.externalId },
      "calendar_event_updated",
    );
    return event;
  }

  private async loadGoogleRecurrenceSplitContext(args: {
    grant: LifeOpsConnectorGrant;
    calendarId?: string | null;
    eventId: string;
    expectedProviderVersion?: string;
    expectedOccurrenceProviderVersion?: string;
    replacementRecurrence?: readonly string[];
  }) {
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const accountId = accountIdForGrant(args.grant);
    const calendarId = args.calendarId ?? undefined;
    const occurrenceWire = await getEvent({
      accountId,
      calendarId,
      eventId: requireNonEmptyString(args.eventId, "eventId"),
    });
    const occurrence = lifeOpsCalendarEventFromGoogle({
      event: occurrenceWire,
      grant: args.grant,
      agentId: this.agentId(),
    });
    requireMatchingGoogleProviderVersion(
      occurrence,
      args.expectedOccurrenceProviderVersion,
      "occurrence",
    );
    const masterEventId = recurringEventIdFrom(occurrence);
    if (!masterEventId) {
      fail(
        409,
        "This-and-following requires a concrete recurring occurrence, not a one-off event or series master.",
        "CALENDAR_RECURRENCE_SPLIT_OCCURRENCE_REQUIRED",
      );
    }
    const originalStartAt = recurrenceOriginalStartAtFrom(occurrence);
    if (!originalStartAt) {
      fail(
        502,
        "Google Calendar did not return the occurrence identity required to split the series.",
        "CALENDAR_RECURRENCE_SPLIT_OCCURRENCE_IDENTITY_MISSING",
      );
    }
    if (
      occurrence.metadata.originalStartIsAllDay === true ||
      occurrence.isAllDay
    ) {
      fail(
        400,
        "This-and-following is unavailable for all-day recurrence until date-only split semantics can be preserved.",
        "CALENDAR_RECURRENCE_SPLIT_ALL_DAY_UNSUPPORTED",
      );
    }
    if (
      new Date(originalStartAt).getTime() !==
      new Date(occurrence.startAt).getTime()
    ) {
      fail(
        409,
        "The selected occurrence is a moved exception. Choose the whole series or a non-exception occurrence so the split does not silently change its identity.",
        "CALENDAR_RECURRENCE_SPLIT_TARGET_EXCEPTION_UNSUPPORTED",
      );
    }

    const masterWire = await getEvent({
      accountId,
      calendarId,
      eventId: masterEventId,
    });
    const master = lifeOpsCalendarEventFromGoogle({
      event: masterWire,
      grant: args.grant,
      agentId: this.agentId(),
    });
    requireMatchingGoogleProviderVersion(
      master,
      args.expectedProviderVersion,
      "series master",
    );
    const timeZone = master.timezone ?? occurrence.timezone;
    if (!timeZone) {
      fail(
        502,
        "Google Calendar did not return the IANA timezone required to preserve wall-clock recurrence.",
        "CALENDAR_RECURRENCE_SPLIT_TIMEZONE_MISSING",
      );
    }
    const plan = buildRecurrenceSplitPlan({
      recurrence: recurrenceLinesFrom(master),
      ...(args.replacementRecurrence
        ? { replacementRecurrence: args.replacementRecurrence }
        : {}),
      seriesStartAt: new Date(master.startAt),
      targetStartAt: new Date(originalStartAt),
      timeZone,
    });
    return {
      accountId,
      calendarId,
      occurrence,
      master,
      masterEventId,
      originalStartAt,
      timeZone,
      plan,
    };
  }

  private async updateGoogleThisAndFollowing(args: {
    requestUrl: URL;
    grant: LifeOpsConnectorGrant;
    request: {
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    };
    recurrence?: string[];
    timeZone?: string;
    parseTimeZone: string;
  }): Promise<LifeOpsCalendarEvent> {
    const idempotencyKey = args.request.idempotencyKey?.trim();
    if (!idempotencyKey) {
      fail(
        409,
        "This-and-following update requires the durable mutation operation key.",
        "CALENDAR_RECURRENCE_SPLIT_IDEMPOTENCY_REQUIRED",
      );
    }
    const context = await this.loadGoogleRecurrenceSplitContext({
      grant: args.grant,
      calendarId: args.request.calendarId,
      eventId: args.request.eventId,
      expectedProviderVersion: args.request.expectedProviderVersion,
      expectedOccurrenceProviderVersion:
        args.request.expectedOccurrenceProviderVersion,
      replacementRecurrence: args.recurrence,
    });
    const occurrenceStartMs = Date.parse(context.occurrence.startAt);
    const occurrenceEndMs = Date.parse(context.occurrence.endAt);
    const durationMs = occurrenceEndMs - occurrenceStartMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      fail(
        502,
        "Google Calendar returned invalid occurrence bounds for the series split.",
        "CALENDAR_RECURRENCE_SPLIT_EVENT_BOUNDS_INVALID",
      );
    }
    const requestedStartAt = args.request.startAt
      ? normalizeCalendarDateTimeInTimeZone(
          args.request.startAt,
          "startAt",
          args.parseTimeZone,
        )
      : undefined;
    const requestedEndAt = args.request.endAt
      ? normalizeCalendarDateTimeInTimeZone(
          args.request.endAt,
          "endAt",
          args.parseTimeZone,
        )
      : undefined;
    const startAt = requestedStartAt ?? context.occurrence.startAt;
    const endAt =
      requestedEndAt ??
      (requestedStartAt
        ? new Date(Date.parse(requestedStartAt) + durationMs).toISOString()
        : context.occurrence.endAt);
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      fail(
        400,
        "The following series end must be after its start.",
        "CALENDAR_RECURRENCE_SPLIT_EVENT_BOUNDS_INVALID",
      );
    }
    assertRecurrenceStartMatchesRule({
      recurrence: context.plan.followingRecurrence,
      startAt: new Date(startAt),
      timeZone: args.timeZone ?? context.timeZone,
      label: "Following recurrence",
    });
    const title = args.request.title ?? context.master.title;
    if (!title.trim()) {
      fail(
        400,
        "The following series must retain a non-empty title.",
        "CALENDAR_RECURRENCE_SPLIT_TITLE_REQUIRED",
      );
    }
    const normalizedAttendees =
      args.request.attendees === undefined
        ? recurrenceSplitAttendees(context.master)
        : normalizeCalendarAttendees(args.request.attendees);
    const updateEvent = requireGoogleServiceMethod(this.runtime, "updateEvent");
    let trimmedMaster: LifeOpsCalendarEvent | null = null;
    if (context.plan.truncatedRecurrence) {
      let trimmedWire: GoogleCalendarEvent;
      try {
        trimmedWire = await updateEvent(
          googleCalendarEventPatchInput({
            accountId: context.accountId,
            calendarId: args.request.calendarId,
            eventId: context.masterEventId,
            recurrence: context.plan.truncatedRecurrence,
            notifyAttendees: args.request.notifyAttendees === true,
            expectedProviderVersion: args.request.expectedProviderVersion,
          }),
        );
      } catch (error) {
        // error-policy:J1 CalendarService translates definitive Google
        // mutation outcomes into its stable domain error contract.
        translateGoogleMutationError(error);
      }
      trimmedMaster = lifeOpsCalendarEventFromGoogle({
        event: trimmedWire,
        grant: args.grant,
        agentId: this.agentId(),
      });
      requireVerifiedRecurrence(
        trimmedMaster,
        context.plan.truncatedRecurrence,
        "trimmed original",
      );
    } else {
      const deleteEvent = requireGoogleServiceMethod(
        this.runtime,
        "deleteEvent",
      );
      try {
        await deleteEvent({
          accountId: context.accountId,
          calendarId: context.calendarId,
          eventId: context.masterEventId,
          sendUpdates: args.request.notifyAttendees === true ? "all" : "none",
          expectedEtag: args.request.expectedProviderVersion,
        });
      } catch (error) {
        // error-policy:J1 CalendarService translates definitive Google
        // mutation outcomes into its stable domain error contract.
        translateGoogleMutationError(error);
      }
    }

    let created: CreateLifeOpsCalendarEventResponse;
    try {
      created = await this.createCalendarEventMutation(args.requestUrl, {
        side: args.grant.side,
        grantId: args.grant.id,
        calendarId: args.request.calendarId ?? context.master.calendarId,
        title,
        description: args.request.description ?? context.master.description,
        location: args.request.location ?? context.master.location,
        startAt,
        endAt,
        timeZone: args.timeZone ?? context.timeZone,
        attendees: normalizedAttendees,
        recurrence: context.plan.followingRecurrence,
        idempotencyKey: `calendar-series-split:v1:${idempotencyKey}`,
        notifyAttendees: args.request.notifyAttendees === true,
      });
    } catch (error) {
      // error-policy:J2 Once the original series is trimmed, the provider
      // cause must survive inside a non-retryable ambiguous-outcome failure.
      throw new CalendarServiceError(
        502,
        "The original recurring series was changed, but the following series outcome is unknown. Automatic retry is disabled until the calendar is reconciled.",
        "CALENDAR_RECURRENCE_SPLIT_OUTCOME_AMBIGUOUS",
        { cause: error },
      );
    }
    if (created.outcome !== "event") {
      throw new CalendarServiceError(
        502,
        "The original recurring series was changed, but Google did not return the following series.",
        "CALENDAR_RECURRENCE_SPLIT_OUTCOME_AMBIGUOUS",
      );
    }
    const createdEvent = created.event;
    requireVerifiedRecurrence(
      createdEvent,
      context.plan.followingRecurrence,
      "new following series",
    );
    if (Date.parse(createdEvent.startAt) !== Date.parse(startAt)) {
      fail(
        502,
        "Google Calendar returned the following series at an unexpected start time.",
        "CALENDAR_RECURRENCE_SPLIT_VERIFICATION_FAILED",
      );
    }

    const removedOwnerIds =
      context.plan.targetOccurrenceIndex === 0
        ? await this.purgeCachedSeries({
            masterEventId: context.masterEventId,
            calendarId: args.request.calendarId,
            side: args.grant.side,
            grantId: args.grant.id,
          })
        : await this.purgeCachedSeriesOccurrencesFrom({
            masterEventId: context.masterEventId,
            calendarId: args.request.calendarId,
            side: args.grant.side,
            grantId: args.grant.id,
            originalStartAt: context.originalStartAt,
          });
    if (trimmedMaster) {
      await this.repo.upsertCalendarEvent(trimmedMaster, args.grant.side);
    }
    const event = {
      ...createdEvent,
      metadata: {
        ...createdEvent.metadata,
        recurrenceMutation: {
          scope: "this_and_following",
          originalSeriesEventId: context.masterEventId,
          targetOriginalStartAt: context.originalStartAt,
          futureExceptions: "reset",
        },
      },
    };
    await this.repo.upsertCalendarEvent(event, args.grant.side);
    await this.deleteAvailabilityReservationsForParentIds(removedOwnerIds);
    await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [event],
      removedEventIds: removedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      event.id,
      "calendar recurring series split through plugin-google-workspace",
      {
        eventId: args.request.eventId,
        recurrenceScope: "this_and_following",
        targetOriginalStartAt: context.originalStartAt,
        futureExceptions: "reset",
      },
      {
        originalSeriesExternalId: context.masterEventId,
        followingSeriesExternalId: event.externalId,
      },
      "calendar_event_updated",
    );
    return event;
  }

  private async deleteGoogleThisAndFollowing(args: {
    grant: LifeOpsConnectorGrant;
    request: {
      calendarId?: string | null;
      eventId: string;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    };
  }): Promise<void> {
    if (!args.request.idempotencyKey?.trim()) {
      fail(
        409,
        "This-and-following cancellation requires the durable mutation operation key.",
        "CALENDAR_RECURRENCE_SPLIT_IDEMPOTENCY_REQUIRED",
      );
    }
    const context = await this.loadGoogleRecurrenceSplitContext({
      grant: args.grant,
      calendarId: args.request.calendarId,
      eventId: args.request.eventId,
      expectedProviderVersion: args.request.expectedProviderVersion,
      expectedOccurrenceProviderVersion:
        args.request.expectedOccurrenceProviderVersion,
    });
    let trimmedMaster: LifeOpsCalendarEvent | null = null;
    if (context.plan.truncatedRecurrence) {
      const updateEvent = requireGoogleServiceMethod(
        this.runtime,
        "updateEvent",
      );
      let trimmedWire: GoogleCalendarEvent;
      try {
        trimmedWire = await updateEvent(
          googleCalendarEventPatchInput({
            accountId: context.accountId,
            calendarId: args.request.calendarId,
            eventId: context.masterEventId,
            recurrence: context.plan.truncatedRecurrence,
            notifyAttendees: args.request.notifyAttendees === true,
            expectedProviderVersion: args.request.expectedProviderVersion,
          }),
        );
      } catch (error) {
        // error-policy:J1 CalendarService translates definitive Google
        // mutation outcomes into its stable domain error contract.
        translateGoogleMutationError(error);
      }
      trimmedMaster = lifeOpsCalendarEventFromGoogle({
        event: trimmedWire,
        grant: args.grant,
        agentId: this.agentId(),
      });
      requireVerifiedRecurrence(
        trimmedMaster,
        context.plan.truncatedRecurrence,
        "trimmed original",
      );
    } else {
      const deleteEvent = requireGoogleServiceMethod(
        this.runtime,
        "deleteEvent",
      );
      try {
        await deleteEvent({
          accountId: context.accountId,
          calendarId: context.calendarId,
          eventId: context.masterEventId,
          sendUpdates: args.request.notifyAttendees === true ? "all" : "none",
          expectedEtag: args.request.expectedProviderVersion,
        });
      } catch (error) {
        // error-policy:J1 CalendarService translates definitive Google
        // mutation outcomes into its stable domain error contract.
        translateGoogleMutationError(error);
      }
    }
    const removedOwnerIds =
      context.plan.targetOccurrenceIndex === 0
        ? await this.purgeCachedSeries({
            masterEventId: context.masterEventId,
            calendarId: args.request.calendarId,
            side: args.grant.side,
            grantId: args.grant.id,
          })
        : await this.purgeCachedSeriesOccurrencesFrom({
            masterEventId: context.masterEventId,
            calendarId: args.request.calendarId,
            side: args.grant.side,
            grantId: args.grant.id,
            originalStartAt: context.originalStartAt,
          });
    if (trimmedMaster) {
      await this.repo.upsertCalendarEvent(trimmedMaster, args.grant.side);
    }
    await this.deleteAvailabilityReservationsForParentIds(removedOwnerIds);
    await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: trimmedMaster ? [trimmedMaster] : [],
      removedEventIds: removedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      context.masterEventId,
      "calendar recurring series truncated through plugin-google-workspace",
      {
        eventId: args.request.eventId,
        recurrenceScope: "this_and_following",
        targetOriginalStartAt: context.originalStartAt,
        futureExceptions: "removed",
      },
      {
        originalSeriesExternalId: context.masterEventId,
        deletedFromTarget: true,
      },
      "calendar_event_deleted",
    );
  }

  private async updateAppleCalendarEvent(
    eventId: string,
    nativePatch: Parameters<
      typeof updateNativeAppleCalendarEvent
    >[0]["request"],
  ): Promise<LifeOpsCalendarEvent> {
    const nativeEvent = await updateNativeAppleCalendarEvent({
      agentId: this.agentId(),
      eventId: requireNonEmptyString(eventId, "eventId"),
      request: nativePatch,
      side: "owner",
      runtime: this.runtime,
    });
    if (!nativeEvent.ok) {
      failAppleCalendarResult(nativeEvent, "update");
    }
    await this.repo.upsertCalendarEvent(nativeEvent.data, "owner");
    await this.syncCalendarReminderPlans([nativeEvent.data]);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [nativeEvent.data],
    });
    await this.recordCalendarEventAudit(
      nativeEvent.data.id,
      "calendar event updated through native Apple Calendar",
      { eventId },
      { externalId: nativeEvent.data.externalId },
      "calendar_event_updated",
    );
    return nativeEvent.data;
  }

  async deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failMicrosoftCalendarMutationUnsupported("event deletion");
    }
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    if (
      isElizaCalendarGrant(request.grantId) ||
      isElizaCalendarEventId(eventId, this.agentId())
    ) {
      await this.deleteBuiltInCalendarEvent({
        eventId,
        calendarId: request.calendarId,
        expectedProviderVersion: request.expectedProviderVersion,
        recurrenceScope,
        notifyAttendees: request.notifyAttendees,
      });
      return;
    }
    if (isAppleCalendarGrant(request.grantId)) {
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }

    let grant: LifeOpsConnectorGrant;
    try {
      grant = await this.gate.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
    } catch (error) {
      // error-policy:J4 With no provider selected, an explicitly disconnected
      // Google source degrades to the native Apple provider.
      if (request.grantId || !isGoogleCalendarDisconnected(error)) {
        throw error;
      }
      if (request.expectedProviderVersion) {
        failConditionalMutationUnsupported("Apple");
      }
      if (recurrenceScope) {
        failAppleRecurrenceUnsupported("delete");
      }
      await this.deleteAppleCalendarEvent(eventId, request.calendarId);
      return;
    }
    if (recurrenceScope === "this_and_following") {
      await this.deleteGoogleThisAndFollowing({
        grant,
        request: {
          ...request,
          eventId,
        },
      });
      return;
    }
    // A series delete addressed through a flattened occurrence deletes the
    // series master — one provider call, never an iteration over occurrences.
    const targetEventId =
      recurrenceScope === "series"
        ? await this.resolveSeriesMasterEventId({
            grant,
            calendarId: request.calendarId,
            eventId,
          })
        : eventId;
    const deleteEvent = requireGoogleServiceMethod(this.runtime, "deleteEvent");
    try {
      await deleteEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId: targetEventId,
        sendUpdates: request.notifyAttendees === true ? "all" : "none",
        expectedEtag: request.expectedProviderVersion,
      });
    } catch (error) {
      translateGoogleMutationError(error);
    }
    let removedOwnerIds: string[];
    if (recurrenceScope === "series") {
      // Purge every cached flattened occurrence of the deleted series so the
      // cache does not serve ghost instances until the next sync.
      const cachedSeries = await this.findCachedSeriesEvents({
        masterEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      for (const cachedEvent of cachedSeries) {
        await this.repo.deleteCalendarEventByExternalId(
          this.agentId(),
          "google",
          cachedEvent.calendarId,
          cachedEvent.externalId,
          grant.side,
          grant.id,
        );
      }
      removedOwnerIds = cachedSeries.map((cachedEvent) => cachedEvent.id);
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    } else {
      removedOwnerIds = await this.findCachedCalendarEventOwnerIds({
        provider: "google",
        externalEventId: targetEventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      await this.repo.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        request.calendarId,
        targetEventId,
        grant.side,
        grant.id,
      );
      await this.deleteCalendarReminderPlansForEvents(removedOwnerIds);
    }
    await this.deleteAvailabilityReservationsForParentIds(removedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: removedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      targetEventId,
      "calendar event deleted through plugin-google-workspace",
      { eventId: targetEventId, recurrenceScope: recurrenceScope ?? null },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  /**
   * Resolve the exact object a conditional update/delete will mutate. Google
   * series operations return the master rather than a flattened occurrence;
   * built-in events bind directly to their repository version.
   */
  async getConditionalCalendarMutationTarget(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<LifeOpsCalendarEvent> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    if (
      isElizaCalendarGrant(request.grantId) ||
      isElizaCalendarEventId(request.eventId, this.agentId())
    ) {
      if (normalizeRecurrenceScope(request.recurrenceScope)) {
        fail(
          400,
          "Recurring events require a connected calendar provider.",
          "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
        );
      }
      return this.resolveElizaCalendarEvent(request);
    }
    // An unscoped external-id lookup may still name a built-in event: the
    // built-in calendar is a first-class source, so consult it before binding
    // the mutation to an external provider grant. A miss falls through to the
    // existing provider resolution unchanged.
    if (!request.grantId) {
      const builtIn = await this.repo.getCalendarEventByExternalId({
        agentId: this.agentId(),
        provider: ELIZA_CALENDAR_PROVIDER,
        externalEventId: requireNonEmptyString(request.eventId, "eventId"),
        calendarId: request.calendarId,
        side: "owner",
        grantId: ELIZA_CALENDAR_GRANT_ID,
      });
      if (builtIn) {
        if (normalizeRecurrenceScope(request.recurrenceScope)) {
          fail(
            400,
            "Recurring events require a connected calendar provider.",
            "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
          );
        }
        return builtIn;
      }
    }
    if (
      isAppleCalendarGrant(request.grantId) ||
      isMicrosoftCalendarGrantId(request.grantId) ||
      isMicrosoftCalendarEventId(request.eventId, this.agentId())
    ) {
      failConditionalMutationUnsupported(
        isAppleCalendarGrant(request.grantId) ? "Apple" : "Microsoft",
      );
    }
    const grant = await this.gate.requireGoogleCalendarWriteGrant(
      requestUrl,
      mode,
      side,
      request.grantId,
    );
    const eventId = requireNonEmptyString(request.eventId, "eventId");
    const recurrenceScope = normalizeRecurrenceScope(request.recurrenceScope);
    const targetEventId =
      recurrenceScope === "series" || recurrenceScope === "this_and_following"
        ? await this.resolveSeriesMasterEventId({
            grant,
            calendarId: request.calendarId,
            eventId,
          })
        : eventId;
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const googleEvent = await getEvent({
      accountId: accountIdForGrant(grant),
      calendarId: request.calendarId ?? undefined,
      eventId: targetEventId,
    });
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    requireGoogleProviderVersion(event);
    return event;
  }

  async respondToCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      responseStatus: "accepted" | "declined" | "tentative";
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    if (
      normalizeRecurrenceScope(request.recurrenceScope) === "this_and_following"
    ) {
      fail(
        400,
        "This-and-following is not a valid invitation response scope. Choose one occurrence or the whole series.",
        "CALENDAR_RECURRENCE_RESPONSE_SCOPE_UNSUPPORTED",
      );
    }
    const target = await this.getConditionalCalendarMutationTarget(
      requestUrl,
      request,
    );
    const grant = await this.gate.requireGoogleCalendarWriteGrant(
      requestUrl,
      normalizeOptionalConnectorMode(request.mode, "mode"),
      normalizeOptionalConnectorSide(request.side, "side"),
      request.grantId,
    );
    const respondToEvent = requireGoogleServiceMethod(
      this.runtime,
      "respondToEvent",
    );
    let googleEvent: GoogleCalendarEvent;
    try {
      googleEvent = await respondToEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId: target.externalId,
        responseStatus: request.responseStatus,
        sendUpdates: request.notifyAttendees === true ? "all" : "none",
        expectedEtag: request.expectedProviderVersion,
      });
    } catch (error) {
      translateGoogleMutationError(error);
    }
    const event = lifeOpsCalendarEventFromGoogle({
      event: googleEvent,
      grant,
      agentId: this.agentId(),
    });
    await this.repo.upsertCalendarEvent(event, grant.side);
    await this.recordCalendarEventAudit(
      event.id,
      "calendar invitation response updated through plugin-google-workspace",
      {
        eventId: request.eventId,
        recurrenceScope: request.recurrenceScope ?? null,
        responseStatus: request.responseStatus,
        notifyAttendees: request.notifyAttendees === true,
      },
      { externalId: event.externalId },
      "calendar_event_updated",
    );
    return event;
  }

  /**
   * Resolve the series master id for an event id that may address a flattened
   * recurring occurrence: cached instance metadata first, then a provider
   * lookup. An id with no `recurringEventId` already is the master.
   */
  private async resolveSeriesMasterEventId(args: {
    grant: LifeOpsConnectorGrant;
    calendarId?: string | null;
    eventId: string;
  }): Promise<string> {
    const cached = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.grant.side,
    );
    const match = cached.find(
      (event) =>
        event.externalId === args.eventId &&
        (args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true) &&
        (event.grantId ? event.grantId === args.grant.id : true),
    );
    const cachedMaster = recurringEventIdFrom(match ?? null);
    if (cachedMaster) {
      return cachedMaster;
    }
    if (match) {
      // Cached and not an occurrence: the id addresses the master directly.
      return args.eventId;
    }
    const getEvent = requireGoogleServiceMethod(this.runtime, "getEvent");
    const googleEvent = await getEvent({
      accountId: accountIdForGrant(args.grant),
      calendarId: args.calendarId ?? undefined,
      eventId: args.eventId,
    });
    return recurringEventIdFrom(googleEvent) ?? args.eventId;
  }

  private async findCachedSeriesEvents(args: {
    masterEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId: string;
  }): Promise<LifeOpsCalendarEvent[]> {
    const events = await this.repo.listCalendarEvents(
      this.agentId(),
      "google",
      undefined,
      undefined,
      args.side,
    );
    return events
      .filter(
        (event) =>
          event.externalId === args.masterEventId ||
          recurringEventIdFrom(event) === args.masterEventId,
      )
      .filter((event) =>
        args.calendarId && args.calendarId !== "all"
          ? event.calendarId === args.calendarId
          : true,
      )
      .filter((event) =>
        event.grantId ? event.grantId === args.grantId : true,
      );
  }

  private async purgeCachedSeries(args: {
    masterEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId: string;
  }): Promise<string[]> {
    const cachedSeries = await this.findCachedSeriesEvents(args);
    for (const cachedEvent of cachedSeries) {
      await this.repo.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        cachedEvent.calendarId,
        cachedEvent.externalId,
        args.side,
        args.grantId,
      );
    }
    return cachedSeries.map((event) => event.id);
  }

  private async purgeCachedSeriesOccurrencesFrom(args: {
    masterEventId: string;
    calendarId?: string | null;
    side: LifeOpsConnectorSide;
    grantId: string;
    originalStartAt: string;
  }): Promise<string[]> {
    const targetMs = Date.parse(args.originalStartAt);
    const cachedSeries = await this.findCachedSeriesEvents(args);
    const removed = cachedSeries.filter((event) => {
      if (recurringEventIdFrom(event) !== args.masterEventId) return false;
      const occurrenceIdentity =
        recurrenceOriginalStartAtFrom(event) ?? event.startAt;
      return Date.parse(occurrenceIdentity) >= targetMs;
    });
    for (const cachedEvent of removed) {
      await this.repo.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        cachedEvent.calendarId,
        cachedEvent.externalId,
        args.side,
        args.grantId,
      );
    }
    return removed.map((event) => event.id);
  }

  private async deleteAppleCalendarEvent(
    eventId: string,
    calendarId: string | null | undefined,
  ): Promise<void> {
    const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
      provider: APPLE_CALENDAR_PROVIDER,
      externalEventId: eventId,
      calendarId,
      side: "owner",
      grantId: APPLE_CALENDAR_GRANT_ID,
    });
    const deleted = await deleteNativeAppleCalendarEvent(eventId, {
      runtime: this.runtime,
    });
    if (!deleted.ok) {
      failAppleCalendarResult(deleted, "delete");
    }
    await this.repo.deleteCalendarEventByExternalId(
      this.agentId(),
      APPLE_CALENDAR_PROVIDER,
      calendarId,
      eventId,
      "owner",
      APPLE_CALENDAR_GRANT_ID,
    );
    await this.deleteAvailabilityReservationsForParentIds(cachedOwnerIds);
    await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
    await reconcileMeetingAutoJoin({
      runtime: this.runtime,
      agentId: this.agentId(),
      events: [],
      removedEventIds: cachedOwnerIds,
    });
    await this.recordCalendarEventAudit(
      eventId,
      "calendar event deleted through native Apple Calendar",
      { eventId },
      { deleted: true },
      "calendar_event_deleted",
    );
  }

  async getNextCalendarEventContext(
    requestUrl: URL,
    request: GetLifeOpsCalendarFeedRequest = {},
    now = new Date(),
  ): Promise<LifeOpsNextCalendarEventContext> {
    const timeZone = normalizeCalendarTimeZone(request.timeZone);
    const { timeMin, timeMax } = resolveNextCalendarEventWindow({
      now,
      timeZone,
    });
    const feed = await this.getCalendarFeed(
      requestUrl,
      {
        ...request,
        timeMin,
        timeMax,
        includeHiddenCalendars: false,
      },
      now,
    );
    if (feed.state === "unavailable") {
      throw new CalendarServiceError(
        503,
        "Calendar sources are unavailable, so the next event cannot be determined.",
        "CALENDAR_SOURCES_UNAVAILABLE",
      );
    }
    const nextEvent =
      feed.events.find(
        (event) =>
          !isLocallyManagedAvailabilityEvent(event) &&
          Date.parse(event.endAt) >= now.getTime(),
      ) ?? null;
    return {
      ...buildNextCalendarEventContext(nextEvent, now),
      calendarFeedState: feed.state,
      calendarSources: feed.sources,
    };
  }
}
