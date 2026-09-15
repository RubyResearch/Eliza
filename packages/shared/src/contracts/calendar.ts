/**
 * Calendar API contracts.
 *
 * Canonical home for the calendar event / feed / summary DTOs consumed by
 * `@elizaos/plugin-calendar` (service, action, routes, client, UI) and by
 * `@elizaos/plugin-personal-assistant` (briefs, reminders, travel) and the `@elizaos/ui`
 * client type augmentation. They live in `@elizaos/shared` because the
 * contract layer is the only package both `@elizaos/ui` and the plugins can
 * depend on without a cycle.
 *
 * The `LifeOps`-prefixed names are retained for source compatibility with the
 * many existing importers; the types are calendar-owned regardless of prefix.
 */

import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
} from "./personal-assistant.js";

export interface LifeOpsCalendarEventEndedFilters {
  /** Only fire for events on these calendar ids (e.g. "primary"). */
  calendarIds?: string[];
  /** Only fire when event title matches one of these case-insensitive substrings. */
  titleIncludesAny?: string[];
  /** Only fire when the event lasted at least this many minutes. */
  minDurationMinutes?: number;
  /** Only fire when one attendee email contains one of these substrings. */
  attendeeEmailIncludesAny?: string[];
}

export interface LifeOpsCalendarEventAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export type LifeOpsCalendarProvider =
  | "eliza"
  | "google"
  | "microsoft"
  | "apple_calendar"
  | "ics";

export const LIFEOPS_ICS_SOURCE_SYNC_STATUSES = [
  "never",
  "fresh",
  "partial",
  "error",
] as const;
export type LifeOpsIcsSourceSyncStatus =
  (typeof LIFEOPS_ICS_SOURCE_SYNC_STATUSES)[number];

/**
 * Public representation of one subscribed ICS/webcal feed. The capability-
 * bearing URL and its secret-store handle are deliberately absent; callers
 * receive only a stable fingerprint and the non-sensitive origin.
 */
export interface LifeOpsIcsCalendarSource {
  id: string;
  provider: "ics";
  name: string;
  enabled: boolean;
  origin: string;
  urlFingerprint: string;
  syncStatus: LifeOpsIcsSourceSyncStatus;
  lastSyncedAt: string | null;
  lastAttemptedAt: string | null;
  error: LifeOpsCalendarSourceError | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLifeOpsIcsCalendarSourceRequest {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface UpdateLifeOpsIcsCalendarSourceRequest {
  name?: string;
  url?: string;
  enabled?: boolean;
  /**
   * Required when changing `enabled`; clients obtain it from the matching
   * calendar summary. Metadata-only updates do not consume a selection token.
   */
  expectedSelectionVersion?: number;
}

export interface ListLifeOpsIcsCalendarSourcesResponse {
  sources: LifeOpsIcsCalendarSource[];
}

export interface LifeOpsIcsCalendarSourceMutationResponse {
  source: LifeOpsIcsCalendarSource;
}

export interface LifeOpsIcsCalendarSyncResponse {
  source: LifeOpsIcsCalendarSource;
  outcome: "not_modified" | "complete" | "partial";
  acceptedEvents: number;
  prunedEvents: number;
  tombstones: number;
}

/**
 * Stable identity for one authorized calendar source. `calendarId` alone is
 * not unique: every connected Google account can expose a calendar named
 * `primary`, and shared calendars can appear through more than one grant.
 */
export interface LifeOpsCalendarSourceKey {
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  calendarId: string;
}

export const LIFEOPS_CALENDAR_SOURCE_STATUSES = [
  "fresh",
  "stale",
  "error",
  "disconnected",
] as const;
export type LifeOpsCalendarSourceStatus =
  (typeof LIFEOPS_CALENDAR_SOURCE_STATUSES)[number];

export const LIFEOPS_CALENDAR_SOURCE_VISIBILITIES = [
  "details",
  "busy_only",
] as const;
export type LifeOpsCalendarSourceVisibility =
  (typeof LIFEOPS_CALENDAR_SOURCE_VISIBILITIES)[number];

export interface LifeOpsCalendarSourceError {
  code: string;
  message: string;
  retryable: boolean;
}

export const LIFEOPS_CALENDAR_CHANGE_DELIVERY_STATUSES = [
  "unconfigured",
  "starting",
  "active",
  "degraded",
  "expired",
  "revoked",
] as const;
export type LifeOpsCalendarChangeDeliveryStatus =
  (typeof LIFEOPS_CALENDAR_CHANGE_DELIVERY_STATUSES)[number];

/**
 * Freshness of the mechanism that learns about provider-side changes. This is
 * separate from the cached-data status: a snapshot may be fresh while its push
 * channel is degraded, in which case foreground reads still poll explicitly.
 */
export interface LifeOpsCalendarChangeDeliveryHealth {
  mode: "push" | "polling";
  status: LifeOpsCalendarChangeDeliveryStatus;
  expiresAt: string | null;
  lastNotificationAt: string | null;
  lastSuccessfulSyncAt: string | null;
  error: LifeOpsCalendarSourceError | null;
}

/**
 * Per-source truth exposed with every feed. Guest/free-busy consumers use this
 * state to distinguish a genuinely empty calendar from an unreadable or stale
 * source before claiming a person is available.
 */
export interface LifeOpsCalendarSourceHealth {
  key: LifeOpsCalendarSourceKey;
  summary: string;
  accessRole: string;
  visibility: LifeOpsCalendarSourceVisibility;
  status: LifeOpsCalendarSourceStatus;
  syncedAt: string | null;
  error: LifeOpsCalendarSourceError | null;
  /** Google sources expose push-channel freshness independently from snapshot freshness. */
  changeDelivery?: LifeOpsCalendarChangeDeliveryHealth;
}

/**
 * Owner-administration projection for one exact provider/account/calendar
 * source. `selectionVersion` is null only for a health-only source that is no
 * longer selectable; callers must echo a non-null version on every write.
 */
export interface LifeOpsCalendarSourceAdministrationEntry {
  key: LifeOpsCalendarSourceKey;
  accountEmail: string | null;
  summary: string;
  primary: boolean;
  accessRole: string;
  includeInFeed: boolean | null;
  selectionVersion: number | null;
  health: LifeOpsCalendarSourceHealth;
}

export interface LifeOpsCalendarSourceAdministrationSnapshot {
  state: "complete" | "partial" | "unavailable";
  sources: LifeOpsCalendarSourceAdministrationEntry[];
  observedAt: string;
}

export interface SetLifeOpsCalendarSourceSelectionRequest {
  key: LifeOpsCalendarSourceKey;
  includeInFeed: boolean;
  expectedVersion: number;
}

export interface LifeOpsCalendarSourceSelectionReceipt {
  source: LifeOpsCalendarSourceAdministrationEntry;
  previousVersion: number;
  currentVersion: number;
  changed: boolean;
  acceptedAt: string;
}

export const LIFEOPS_CALENDAR_FEED_STATES = [
  "complete",
  "partial",
  "unavailable",
] as const;
export type LifeOpsCalendarFeedState =
  (typeof LIFEOPS_CALENDAR_FEED_STATES)[number];

/**
 * Which part of a recurring series a mutation targets: one flattened
 * occurrence (`instance`), the selected occurrence and every occurrence after
 * it (`this_and_following`), or the series master (`series`).
 */
export type LifeOpsCalendarRecurrenceScope =
  | "instance"
  | "this_and_following"
  | "series";

export interface LifeOpsCalendarEvent {
  id: string;
  externalId: string;
  agentId: string;
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: LifeOpsCalendarEventAttendee[];
  metadata: Record<string, unknown>;
  /**
   * RFC 5545 recurrence lines (e.g. `RRULE:FREQ=WEEKLY;BYDAY=MO`) when this
   * event is a recurring series master; null/absent for one-off events and
   * flattened instances.
   */
  recurrence?: string[] | null;
  /**
   * Series master event id when this event is a flattened occurrence of a
   * recurring series; null/absent otherwise.
   */
  recurringEventId?: string | null;
  syncedAt: string;
  updatedAt: string;
  /** Set on merged feeds so the UI can show which calendar an event came from. */
  calendarSummary?: string;
  /** LifeOps-owned account key for privacy egress; legacy cache rows may omit it until purge/resync. */
  connectorAccountId?: string;
  /** Connector grant that owns this provider event cache row. */
  grantId?: string;
  /** Email address for the owning connector account when known. */
  accountEmail?: string;
}

export interface LifeOpsCalendarFeed {
  calendarId: string;
  events: LifeOpsCalendarEvent[];
  source: "cache" | "synced";
  /**
   * `complete` means every requested source is fresh; `partial` means cached
   * or stale data is present alongside a failed source; `unavailable` means no
   * authoritative source could be read. Consumers must not infer availability
   * from `events.length` without checking this field.
   */
  state: LifeOpsCalendarFeedState;
  sources: LifeOpsCalendarSourceHealth[];
  timeMin: string;
  timeMax: string;
  syncedAt: string | null;
}

/**
 * Summary of one calendar the user has access to.
 * `includeInFeed` reflects whether the user has opted this calendar into the
 * aggregated sidebar feed / briefing. Defaults to true for every calendar the
 * user can see — opt-out, never opt-in, so new calendars are not silently
 * hidden from the agent's picture of the user's life.
 */
export interface LifeOpsCalendarSummary {
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  accountEmail: string | null;
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  includeInFeed: boolean;
  /** Compare-and-swap token required by every feed-selection write. */
  selectionVersion: number;
}

export interface ListLifeOpsCalendarsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
}

export interface ListLifeOpsCalendarsResponse {
  calendars: LifeOpsCalendarSummary[];
}

export interface SetLifeOpsCalendarIncludedRequest {
  provider: LifeOpsCalendarProvider;
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  calendarId: string;
  includeInFeed: boolean;
  expectedVersion: number;
  /** Retained for transport compatibility; exact identity remains authoritative. */
  mode?: LifeOpsConnectorMode;
}

export interface SetLifeOpsCalendarIncludedResponse {
  calendar: LifeOpsCalendarSummary;
  previousVersion: number;
  currentVersion: number;
  changed: boolean;
  acceptedAt: string;
}

export interface GetLifeOpsCalendarFeedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific connector account by grant ID (multi-account). */
  grantId?: string;
  calendarId?: string;
  /**
   * Internal/agent override: when no calendarId is specified, include every
   * authorized calendar instead of only the user's feed-enabled subset.
   */
  includeHiddenCalendars?: boolean;
  timeMin?: string;
  timeMax?: string;
  timeZone?: string;
  forceSync?: boolean;
}

/**
 * Force-syncs the selected calendars for a bounded window and returns the
 * server-computed seed receipt. Counts are derived from the same provider-
 * neutral event identity the merged feed uses, so clients render them rather
 * than recomputing them.
 */
export interface SeedLifeOpsCalendarRequest {
  side?: LifeOpsConnectorSide;
  timeMin: string;
  timeMax: string;
  timeZone?: string;
  /** Exact sources to count; every key must name a calendar the owner can see. */
  calendars: Array<{
    provider: LifeOpsCalendarProvider;
    side: LifeOpsConnectorSide;
    grantId: string;
    connectorAccountId: string;
    calendarId: string;
  }>;
}

export interface LifeOpsCalendarSeedReceipt {
  timeMin: string;
  timeMax: string;
  /** Mirrors the feed state the seed observed; a receipt is only issued for `complete`. */
  feedState: Extract<LifeOpsCalendarFeedState, "complete">;
  selectedSourceCount: number;
  eventCount: number;
  duplicateEventCount: number;
  seededAt: string;
}

/** Removes only Eliza's imported calendar projection for one exact source. */
export interface PurgeLifeOpsCalendarImportedDataRequest {
  provider: Extract<LifeOpsCalendarProvider, "google" | "apple_calendar">;
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  /** Required immediately before the local destructive operation. */
  confirmAction: boolean;
}

export interface LifeOpsCalendarImportedDataPurgeReceipt {
  provider: Extract<LifeOpsCalendarProvider, "google" | "apple_calendar">;
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  deletedEventCount: number;
  deletedSyncStateCount: number;
  providerMutation: false;
  purgedAt: string;
}

export type LifeOpsLinkedCalendarState =
  | "clean"
  | "dirty"
  | "conflicted"
  | "quarantined"
  | "paused"
  | "local_only";

export interface LifeOpsLinkedCalendarLink {
  id: string;
  localEventId: string;
  connectorAccountId: string;
  providerCalendarId: string;
  providerEventId: string | null;
  providerEtag: string | null;
  localRevision: number;
  state: LifeOpsLinkedCalendarState;
  pendingOperation: "create" | "update" | "delete" | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Owner sync review with local event details; null means the event no longer exists. */
export interface LifeOpsLinkedCalendarEventView
  extends LifeOpsLinkedCalendarLink {
  event: Pick<
    LifeOpsCalendarEvent,
    "title" | "startAt" | "endAt" | "isAllDay"
  > | null;
}

/** Owner-visible sync review; internal dispatch receipts never leave the service. */
export interface LifeOpsLinkedCalendarControl {
  revision: number;
  paused: boolean;
  destination: {
    connectorAccountId: string;
    providerCalendarId: string;
  } | null;
  pendingDispatch: { linkId: string } | null;
}

export interface LifeOpsLinkedCalendarControlMutationResult
  extends LifeOpsLinkedCalendarControl {
  receipt: {
    id: string;
    operationKey: string;
    committedAt: string;
    revision: number;
    replayed: boolean;
  };
}

export type UpdateLifeOpsLinkedCalendarControlRequest = {
  expectedRevision: number;
  idempotencyKey: string;
} & (
  | { operation: "pause" | "resume" | "recover" }
  | {
      operation: "select";
      destination: LifeOpsLinkedCalendarControl["destination"];
    }
);

export interface CreateLifeOpsLinkedCalendarLinkRequest {
  localEventId: string;
  connectorAccountId: string;
  providerCalendarId: string;
  expectedLocalRevision: number;
  idempotencyKey: string;
}

export interface RunLifeOpsLinkedCalendarReconciliationRequest {
  expectedUpdatedAt: string;
  idempotencyKey: string;
}

export interface ResolveLifeOpsLinkedCalendarConflictRequest
  extends RunLifeOpsLinkedCalendarReconciliationRequest {
  strategy: "keep_eliza" | "keep_google";
}

export interface DisconnectLifeOpsLinkedCalendarRequest {
  expectedUpdatedAt: string;
  idempotencyKey: string;
  /** Both independently useful events are retained; only synchronization stops. */
  retainEvents: true;
}

/** Prepares a reviewed local event for a new provider destination without deleting the old provider event. */
export interface RebindLifeOpsLinkedCalendarRequest {
  expectedUpdatedAt: string;
  expectedLocalRevision: number;
  expectedControlRevision: number;
  connectorAccountId: string;
  providerCalendarId: string;
  idempotencyKey: string;
  retainPreviousProviderEvent: true;
}

export interface RebindLifeOpsLinkedCalendarResponse {
  previous: LifeOpsLinkedCalendarLink;
  link: LifeOpsLinkedCalendarLink;
  controlRevision: number;
  receipt: { operationKey: string; replayed: boolean };
  providerMutation: "none";
}

export interface LifeOpsLinkedCalendarMutationResponse {
  link: LifeOpsLinkedCalendarLink;
  outcome:
    | "linked"
    | "clean"
    | "dirty"
    | "pushed"
    | "pulled"
    | "conflicted"
    | "quarantined"
    | "paused"
    | "disconnected";
}

export const LIFEOPS_CALENDAR_WINDOW_PRESETS = [
  "tomorrow_morning",
  "tomorrow_afternoon",
  "tomorrow_evening",
] as const;
export type LifeOpsCalendarWindowPreset =
  (typeof LIFEOPS_CALENDAR_WINDOW_PRESETS)[number];

export interface CreateLifeOpsCalendarEventAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
}

/** A provider-neutral all-day interval using an exclusive civil-date end. */
export interface LifeOpsCalendarAllDayRange {
  startDate: string;
  endDateExclusive: string;
}

export interface CreateLifeOpsCalendarEventRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  calendarId?: string;
  grantId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  /** Mutually exclusive with timed bounds and window presets. */
  allDay?: LifeOpsCalendarAllDayRange;
  timeZone?: string;
  durationMinutes?: number;
  windowPreset?: LifeOpsCalendarWindowPreset;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
  /**
   * Stable operation key for exactly-once provider creation. Approval
   * executors always supply one; ordinary interactive creates may omit it.
   */
  idempotencyKey?: string;
  /**
   * Whether the provider may email attendees. Omission is equivalent to false
   * so adding guests never silently sends external mail.
   */
  notifyAttendees?: boolean;
  /**
   * RFC 5545 recurrence lines for a recurring event (e.g.
   * `["RRULE:FREQ=WEEKLY;BYDAY=MO"]`). Validated before reaching a provider;
   * invalid rules fail the request instead of creating a one-off event.
   */
  recurrence?: string[];
}

/**
 * A provider may accept a create without granting the application permission
 * to read the resulting event. Apple EventKit's write-only authorization is
 * the canonical example: the receipt proves acceptance but deliberately
 * carries no provider event identifier and must never be rendered as a
 * readable calendar event.
 */
export interface LifeOpsCalendarWriteOnlyCreateReceipt {
  provider: "apple_calendar";
  sourceId: string;
  calendarId: string;
  accessLevel: "write_only";
  destination: "default_calendar";
  providerEventId: null;
  readBackAvailable: false;
  acceptedAt: string;
}

export type CreateLifeOpsCalendarEventResponse =
  | {
      outcome: "event";
      event: LifeOpsCalendarEvent;
      writeOnlyReceipt: null;
    }
  | {
      outcome: "accepted_without_readback";
      event: null;
      writeOnlyReceipt: LifeOpsCalendarWriteOnlyCreateReceipt;
    };

export interface LifeOpsNextCalendarEventContext {
  event: LifeOpsCalendarEvent | null;
  calendarFeedState: LifeOpsCalendarFeedState;
  calendarSources: LifeOpsCalendarSourceHealth[];
  startsAt: string | null;
  startsInMinutes: number | null;
  attendeeCount: number;
  attendeeNames: string[];
  location: string | null;
  conferenceLink: string | null;
  preparationChecklist: string[];
  linkedMailState: "unavailable" | "cache" | "synced" | "error";
  linkedMailError: string | null;
  linkedMail: Array<
    Pick<
      LifeOpsGmailMessageSummary,
      "id" | "subject" | "from" | "receivedAt" | "snippet" | "htmlLink"
    >
  >;
}

export interface LifeOpsCalendarEventUpdate {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  calendarId?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  /** Replaces timed bounds with one all-day civil-date interval. */
  allDay?: LifeOpsCalendarAllDayRange;
  timeZone?: string;
  notes?: string;
  location?: string;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
  /** Whether the provider may email attendees about the change. */
  notifyAttendees?: boolean;
  /** Provider ETag/version for an atomic conditional write. */
  expectedProviderVersion?: string;
  /** Replacement RFC 5545 recurrence lines. Series-level edits only. */
  recurrence?: string[];
  /**
   * When the target is part of a recurring series: `instance` patches only the
   * addressed occurrence, `this_and_following` safely splits at that
   * occurrence, and `series` patches the series master.
   */
  recurrenceScope?: LifeOpsCalendarRecurrenceScope;
  /** Stable owner-editor operation key used by the durable mutation ledger. */
  idempotencyKey?: string;
}

export interface LifeOpsCalendarEventMutationResult {
  event: LifeOpsCalendarEvent;
}

export type LifeOpsCalendarCancellationMode =
  | "organizer_cancel"
  | "decline_invitation"
  | "remove_private_copy";

/**
 * A DELETE-shaped editor request is not always destructive. Invitees decline
 * their invitation and retain an updated event snapshot; only organizers or
 * owners removing a private copy receive a deletion outcome.
 */
export type LifeOpsCalendarEventCancellationResult =
  | {
      outcome: "deleted";
      cancellationMode: Exclude<
        LifeOpsCalendarCancellationMode,
        "decline_invitation"
      >;
      event: null;
    }
  | {
      outcome: "invitation_declined";
      cancellationMode: "decline_invitation";
      event: LifeOpsCalendarEvent;
    };
