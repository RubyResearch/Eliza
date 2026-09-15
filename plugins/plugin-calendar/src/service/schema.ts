/**
 * Calendar Drizzle schema.
 *
 * The calendar tables (`life_calendar_events`, `life_calendar_sync_states`,
 * `life_calendar_sources`, `life_calendar_feed_preferences`)
 * were carved out of `@elizaos/plugin-personal-assistant`'s `app_lifeops`
 * schema into `app_calendar`, owned by this plugin. Table + column names are
 * preserved verbatim so the non-destructive `CalendarMigrationService` can copy
 * existing `app_lifeops` rows across on first boot. Do not rename the tables or
 * columns without updating that migration.
 *
 * Raw SQL in this package must qualify table names with the `app_calendar.`
 * prefix; the bare `life_*` names do not resolve in the default search path.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";

export const calendarPgSchema = pgSchema("app_calendar");

export const calendarEvents = calendarPgSchema.table(
  "life_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    purgeResyncRequired: boolean("purge_resync_required")
      .notNull()
      .default(false),
    purgeResyncReason: text("purge_resync_reason"),
    grantId: text("grant_id"),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    status: text("status").notNull().default(""),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    isAllDay: boolean("is_all_day").notNull().default(false),
    timezone: text("timezone"),
    htmlLink: text("html_link"),
    conferenceLink: text("conference_link"),
    organizerJson: text("organizer_json"),
    attendeesJson: text("attendees_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("calendar_events_source_external_unique").on(
      t.agentId,
      t.provider,
      t.side,
      t.grantId,
      t.calendarId,
      t.externalEventId,
    ),
  ],
);

export const calendarSyncStates = calendarPgSchema.table(
  "life_calendar_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    grantId: text("grant_id"),
    purgeResyncRequired: boolean("purge_resync_required")
      .notNull()
      .default(false),
    purgeResyncReason: text("purge_resync_reason"),
    windowStartAt: text("window_start_at").notNull(),
    windowEndAt: text("window_end_at").notNull(),
    nextSyncToken: text("next_sync_token"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("calendar_sync_states_source_unique").on(
      t.agentId,
      t.provider,
      t.side,
      t.grantId,
      t.calendarId,
    ),
  ],
);

export const calendarSources = calendarPgSchema.table(
  "life_calendar_sources",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("ics"),
    side: text("side").notNull().default("owner"),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    secretRef: text("secret_ref").notNull(),
    urlFingerprint: text("url_fingerprint").notNull(),
    origin: text("origin").notNull(),
    etag: text("etag"),
    lastModified: text("last_modified"),
    contentHash: text("content_hash"),
    syncStatus: text("sync_status").notNull().default("never"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorRetryable: boolean("last_error_retryable"),
    lastSyncedAt: text("last_synced_at"),
    lastAttemptedAt: text("last_attempted_at"),
    syncGeneration: integer("sync_generation").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("calendar_sources_agent_fingerprint_unique").on(
      t.agentId,
      t.urlFingerprint,
    ),
  ],
);

export const calendarSecretCleanup = calendarPgSchema.table(
  "life_calendar_secret_cleanup",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sourceId: text("source_id").notNull(),
    secretRef: text("secret_ref").notNull(),
    reason: text("reason").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("calendar_secret_cleanup_agent_ref_unique").on(
      t.agentId,
      t.secretRef,
    ),
    index("calendar_secret_cleanup_drain_idx").on(t.agentId, t.createdAt, t.id),
  ],
);

export const calendarFeedPreferences = calendarPgSchema.table(
  "life_calendar_feed_preferences",
  {
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    side: text("side").notNull(),
    grantId: text("grant_id").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    included: boolean("included").notNull().default(true),
    version: integer("version").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      name: "calendar_feed_preferences_source_pk",
      columns: [
        t.agentId,
        t.provider,
        t.side,
        t.grantId,
        t.connectorAccountId,
        t.calendarId,
      ],
    }),
    check(
      "calendar_feed_preferences_version_nonnegative",
      sql`${t.version} >= 0`,
    ),
  ],
);

export const googleCalendarWatchChannels = calendarPgSchema.table(
  "google_calendar_watch_channels",
  {
    channelId: text("channel_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    grantId: text("grant_id").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    side: text("side").notNull(),
    calendarId: text("calendar_id").notNull(),
    calendarSummary: text("calendar_summary").notNull(),
    calendarAccessRole: text("calendar_access_role").notNull(),
    timeZone: text("time_zone").notNull(),
    windowStartAt: text("window_start_at").notNull(),
    windowEndAt: text("window_end_at").notNull(),
    webhookUrl: text("webhook_url").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    resourceId: text("resource_id"),
    resourceUri: text("resource_uri"),
    expirationAt: text("expiration_at"),
    state: text("state").notNull(),
    lastMessageNumber: text("last_message_number").notNull().default("0"),
    pendingMessageNumber: text("pending_message_number"),
    lastNotificationAt: text("last_notification_at"),
    lastSyncAt: text("last_sync_at"),
    syncLeaseToken: text("sync_lease_token"),
    syncLeaseExpiresAt: text("sync_lease_expires_at"),
    renewalChannelId: text("renewal_channel_id"),
    failureCount: integer("failure_count").notNull().default(0),
    nextRetryAt: text("next_retry_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorRetryable: boolean("last_error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("calendar_watch_binding_idx").on(
      t.agentId,
      t.connectorAccountId,
      t.grantId,
      t.calendarId,
    ),
    index("calendar_watch_maintenance_idx").on(
      t.agentId,
      t.state,
      t.expirationAt,
    ),
  ],
);

/** Durable identity and reconciliation checkpoint for an Eliza event linked to Google. */
export const linkedCalendarEvents = calendarPgSchema.table(
  "linked_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    localEventId: text("local_event_id").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    providerCalendarId: text("provider_calendar_id").notNull(),
    providerEventId: text("provider_event_id"),
    providerEtag: text("provider_etag"),
    localRevision: integer("local_revision").notNull().default(0),
    lastCommonSemanticHash: text("last_common_semantic_hash"),
    state: text("state").notNull().default("dirty"),
    pendingOperation: text("pending_operation"),
    idempotencyKey: text("idempotency_key").notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("linked_calendar_events_local_unique").on(t.agentId, t.localEventId),
    unique("linked_calendar_events_provider_unique").on(
      t.agentId,
      t.connectorAccountId,
      t.providerCalendarId,
      t.providerEventId,
    ),
    index("linked_calendar_events_reconcile_idx").on(
      t.agentId,
      t.state,
      t.updatedAt,
    ),
  ],
);

export const linkedCalendarControl = calendarPgSchema.table(
  "linked_calendar_control",
  {
    agentId: text("agent_id").primaryKey(),
    revision: integer("revision").notNull().default(0),
    paused: boolean("paused").notNull().default(true),
    connectorAccountId: text("connector_account_id"),
    providerCalendarId: text("provider_calendar_id"),
    dispatchToken: text("dispatch_token"),
    dispatchLinkId: text("dispatch_link_id"),
  },
  (t) => [
    check("linked_calendar_control_revision_valid", sql`${t.revision} >= 0`),
    check(
      "linked_calendar_control_dispatch_valid",
      sql`
      (${t.dispatchToken} IS NULL AND ${t.dispatchLinkId} IS NULL) OR
      (${t.dispatchToken} IS NOT NULL AND length(${t.dispatchToken}) > 0
        AND ${t.dispatchLinkId} IS NOT NULL AND length(${t.dispatchLinkId}) > 0
        AND ${t.connectorAccountId} IS NOT NULL)`,
    ),
    check(
      "linked_calendar_control_destination_valid",
      sql`
      (${t.connectorAccountId} IS NULL AND ${t.providerCalendarId} IS NULL AND ${t.paused})
      OR (${t.connectorAccountId} IS NOT NULL AND length(trim(${t.connectorAccountId})) > 0
        AND ${t.providerCalendarId} IS NOT NULL AND length(trim(${t.providerCalendarId})) > 0)`,
    ),
  ],
);

export const linkedCalendarControlMutations = calendarPgSchema.table(
  "linked_calendar_control_mutations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    operationKey: text("operation_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    committedAt: text("committed_at").notNull(),
  },
  (t) => [
    unique("linked_calendar_control_mutations_operation_unique").on(
      t.agentId,
      t.operationKey,
    ),
  ],
);

export const calendarSchema = {
  calendarEvents,
  calendarSyncStates,
  calendarSources,
  calendarSecretCleanup,
  calendarFeedPreferences,
  googleCalendarWatchChannels,
  linkedCalendarEvents,
  linkedCalendarControl,
  linkedCalendarControlMutations,
};
