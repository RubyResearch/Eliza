/**
 * LifeOps Drizzle schema.
 *
 * Tables are placed in the `app_lifeops` PostgreSQL schema (matches the
 * `deriveSchemaName("@elizaos/plugin-personal-assistant")` result used by plugin-sql's
 * runtime migrator) so they no longer trip the
 * "Plugin table is using public schema" warning. The runtime migrator
 * issues `CREATE SCHEMA IF NOT EXISTS` automatically before applying
 * migrations.
 *
 * Tables and indexes are created and migrated via the elizaOS
 * plugin-migration system when the plugin's `schema` field is populated.
 *
 * IMPORTANT: All raw SQL inside this plugin's `src/` must qualify table
 * names with the `app_lifeops.` prefix. The bare `life_*` and `lifeops_*`
 * names no longer resolve in the default search path.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const appLifeopsPgSchema = pgSchema("app_lifeops");

// ---------------------------------------------------------------------------
// All life_* prefix, text IDs, ISO timestamps.
// ---------------------------------------------------------------------------

export const lifeConnectorGrants = appLifeopsPgSchema.table(
  "life_connector_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    connectorAccountId: text("connector_account_id"),
    side: text("side").notNull().default("owner"),
    identityJson: text("identity_json").notNull().default("{}"),
    identityEmail: text("identity_email"),
    grantedScopesJson: text("granted_scopes_json").notNull().default("[]"),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    tokenRef: text("token_ref"),
    mode: text("mode").notNull().default("oauth"),
    executionTarget: text("execution_target").notNull().default("local"),
    sourceOfTruth: text("source_of_truth").notNull().default("local_storage"),
    preferredByAgent: boolean("preferred_by_agent").notNull().default(false),
    cloudConnectionId: text("cloud_connection_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastRefreshAt: text("last_refresh_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.mode, t.identityEmail)],
);

/** Persists reviewed account handoffs and their resumable side-effect boundaries. */
export const lifeAccountHandoffs = appLifeopsPgSchema.table(
  "life_account_handoffs",
  {
    agentId: text("agent_id").notNull(),
    ownerEntityId: text("owner_entity_id").notNull(),
    operationId: text("operation_id").notNull(),
    revision: integer("revision").notNull().default(0),
    phase: text("phase").notNull().default("reviewed"),
    reviewJson: text("review_json").notNull(),
    receiptJson: text("receipt_json").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.ownerEntityId, t.operationId] }),
    uniqueIndex("life_account_handoffs_active_owner")
      .on(t.agentId, t.ownerEntityId)
      .where(sql`${t.phase} NOT IN ('completed', 'cancelled')`),
  ],
);

export const lifeAccountPrivacy = appLifeopsPgSchema.table(
  "life_account_privacy",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    allowedDataClassesJson: text("allowed_data_classes_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.connectorAccountId),
    index("idx_life_account_privacy_agent").on(t.agentId, t.provider),
  ],
);

export const lifeTaskDefinitions = appLifeopsPgSchema.table(
  "life_task_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    originalIntent: text("original_intent").notNull().default(""),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("active"),
    priority: integer("priority").notNull().default(3),
    cadenceJson: text("cadence_json").notNull().default("{}"),
    windowPolicyJson: text("window_policy_json").notNull().default("{}"),
    progressionRuleJson: text("progression_rule_json").notNull().default("{}"),
    checkInPolicyJson: text("check_in_policy_json"),
    websiteAccessJson: text("website_access_json"),
    reminderPlanId: text("reminder_plan_id"),
    goalId: text("goal_id"),
    source: text("source").notNull().default("manual"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_task_definitions_agent_status").on(t.agentId, t.status),
    index("idx_life_task_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
  ],
);

export const lifeTaskOccurrences = appLifeopsPgSchema.table(
  "life_task_occurrences",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    definitionId: text("definition_id").notNull(),
    occurrenceKey: text("occurrence_key").notNull(),
    scheduledAt: text("scheduled_at"),
    dueAt: text("due_at"),
    relevanceStartAt: text("relevance_start_at").notNull(),
    relevanceEndAt: text("relevance_end_at").notNull(),
    windowName: text("window_name"),
    state: text("state").notNull().default("pending"),
    snoozedUntil: text("snoozed_until"),
    completionPayloadJson: text("completion_payload_json"),
    derivedTargetJson: text("derived_target_json"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.definitionId, t.occurrenceKey),
    index("idx_life_task_occurrences_agent_state_start").on(
      t.agentId,
      t.state,
      t.relevanceStartAt,
    ),
    index("idx_life_task_occurrences_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.state,
      t.relevanceStartAt,
    ),
    index("idx_life_task_occurrences_definition").on(
      t.definitionId,
      t.relevanceStartAt,
    ),
  ],
);

/**
 * Append-only per-increment progress for count-quota occurrences. The
 * completed count is always derived by summing rows for an occurrence — it is
 * never cached on the occurrence row, so concurrent increments cannot clobber
 * each other through full-row occurrence upserts. The (agent, occurrence,
 * idempotency key) uniqueness makes replayed increments no-ops inside the
 * occurrence-locked append transaction.
 */
export const lifeTaskProgressEvents = appLifeopsPgSchema.table(
  "life_task_progress_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    definitionId: text("definition_id").notNull(),
    occurrenceId: text("occurrence_id").notNull(),
    localDateKey: text("local_date_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unit: text("unit").notNull(),
    note: text("note"),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.occurrenceId, t.idempotencyKey),
    index("idx_life_task_progress_events_occurrence").on(
      t.agentId,
      t.occurrenceId,
    ),
    index("idx_life_task_progress_events_definition_day").on(
      t.agentId,
      t.definitionId,
      t.localDateKey,
    ),
  ],
);

// NOTE: the goal tables (life_goal_definitions / life_goal_links) were carved
// out to @elizaos/plugin-goals (`app_goals`). These app_lifeops defs remain
// only as the non-destructive migration SOURCE — PA's repository (incl. the
// reminder/scheduling goal-link reads/writes) now targets the app_goals copies.
export const lifeGoalDefinitions = appLifeopsPgSchema.table(
  "life_goal_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    cadenceJson: text("cadence_json"),
    supportStrategyJson: text("support_strategy_json").notNull().default("{}"),
    successCriteriaJson: text("success_criteria_json").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    reviewState: text("review_state").notNull().default("pending"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_goal_definitions_agent_status").on(t.agentId, t.status),
    index("idx_life_goal_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
  ],
);

export const lifeGoalLinks = appLifeopsPgSchema.table(
  "life_goal_links",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    goalId: text("goal_id").notNull(),
    linkedType: text("linked_type").notNull(),
    linkedId: text("linked_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.goalId, t.linkedType, t.linkedId),
    index("idx_life_goal_links_goal").on(t.goalId),
    index("idx_life_goal_links_linked").on(t.linkedType, t.linkedId),
  ],
);

// NOTE: the reminder tables (life_reminder_plans / life_reminder_attempts /
// life_escalation_states) were carved out to @elizaos/plugin-reminders
// (`app_reminders`). These app_lifeops defs remain only as the non-destructive
// migration SOURCE — PA's repository now reads/writes the app_reminders copies.
export const lifeReminderPlans = appLifeopsPgSchema.table(
  "life_reminder_plans",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    stepsJson: text("steps_json").notNull().default("[]"),
    mutePolicyJson: text("mute_policy_json").notNull().default("{}"),
    quietHoursJson: text("quiet_hours_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_reminder_plans_owner").on(
      t.agentId,
      t.ownerType,
      t.ownerId,
    ),
  ],
);

export const lifeReminderAttempts = appLifeopsPgSchema.table(
  "life_reminder_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    planId: text("plan_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    occurrenceId: text("occurrence_id"),
    channel: text("channel").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    scheduledFor: text("scheduled_for").notNull(),
    attemptedAt: text("attempted_at"),
    outcome: text("outcome").notNull().default("pending"),
    connectorRef: text("connector_ref"),
    deliveryMetadataJson: text("delivery_metadata_json")
      .notNull()
      .default("{}"),
    reviewAt: text("review_at"),
    reviewStatus: text("review_status"),
    reviewClaimedAt: text("review_claimed_at"),
    reviewClaimedBy: text("review_claimed_by"),
    reviewAttemptCount: integer("review_attempt_count").notNull().default(0),
    reviewNextRetryAt: text("review_next_retry_at"),
    reviewLastError: text("review_last_error"),
  },
  (t) => [
    index("idx_life_reminder_attempts_plan").on(
      t.planId,
      t.ownerType,
      t.ownerId,
    ),
    index("idx_life_reminder_attempts_review_scan").on(
      t.agentId,
      t.outcome,
      t.reviewStatus,
      t.reviewAt,
    ),
  ],
);

export const lifeAuditEvents = appLifeopsPgSchema.table(
  "life_audit_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key"),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    reason: text("reason").notNull().default(""),
    inputsJson: text("inputs_json").notNull().default("{}"),
    decisionJson: text("decision_json").notNull().default("{}"),
    actor: text("actor").notNull().default("agent"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("uq_life_audit_events_operation").on(
      t.agentId,
      t.eventType,
      t.idempotencyKey,
    ),
    index("idx_life_audit_events_owner").on(
      t.agentId,
      t.ownerType,
      t.ownerId,
      t.createdAt,
    ),
  ],
);

export const lifeCommitmentLedger = appLifeopsPgSchema.table(
  "life_commitment_ledger",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    counterparty: text("counterparty"),
    dueAt: text("due_at"),
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("open"),
    scheduledTaskId: text("scheduled_task_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("uniq_life_commitment_source").on(
      t.agentId,
      t.source,
      t.sourceKey,
      t.kind,
      t.summary,
    ),
    index("idx_life_commitment_agent_status_due").on(
      t.agentId,
      t.status,
      t.dueAt,
    ),
    index("idx_life_commitment_source").on(t.agentId, t.source, t.sourceKey),
  ],
);

export const lifeDelegationContracts = appLifeopsPgSchema.table(
  "life_delegation_contracts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull().default("active"),
    objective: text("objective").notNull(),
    scopeJson: text("scope_json").notNull(),
    autonomyLevel: text("autonomy_level").notNull(),
    tripwiresJson: text("tripwires_json").notNull().default("[]"),
    ownerUserId: text("owner_user_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    slaJson: text("sla_json"),
    stateJson: text("state_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("idx_life_delegation_agent_status_expires").on(
      t.agentId,
      t.status,
      t.expiresAt,
    ),
  ],
);

// Finance tables (life_payment_*, life_subscription_*) moved to
// @elizaos/plugin-finances under pgSchema("app_finances"). PA no longer creates
// them in app_lifeops; the finances plugin owns + migrates them. PA's raw
// finance SQL (repository.ts) targets app_finances directly.

// Carved to @elizaos/plugin-inbox (`app_inbox`); kept here only as the
// non-destructive migration source. See the inbox-triage note further down.
export const lifeEmailUnsubscribes = appLifeopsPgSchema.table(
  "life_email_unsubscribes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderDisplay: text("sender_display").notNull().default(""),
    senderDomain: text("sender_domain"),
    listId: text("list_id"),
    method: text("method").notNull().default("manual_only"),
    status: text("status").notNull().default("failed"),
    httpStatusCode: integer("http_status_code"),
    httpFinalUrl: text("http_final_url"),
    filterCreated: boolean("filter_created").notNull().default(false),
    filterId: text("filter_id"),
    threadsTrashed: integer("threads_trashed").notNull().default(0),
    errorMessage: text("error_message"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeActivitySignals = appLifeopsPgSchema.table(
  "life_activity_signals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    platform: text("platform").notNull().default(""),
    state: text("state").notNull(),
    observedAt: text("observed_at").notNull(),
    idleState: text("idle_state"),
    idleTimeSeconds: integer("idle_time_seconds"),
    onBattery: boolean("on_battery"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_life_activity_signals_agent").on(t.agentId, t.observedAt)],
);

export const lifeHealthMetricSamples = appLifeopsPgSchema.table(
  "life_health_metric_samples",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    localDate: text("local_date").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(
      t.agentId,
      t.provider,
      t.grantId,
      t.metric,
      t.startAt,
      t.sourceExternalId,
    ),
    index("idx_life_health_metric_samples_agent_date").on(
      t.agentId,
      t.provider,
      t.localDate,
    ),
  ],
);

export const lifeHealthWorkouts = appLifeopsPgSchema.table(
  "life_health_workouts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    workoutType: text("workout_type").notNull(),
    title: text("title").notNull().default(""),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    distanceMeters: real("distance_meters"),
    calories: real("calories"),
    averageHeartRate: real("average_heart_rate"),
    maxHeartRate: real("max_heart_rate"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.grantId, t.sourceExternalId),
    index("idx_life_health_workouts_agent_start").on(
      t.agentId,
      t.provider,
      t.startAt,
    ),
  ],
);

export const lifeHealthSyncStates = appLifeopsPgSchema.table(
  "life_health_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    cursor: text("cursor"),
    lastSyncedAt: text("last_synced_at"),
    lastSyncStartedAt: text("last_sync_started_at"),
    lastSyncError: text("last_sync_error"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.grantId)],
);

export const lifeHealthSleepEpisodes = appLifeopsPgSchema.table(
  "life_health_sleep_episodes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone"),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    isMainSleep: boolean("is_main_sleep").notNull().default(false),
    sleepType: text("sleep_type"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    timeInBedSeconds: integer("time_in_bed_seconds"),
    efficiency: real("efficiency"),
    latencySeconds: integer("latency_seconds"),
    awakeSeconds: integer("awake_seconds"),
    lightSleepSeconds: integer("light_sleep_seconds"),
    deepSleepSeconds: integer("deep_sleep_seconds"),
    remSleepSeconds: integer("rem_sleep_seconds"),
    sleepScore: real("sleep_score"),
    readinessScore: real("readiness_score"),
    averageHeartRate: real("average_heart_rate"),
    lowestHeartRate: real("lowest_heart_rate"),
    averageHrvMs: real("average_hrv_ms"),
    respiratoryRate: real("respiratory_rate"),
    bloodOxygenPercent: real("blood_oxygen_percent"),
    stageSamplesJson: text("stage_samples_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.grantId, t.sourceExternalId),
    index("idx_life_health_sleep_episodes_agent_date").on(
      t.agentId,
      t.provider,
      t.localDate,
    ),
  ],
);

export const lifeChannelPolicies = appLifeopsPgSchema.table(
  "life_channel_policies",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    channelType: text("channel_type").notNull(),
    channelRef: text("channel_ref").notNull(),
    privacyClass: text("privacy_class").notNull().default("private"),
    allowReminders: boolean("allow_reminders").notNull().default(true),
    allowEscalation: boolean("allow_escalation").notNull().default(false),
    allowPosts: boolean("allow_posts").notNull().default(false),
    requireConfirmationForActions: boolean("require_confirmation_for_actions")
      .notNull()
      .default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.channelType, t.channelRef),
    index("idx_life_channel_policies_agent").on(t.agentId, t.channelType),
  ],
);

export const lifeWebsiteAccessGrants = appLifeopsPgSchema.table(
  "life_website_access_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    groupKey: text("group_key").notNull(),
    definitionId: text("definition_id").notNull(),
    occurrenceId: text("occurrence_id"),
    websitesJson: text("websites_json").notNull().default("[]"),
    unlockMode: text("unlock_mode").notNull().default("fixed_duration"),
    unlockDurationMinutes: integer("unlock_duration_minutes"),
    callbackKey: text("callback_key"),
    unlockedAt: text("unlocked_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_website_access_grants_group").on(
      t.agentId,
      t.groupKey,
      t.revokedAt,
      t.expiresAt,
    ),
  ],
);

// NOTE: the calendar tables (life_calendar_events / life_calendar_sync_states)
// were carved out to @elizaos/plugin-calendar (`app_calendar`). These
// app_lifeops defs remain only as the non-destructive migration SOURCE — PA's
// repository now reads/writes the app_calendar copies.
export const lifeCalendarEvents = appLifeopsPgSchema.table(
  "life_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    // New writes set connector_account_id from the owning account.
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
    unique().on(t.agentId, t.provider, t.side, t.calendarId, t.externalEventId),
  ],
);

export const lifeCalendarSyncStates = appLifeopsPgSchema.table(
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
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.calendarId)],
);

export const lifeGmailMessages = appLifeopsPgSchema.table(
  "life_gmail_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    externalMessageId: text("external_message_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    grantId: text("grant_id"),
    threadId: text("thread_id").notNull().default(""),
    subject: text("subject").notNull().default(""),
    fromDisplay: text("from_display").notNull().default(""),
    fromEmail: text("from_email"),
    replyTo: text("reply_to"),
    toJson: text("to_json").notNull().default("[]"),
    ccJson: text("cc_json").notNull().default("[]"),
    snippet: text("snippet").notNull().default(""),
    receivedAt: text("received_at").notNull(),
    isUnread: boolean("is_unread").notNull().default(true),
    isImportant: boolean("is_important").notNull().default(false),
    likelyReplyNeeded: boolean("likely_reply_needed").notNull().default(false),
    triageScore: integer("triage_score").notNull().default(0),
    triageReason: text("triage_reason").notNull().default(""),
    labelIdsJson: text("label_ids_json").notNull().default("[]"),
    htmlLink: text("html_link"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.side, t.grantId, t.externalMessageId),
  ],
);

export const lifeInboxMessages = appLifeopsPgSchema.table(
  "life_inbox_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    threadId: text("thread_id"),
    senderId: text("sender_id").notNull(),
    senderDisplay: text("sender_display").notNull(),
    senderEmail: text("sender_email"),
    subject: text("subject"),
    snippet: text("snippet").notNull().default(""),
    receivedAt: text("received_at").notNull(),
    isUnread: boolean("is_unread").notNull().default(true),
    deepLink: text("deep_link"),
    sourceRefJson: text("source_ref_json").notNull().default("{}"),
    chatType: text("chat_type").notNull().default("channel"),
    participantCount: integer("participant_count"),
    gmailAccountId: text("gmail_account_id"),
    gmailAccountEmail: text("gmail_account_email"),
    lastSeenAt: text("last_seen_at"),
    repliedAt: text("replied_at"),
    priorityScore: integer("priority_score"),
    priorityCategory: text("priority_category"),
    priorityFlagsJson: text("priority_flags_json").notNull().default("[]"),
    connectorAccountId: text("connector_account_id"),
    cachedAt: text("cached_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.channel, t.externalId),
    index("idx_life_inbox_messages_agent_received").on(t.agentId, t.receivedAt),
    index("idx_life_inbox_messages_agent_channel").on(t.agentId, t.channel),
  ],
);

export const lifeGmailSyncStates = appLifeopsPgSchema.table(
  "life_gmail_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    mailbox: text("mailbox").notNull(),
    grantId: text("grant_id"),
    maxResults: integer("max_results").notNull().default(0),
    historyId: text("history_id"),
    cursorStatus: text("cursor_status").notNull().default("seeded"),
    fullResyncReason: text("full_resync_reason"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.grantId, t.mailbox)],
);

export const lifeGmailSpamReviewItems = appLifeopsPgSchema.table(
  "life_gmail_spam_review_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    grantId: text("grant_id").notNull(),
    accountEmail: text("account_email"),
    messageId: text("message_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    fromDisplay: text("from_display").notNull().default(""),
    fromEmail: text("from_email"),
    receivedAt: text("received_at").notNull(),
    snippet: text("snippet").notNull().default(""),
    labelIdsJson: text("label_ids_json").notNull().default("[]"),
    rationale: text("rationale").notNull().default(""),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.side, t.grantId, t.externalMessageId),
    index("idx_life_gmail_spam_review_status").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const lifeWorkflowDefinitions = appLifeopsPgSchema.table(
  "life_workflow_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    title: text("title").notNull(),
    triggerType: text("trigger_type").notNull(),
    scheduleJson: text("schedule_json").notNull().default("{}"),
    actionPlanJson: text("action_plan_json").notNull().default("{}"),
    permissionPolicyJson: text("permission_policy_json")
      .notNull()
      .default("{}"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by").notNull().default("agent"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_workflow_definitions_agent").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
    index("idx_life_workflow_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const lifeWorkflowRuns = appLifeopsPgSchema.table(
  "life_workflow_runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").notNull().default("running"),
    resultJson: text("result_json").notNull().default("{}"),
    auditRef: text("audit_ref"),
  },
  (t) => [
    index("idx_life_workflow_runs_workflow").on(
      t.agentId,
      t.workflowId,
      t.startedAt,
    ),
  ],
);

// Workflow-bound browser session table. The 4 generic browser tables
// (companions, settings, tabs, page_contexts) moved to
// `@elizaos/plugin-browser/schema`. Only `life_workflow_browser_sessions`
// stays here because it carries `workflowId` plus LifeOps scoping columns.
// The `companionId` column is a soft FK to
// `browser_bridge_companions.id` (no hard constraint so the plugin package
// remains the schema owner of that table).
export const lifeWorkflowBrowserSessions = appLifeopsPgSchema.table(
  "life_workflow_browser_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    workflowId: text("workflow_id"),
    browser: text("browser"),
    companionId: text("companion_id"),
    profileId: text("profile_id"),
    windowId: text("window_id"),
    tabId: text("tab_id"),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("pending"),
    actionsJson: text("actions_json").notNull().default("[]"),
    currentActionIndex: integer("current_action_index").notNull().default(0),
    awaitingConfirmationForActionId: text(
      "awaiting_confirmation_for_action_id",
    ),
    resultJson: text("result_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("idx_life_workflow_browser_sessions_agent").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
    index("idx_life_workflow_browser_sessions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
      t.updatedAt,
    ),
  ],
);

/** Owner-scoped browser profile revocations survive extension reinstall and token rotation. */
export const lifeBrowserCompanionRevocations = appLifeopsPgSchema.table(
  "life_browser_companion_revocations",
  {
    agentId: text("agent_id").notNull(),
    ownerEntityId: text("owner_entity_id").notNull(),
    browser: text("browser").notNull(),
    profileId: text("profile_id").notNull(),
    companionId: text("companion_id").notNull(),
    revokedAt: text("revoked_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.agentId, t.ownerEntityId, t.browser, t.profileId],
    }),
    index("idx_life_browser_companion_revocations_companion").on(
      t.agentId,
      t.ownerEntityId,
      t.companionId,
    ),
  ],
);

export const lifeEscalationStates = appLifeopsPgSchema.table(
  "life_escalation_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    reason: text("reason").notNull().default(""),
    text: text("text").notNull().default(""),
    currentStep: integer("current_step").notNull().default(0),
    channelsSentJson: text("channels_sent_json").notNull().default("[]"),
    startedAt: text("started_at").notNull(),
    lastSentAt: text("last_sent_at").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: text("resolved_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_escalation_states_agent_resolved").on(
      t.agentId,
      t.resolved,
    ),
  ],
);

// NOTE: the inbox-triage tables (life_inbox_triage_entries /
// life_inbox_triage_examples) and life_email_unsubscribes (above) were carved
// out to @elizaos/plugin-inbox (`app_inbox`). These app_lifeops defs remain only
// as the non-destructive migration SOURCE — plugin-inbox's repositories now
// read/write the app_inbox copies. (The life_gmail_* / life_inbox_messages
// projection tables stay PA-owned — they are not part of the triage domain.)
export const lifeInboxTriageEntries = appLifeopsPgSchema.table(
  "life_inbox_triage_entries",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    sourceRoomId: text("source_room_id"),
    sourceEntityId: text("source_entity_id"),
    sourceMessageId: text("source_message_id"),
    channelName: text("channel_name").notNull(),
    channelType: text("channel_type").notNull(),
    deepLink: text("deep_link"),
    classification: text("classification").notNull(),
    urgency: text("urgency").notNull().default("low"),
    confidence: real("confidence").notNull().default(0.5),
    snippet: text("snippet").notNull().default(""),
    senderName: text("sender_name"),
    threadContext: text("thread_context"),
    triageReasoning: text("triage_reasoning"),
    suggestedResponse: text("suggested_response"),
    draftResponse: text("draft_response"),
    autoReplied: boolean("auto_replied").notNull().default(false),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeInboxTriageExamples = appLifeopsPgSchema.table(
  "life_inbox_triage_examples",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    snippet: text("snippet").notNull().default(""),
    classification: text("classification").notNull(),
    ownerAction: text("owner_action").notNull(),
    ownerClassification: text("owner_classification"),
    contextJson: text("context_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
);

export const lifeIntents = appLifeopsPgSchema.table("life_intents", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  targetDeviceId: text("target_device_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  actionUrl: text("action_url"),
  priority: text("priority").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  acknowledgedAt: text("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
  metadataJson: text("metadata_json"),
});

export const lifeCheckinReports = appLifeopsPgSchema.table(
  "life_checkin_reports",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    generatedAt: text("generated_at").notNull(),
    generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
    escalationLevel: integer("escalation_level").notNull(),
    payloadJson: text("payload_json").notNull(),
    acknowledgedAt: text("acknowledged_at"),
  },
);

export const lifeopsFeaturesTable = appLifeopsPgSchema.table(
  "lifeops_features",
  {
    featureKey: text("feature_key").primaryKey(),
    enabled: boolean("enabled").notNull(),
    source: text("source").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "date" }),
    enabledBy: uuid("enabled_by"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);

// Contacts (people) live in the runtime knowledge graph
// (`@elizaos/agent` KnowledgeGraphService: life_entities / life_entity_* /
// life_relationships_v2) — there is no flat `life_relationships` table.
// `life_relationship_interactions` below remains as the per-edge interaction
// audit log, keyed by the graph entityId.
export const lifeRelationshipInteractions = appLifeopsPgSchema.table(
  "life_relationship_interactions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id").notNull(),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(),
    summary: text("summary").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
);

// Knowledge graph tables (life_entities, life_entity_identities,
// life_entity_attributes, life_relationships_v2,
// life_relationship_audit_events) are now runtime-owned: their drizzle
// definitions + schema registration live in `@elizaos/agent`
// (`services/knowledge-graph/schema.ts`). They remain in the same
// `app_lifeops` Postgres schema — ownership moved, the physical tables did
// not. The DB-backed EntityStore / RelationshipStore are surfaced via the
// runtime `KnowledgeGraphService`.

export const lifeXDms = appLifeopsPgSchema.table(
  "life_x_dms",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    externalDmId: text("external_dm_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    senderHandle: text("sender_handle").notNull(),
    senderId: text("sender_id").notNull(),
    isInbound: boolean("is_inbound").notNull(),
    text: text("text").notNull(),
    receivedAt: text("received_at").notNull(),
    readAt: text("read_at"),
    repliedAt: text("replied_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.externalDmId)],
);

export const lifeXFeedItems = appLifeopsPgSchema.table(
  "life_x_feed_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    externalTweetId: text("external_tweet_id").notNull(),
    authorHandle: text("author_handle").notNull(),
    authorId: text("author_id").notNull(),
    text: text("text").notNull(),
    createdAtSource: text("created_at_source").notNull(),
    feedType: text("feed_type").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.externalTweetId, t.feedType)],
);

export const lifeXSyncStates = appLifeopsPgSchema.table(
  "life_x_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    feedType: text("feed_type").notNull(),
    lastCursor: text("last_cursor"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.feedType)],
);

export const lifeScreenTimeSessions = appLifeopsPgSchema.table(
  "life_screen_time_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    identifier: text("identifier").notNull(),
    displayName: text("display_name").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    isActive: boolean("is_active").notNull().default(false),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeScreenTimeDaily = appLifeopsPgSchema.table(
  "life_screen_time_daily",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    identifier: text("identifier").notNull(),
    date: text("date").notNull(),
    totalSeconds: integer("total_seconds").notNull().default(0),
    sessionCount: integer("session_count").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.source, t.identifier, t.date)],
);

export const lifeSleepEpisodes = appLifeopsPgSchema.table(
  "life_sleep_episodes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    source: text("source").notNull(),
    confidence: real("confidence").notNull().default(0),
    cycleType: text("cycle_type").notNull().default("unknown"),
    sealed: boolean("sealed").notNull().default(false),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.startAt),
    index("idx_life_sleep_episodes_agent_start").on(t.agentId, t.startAt),
    index("idx_life_sleep_episodes_agent_sealed").on(
      t.agentId,
      t.sealed,
      t.startAt,
    ),
  ],
);

/**
 * Canonical telemetry store. Replaces per-source tables (life_activity_signals,
 * life_activity_events, life_screen_time_*) with a single append-only event
 * store keyed by `(agentId, family, occurredAt)`. Payload shape is validated
 * at ingestion time against `LifeOpsTelemetryPayload` in shared contracts.
 *
 * Retention: 60 days for raw events, daily rollups retained indefinitely
 * (see `pruneTelemetryEvents` + `life_telemetry_rollup_daily` below).
 */
export const lifeTelemetryEvents = appLifeopsPgSchema.table(
  "life_telemetry_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    family: text("family").notNull(),
    occurredAt: text("occurred_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    /** Content hash used to dedupe at ingest time. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Snapshotted source reliability so historical analysis stays stable. */
    sourceReliability: real("source_reliability").notNull().default(0.5),
    /** Payload — must match the discriminated union shape for `family`. */
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.dedupeKey),
    index("idx_life_telemetry_agent_family_occurred").on(
      t.agentId,
      t.family,
      t.occurredAt,
    ),
    index("idx_life_telemetry_agent_occurred").on(t.agentId, t.occurredAt),
  ],
);

/**
 * Daily rollup of telemetry events per (agent, family, local_date). Retained
 * indefinitely so the scorer's 28-day regularity window and the longer-term
 * baseline query remain cheap even after raw events age out.
 */
export const lifeTelemetryRollupDaily = appLifeopsPgSchema.table(
  "life_telemetry_rollup_daily",
  {
    agentId: text("agent_id").notNull(),
    family: text("family").notNull(),
    localDate: text("local_date").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    lastObservedAt: text("last_observed_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.family, t.localDate)],
);

/**
 * Persisted canonical circadian state per agent. One-row-per-agent with a
 * history trail in the audit log (life_audit_events with ownerType
 * circadian_state). Boot rehydration reads this row and downgrades to
 * `unclear` if it's older than MAX_STATE_AGE_MS. Every scheduler tick that
 * produces a state update writes here.
 */
export const lifeCircadianStates = appLifeopsPgSchema.table(
  "life_circadian_states",
  {
    agentId: text("agent_id").primaryKey(),
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    enteredAt: text("entered_at").notNull(),
    sinceSleepDetectedAt: text("since_sleep_detected_at"),
    sinceWakeObservedAt: text("since_wake_observed_at"),
    sinceWakeConfirmedAt: text("since_wake_confirmed_at"),
    evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_circadian_states_updated").on(t.agentId, t.updatedAt),
  ],
);

export const lifeScheduleInsights = appLifeopsPgSchema.table(
  "life_schedule_insights",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    effectiveDayKey: text("effective_day_key").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    inferredAt: text("inferred_at").notNull(),
    // Canonical circadian state - default `unclear` so migrations on existing
    // rows succeed; new rows always write the real value from the scorer.
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    sleepStatus: text("sleep_status").notNull(),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    awakeProbabilityJson: text("awake_probability_json")
      .notNull()
      .default("{}"),
    regularityJson: text("regularity_json").notNull().default("{}"),
    baselineJson: text("baseline_json"),
    /**
     * Scorer rule firings that fed this insight, as a JSON array of
     * `LifeOpsCircadianRuleFiring`. Surfaced by the inspection UI so the
     * user can see exactly which rules drove the current state.
     */
    circadianRuleFiringsJson: text("circadian_rule_firings_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.effectiveDayKey)],
);

export const lifeScheduleObservations = appLifeopsPgSchema.table(
  "life_schedule_observations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    origin: text("origin").notNull(),
    deviceId: text("device_id").notNull(),
    deviceKind: text("device_kind").notNull(),
    timezone: text("timezone").notNull(),
    observedAt: text("observed_at").notNull(),
    windowStartAt: text("window_start_at").notNull(),
    windowEndAt: text("window_end_at"),
    // Default `unclear` so ADD COLUMN migrations succeed on tables with rows.
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    mealLabel: text("meal_label"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeScheduleMergedStates = appLifeopsPgSchema.table(
  "life_schedule_merged_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    scope: text("scope").notNull(),
    effectiveDayKey: text("effective_day_key").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    mergedAt: text("merged_at").notNull(),
    inferredAt: text("inferred_at").notNull(),
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    sleepStatus: text("sleep_status").notNull(),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    awakeProbabilityJson: text("awake_probability_json")
      .notNull()
      .default("{}"),
    regularityJson: text("regularity_json").notNull().default("{}"),
    baselineJson: text("baseline_json"),
    circadianRuleFiringsJson: text("circadian_rule_firings_json")
      .notNull()
      .default("[]"),
    observationCount: integer("observation_count").notNull().default(0),
    deviceCount: integer("device_count").notNull().default(0),
    contributingDeviceKindsJson: text("contributing_device_kinds_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.scope, t.timezone)],
);

export const lifeSchedulingNegotiations = appLifeopsPgSchema.table(
  "life_scheduling_negotiations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id"),
    subject: text("subject").notNull(),
    state: text("state").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    timezone: text("timezone").notNull(),
    acceptedProposalId: text("accepted_proposal_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    startedAt: text("started_at").notNull(),
    finalizedAt: text("finalized_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeSchedulingProposals = appLifeopsPgSchema.table(
  "life_scheduling_proposals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    negotiationId: text("negotiation_id").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    status: text("status").notNull(),
    proposedBy: text("proposed_by").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

/**
 * Durable evidence for approval-gated scheduling dispatch. The shared
 * `approval_requests` row remains the sole queue; this row records claims,
 * retries, ambiguous outcomes, and the provider receipt tied to that queue
 * entry so crashes cannot turn an unknown send into an automatic duplicate.
 */
export const lifeSchedulingDeliveryAttempts = appLifeopsPgSchema.table(
  "life_scheduling_delivery_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    approvalRequestId: text("approval_request_id").notNull(),
    negotiationId: text("negotiation_id").notNull(),
    proposalId: text("proposal_id"),
    contentSha256: text("content_sha256").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider"),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    receiptJson: text("receipt_json"),
    lastFailureJson: text("last_failure_json"),
    firstAttemptedAt: text("first_attempted_at"),
    lastAttemptedAt: text("last_attempted_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.approvalRequestId),
    unique().on(t.agentId, t.idempotencyKey),
    index("idx_life_scheduling_delivery_state").on(
      t.agentId,
      t.state,
      t.updatedAt,
    ),
  ],
);

/**
 * Durable ownership of approval-gated calendar mutations. A provider call is
 * claimed before execution and completed only with a source-bound receipt;
 * orphaned execution sessions become terminally ambiguous so restart recovery
 * cannot repeat an event create, update, or deletion.
 */
export const lifeCalendarMutationAttempts = appLifeopsPgSchema.table(
  "life_calendar_mutation_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    approvalRequestId: text("approval_request_id").notNull(),
    approvalSha256: text("approval_sha256").notNull(),
    operationKey: text("operation_key").notNull(),
    operation: text("operation").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    executorSessionId: text("executor_session_id"),
    claimToken: text("claim_token"),
    provider: text("provider"),
    sourceId: text("source_id"),
    calendarId: text("calendar_id"),
    eventId: text("event_id"),
    providerEventId: text("provider_event_id"),
    providerVersion: text("provider_version"),
    receiptJson: text("receipt_json"),
    lastFailureJson: text("last_failure_json"),
    firstAttemptedAt: text("first_attempted_at"),
    lastAttemptedAt: text("last_attempted_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.approvalRequestId),
    unique().on(t.agentId, t.operationKey),
    index("idx_life_calendar_mutation_state").on(
      t.agentId,
      t.state,
      t.updatedAt,
    ),
  ],
);

/**
 * Durable outbox for one grant-expiry watcher per household access grant.
 * Revocation records cancellation intent in the same transaction as access
 * removal; the shared scheduler tick retries materialization or dismissal
 * until the corresponding completion timestamp is committed.
 */
export const lifeHouseholdGrantExpiryWarningClaims = appLifeopsPgSchema.table(
  "life_household_grant_expiry_warning_claims",
  {
    agentId: text("agent_id").notNull(),
    grantId: text("grant_id").notNull(),
    attemptToken: text("attempt_token").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    scheduledTaskId: text("scheduled_task_id"),
    warningAt: text("warning_at"),
    expiresAt: text("expires_at"),
    cancelledAt: text("cancelled_at"),
    cancellationCompletedAt: text("cancellation_completed_at"),
    cancellationAttemptCount: integer("cancellation_attempt_count")
      .notNull()
      .default(0),
    cancellationLastError: text("cancellation_last_error"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.grantId] }),
    unique().on(t.agentId, t.scheduledTaskId),
    index("idx_life_household_warning_cancellation").on(
      t.agentId,
      t.cancelledAt,
      t.cancellationCompletedAt,
    ),
  ],
);

export const lifeHouseholdAccessGrants = appLifeopsPgSchema.table(
  "life_household_access_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull().default("household:default"),
    principalEntityId: text("principal_entity_id").notNull(),
    relationshipId: text("relationship_id"),
    role: text("role").notNull(),
    subjectEntityIdsJson: text("subject_entity_ids_json")
      .notNull()
      .default("[]"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    issuedByEntityId: text("issued_by_entity_id").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    revokedByEntityId: text("revoked_by_entity_id"),
    revocationReason: text("revocation_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_household_grants_principal").on(
      t.agentId,
      t.householdId,
      t.principalEntityId,
      t.updatedAt,
    ),
  ],
);

/** Immutable, content-addressed parenting-agreement versions. */
export const lifeHouseholdAgreementArtifacts = appLifeopsPgSchema.table(
  "life_household_agreement_artifacts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull(),
    agreementKey: text("agreement_key").notNull(),
    version: integer("version").notNull(),
    supersedesArtifactId: text("supersedes_artifact_id"),
    title: text("title").notNull(),
    originalFilename: text("original_filename").notNull(),
    documentId: text("document_id").notNull(),
    mediaUrl: text("media_url").notNull(),
    mediaFileName: text("media_file_name").notNull(),
    contentSha256: text("content_sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    pageCount: integer("page_count").notNull(),
    uploadedByEntityId: text("uploaded_by_entity_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("uq_household_agreement_version").on(
      t.agentId,
      t.householdId,
      t.agreementKey,
      t.version,
    ),
    unique("uq_household_agreement_content").on(
      t.agentId,
      t.householdId,
      t.agreementKey,
      t.contentSha256,
    ),
    unique("uq_household_agreement_document").on(t.agentId, t.documentId),
    index("idx_life_household_agreement_versions").on(
      t.agentId,
      t.householdId,
      t.agreementKey,
      t.version,
    ),
  ],
);

/** Owner-reviewed, page-cited obligations extracted from one exact version. */
export const lifeHouseholdAgreementObligations = appLifeopsPgSchema.table(
  "life_household_agreement_obligations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    title: text("title").notNull(),
    obligationText: text("obligation_text").notNull(),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end").notNull(),
    citationText: text("citation_text").notNull(),
    status: text("status").notNull().default("proposed"),
    proposedByEntityId: text("proposed_by_entity_id").notNull(),
    decidedByEntityId: text("decided_by_entity_id"),
    decisionReason: text("decision_reason"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_household_agreement_obligations").on(
      t.agentId,
      t.artifactId,
      t.status,
      t.createdAt,
    ),
  ],
);

/** Discovery pins; intentionally contains no principal or permission fields. */
export const lifeHouseholdKnowledgePins = appLifeopsPgSchema.table(
  "life_household_knowledge_pins",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    pinnedByEntityId: text("pinned_by_entity_id").notNull(),
    pinnedAt: text("pinned_at").notNull(),
    unpinnedAt: text("unpinned_at"),
  },
  (t) => [
    unique().on(t.agentId, t.artifactId, t.targetType, t.targetId),
    index("idx_life_household_knowledge_pins_target").on(
      t.agentId,
      t.targetType,
      t.targetId,
    ),
  ],
);

/** Resource binding layered over one exact, verified household guest grant. */
export const lifeHouseholdKnowledgeGrants = appLifeopsPgSchema.table(
  "life_household_knowledge_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    principalEntityId: text("principal_entity_id").notNull(),
    householdGrantId: text("household_grant_id").notNull(),
    issuedByEntityId: text("issued_by_entity_id").notNull(),
    revokedAt: text("revoked_at"),
    revokedByEntityId: text("revoked_by_entity_id"),
    revocationReason: text("revocation_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.artifactId, t.principalEntityId),
    index("idx_life_household_knowledge_grants_principal").on(
      t.agentId,
      t.householdId,
      t.principalEntityId,
      t.updatedAt,
    ),
  ],
);

export const lifeHouseholdCoordinationHeads = appLifeopsPgSchema.table(
  "life_household_coordination_heads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull().default("household:default"),
    coordinationId: text("coordination_id").notNull(),
    currentAgreementVersion: integer("current_agreement_version")
      .notNull()
      .default(0),
    currentAgreementId: text("current_agreement_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.householdId, t.coordinationId)],
);

export const lifeHouseholdScheduleProposals = appLifeopsPgSchema.table(
  "life_household_schedule_proposals",
  {
    rowId: text("row_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull().default("household:default"),
    proposalId: text("proposal_id").notNull(),
    version: integer("version").notNull(),
    coordinationId: text("coordination_id").notNull(),
    baseAgreementVersion: integer("base_agreement_version")
      .notNull()
      .default(0),
    termsJson: text("terms_json").notNull(),
    affectedPartyEntityIdsJson: text("affected_party_entity_ids_json")
      .notNull()
      .default("[]"),
    requiredApproverEntityIdsJson: text("required_approver_entity_ids_json")
      .notNull()
      .default("[]"),
    createdByEntityId: text("created_by_entity_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    status: text("status").notNull(),
    materialChange: boolean("material_change").notNull().default(true),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.proposalId, t.version),
    index("idx_life_household_proposals_coordination").on(
      t.agentId,
      t.householdId,
      t.coordinationId,
      t.createdAt,
    ),
  ],
);

export const lifeHouseholdProposalApprovals = appLifeopsPgSchema.table(
  "life_household_proposal_approvals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    partyEntityId: text("party_entity_id").notNull(),
    approvalRequestId: text("approval_request_id").notNull(),
    invalidatedAt: text("invalidated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.proposalId, t.proposalVersion, t.partyEntityId),
    index("idx_life_household_approvals_request").on(
      t.agentId,
      t.approvalRequestId,
    ),
  ],
);

/**
 * Replay-safe receipts for affected-party decisions received through a
 * connector-authenticated identity. Approval state remains in the shared
 * queue; this table proves which immutable provider message supplied the
 * decision and prevents a redelivered webhook from resolving anything twice.
 */
export const lifeHouseholdInboundApprovalReceipts = appLifeopsPgSchema.table(
  "life_household_inbound_approval_receipts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    partyEntityId: text("party_entity_id").notNull(),
    approvalRequestId: text("approval_request_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    decision: text("decision").notNull(),
    approvalState: text("approval_state").notNull(),
    receivedAt: text("received_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(
      t.agentId,
      t.provider,
      t.connectorAccountId,
      t.providerThreadId,
      t.providerMessageId,
    ),
    unique().on(t.agentId, t.approvalRequestId),
    index("idx_life_household_inbound_party").on(
      t.agentId,
      t.partyEntityId,
      t.receivedAt,
    ),
  ],
);

export const lifeHouseholdScheduleAgreements = appLifeopsPgSchema.table(
  "life_household_schedule_agreements",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    householdId: text("household_id").notNull().default("household:default"),
    coordinationId: text("coordination_id").notNull(),
    version: integer("version").notNull(),
    proposalId: text("proposal_id").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    termsJson: text("terms_json").notNull(),
    affectedPartyEntityIdsJson: text("affected_party_entity_ids_json")
      .notNull()
      .default("[]"),
    approvedByEntityIdsJson: text("approved_by_entity_ids_json")
      .notNull()
      .default("[]"),
    activatedAt: text("activated_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.householdId, t.coordinationId, t.version),
    unique().on(t.agentId, t.proposalId, t.proposalVersion),
  ],
);

// T8d — Activity tracker (WakaTime-like).
// Append-only per-event log produced by the macOS Swift collector.
export const lifeActivityEvents = appLifeopsPgSchema.table(
  "life_activity_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    observedAt: text("observed_at").notNull(),
    eventKind: text("event_kind").notNull(),
    bundleId: text("bundle_id").notNull(),
    appName: text("app_name").notNull(),
    windowTitle: text("window_title"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
);

// T7g — Website blocker chat integration (plan §6.8).
// Stores block rules whose lifecycle is driven by task item completion, fixed
// duration, or an explicit ISO target. The reconciler releases rules when
// their gate is fulfilled; harsh_no_bypass rules can only be released by the
// reconciler on gate fulfillment (never by the user).
export const lifeBlockRules = appLifeopsPgSchema.table("life_block_rules", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  profile: text("profile").notNull(),
  websites: jsonb("websites").notNull(),
  gateType: text("gate_type").notNull(),
  gateTodoId: text("gate_todo_id"),
  gateUntilMs: bigint("gate_until_ms", { mode: "number" }),
  fixedDurationMs: bigint("fixed_duration_ms", { mode: "number" }),
  unlockDurationMs: bigint("unlock_duration_ms", { mode: "number" }),
  active: boolean("active").default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  releasedAt: bigint("released_at", { mode: "number" }),
  releasedReason: text("released_reason"),
});

// ScheduledTask spine + state log migration source.
//
// plugin-scheduling now owns the physical ScheduledTask tables in
// `app_scheduling`. These `app_lifeops` definitions remain as the
// non-destructive migration source for existing installs.

export const lifeScheduledTasks = appLifeopsPgSchema.table(
  "life_scheduled_tasks",
  {
    // The tenant-owned composite primary key (agent_id, id) is declared in the
    // table config below and must match plugin-scheduling's migration
    // (ensureTenantOwnedTaskPrimaryKey); a single-column PK here lets tests
    // pass against a shape the migrated live table does not have.
    id: text("id").notNull(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    promptInstructions: text("prompt_instructions").notNull(),
    contextRequestJson: text("context_request_json"),
    triggerJson: text("trigger_json").notNull(),
    priority: text("priority").notNull().default("medium"),
    shouldFireJson: text("should_fire_json"),
    completionCheckJson: text("completion_check_json"),
    escalationJson: text("escalation_json"),
    outputJson: text("output_json"),
    pipelineJson: text("pipeline_json"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key"),
    respectsGlobalPause: boolean("respects_global_pause")
      .notNull()
      .default(true),
    stateJson: text("state_json").notNull().default("{}"),
    source: text("source").notNull().default("user_chat"),
    createdBy: text("created_by").notNull().default(""),
    ownerVisible: boolean("owner_visible").notNull().default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    // Optimistic concurrency version. Incremented on each update.
    // Used by withTransaction-wrapped operations to detect concurrent updates
    // and surface OptimisticLockError instead of silently overwriting.
    version: integer("version").notNull().default(1),
    // Indexed earliest-next-fire timestamp. Computed by the runner on each
    // mutation that changes the firing window (schedule, fire, snooze, edit)
    // for `cron` / `interval` / `relative_to_anchor` / `during_window` /
    // `once` triggers. NULL for `event`, `manual`, and `after_task` triggers
    // (those wake on signal, not on a wall-clock time). The scheduler tick
    // filters by this column instead of loading every row.
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.id] }),
    unique().on(t.agentId, t.idempotencyKey),
    index("idx_life_scheduled_tasks_agent_kind").on(t.agentId, t.kind),
    index("idx_life_scheduled_tasks_subject").on(
      t.agentId,
      t.subjectKind,
      t.subjectId,
    ),
    // Partial index supporting the per-tick due-task scan: every status
    // except `dismissed`, ordered by next fire-at time. Live rows
    // (`scheduled` / `fired`) are the primary tick slice; the remaining
    // statuses (`acknowledged` + terminal) are in the predicate because
    // RECURRING tasks parked there keep a trigger-derived `next_fire_at` and
    // must resurface at their next occurrence (recurrence refire). Settled
    // non-recurring rows carry `next_fire_at = NULL` and never match the
    // tick's `next_fire_at <= now` refire scan.
    index("idx_life_scheduled_tasks_due")
      .on(t.agentId, t.nextFireAt)
      .where(
        sql`(state_json::jsonb ->> 'status') IN ('scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed')`,
      ),
  ],
);

export const lifeScheduledTaskLog = appLifeopsPgSchema.table(
  "life_scheduled_task_log",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    transition: text("transition").notNull(),
    reason: text("reason"),
    rolledUp: boolean("rolled_up").notNull().default(false),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("idx_life_scheduled_task_log_agent_task").on(t.agentId, t.taskId),
    index("idx_life_scheduled_task_log_agent_time").on(t.agentId, t.occurredAt),
  ],
);

// Work-thread coordination index. Threads are not schedulers; they point at
// ScheduledTask/workflow/approval/pending-prompt state that owns durable work.

export const lifeWorkThreads = appLifeopsPgSchema.table(
  "life_work_threads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerEntityId: text("owner_entity_id"),
    status: text("status").notNull().default("active"),
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    currentPlanSummary: text("current_plan_summary"),
    primarySourceRefJson: text("primary_source_ref_json").notNull(),
    sourceRefsJson: text("source_refs_json").notNull().default("[]"),
    participantEntityIdsJson: text("participant_entity_ids_json")
      .notNull()
      .default("[]"),
    currentScheduledTaskId: text("current_scheduled_task_id"),
    workflowRunId: text("workflow_run_id"),
    approvalId: text("approval_id"),
    lastMessageMemoryId: text("last_message_memory_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    // Optimistic concurrency version. Incremented on each update.
    // Used by withTransaction-wrapped operations to detect concurrent updates
    // (e.g., two simultaneous merges) and surface OptimisticLockError instead
    // of silently overwriting one merge's sourceRefs with the other.
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (t) => [
    index("idx_life_work_threads_agent_status").on(t.agentId, t.status),
    index("idx_life_work_threads_agent_owner").on(
      t.agentId,
      t.ownerEntityId,
      t.status,
    ),
    index("idx_life_work_threads_agent_activity").on(
      t.agentId,
      t.lastActivityAt,
    ),
  ],
);

export const lifeWorkThreadEvents = appLifeopsPgSchema.table(
  "life_work_thread_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    workThreadId: text("work_thread_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    type: text("type").notNull(),
    reason: text("reason"),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("idx_life_work_thread_events_thread").on(
      t.agentId,
      t.workThreadId,
      t.occurredAt,
    ),
  ],
);

export const lifeBriefItemEngagements = appLifeopsPgSchema.table(
  "life_brief_item_engagements",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    briefingId: text("briefing_id").notNull(),
    itemId: text("item_id").notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    itemClass: text("item_class").notNull(),
    eventType: text("event_type").notNull(),
    eventAt: text("event_at").notNull(),
    weight: real("weight").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_life_brief_item_engagements_item").on(
      t.agentId,
      t.itemId,
      t.eventAt,
    ),
    index("idx_life_brief_item_engagements_class").on(
      t.agentId,
      t.itemClass,
      t.eventAt,
    ),
    index("idx_life_brief_item_engagements_brief").on(t.agentId, t.briefingId),
    index("idx_life_brief_item_engagements_reward_queue").on(
      t.agentId,
      t.eventType,
      t.eventAt,
      t.createdAt,
    ),
    index("idx_life_brief_item_engagements_reward_receipt")
      .on(
        t.agentId,
        sql`(${t.metadataJson}::jsonb ->> 'engagementEventId')`,
        t.createdAt,
      )
      .where(sql`${t.eventType} = 'rewarded'`),
    index("idx_life_brief_item_engagements_reward_retry_order").on(
      t.agentId,
      t.eventType,
      t.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Aggregate export for plugin schema property
// ---------------------------------------------------------------------------

export const lifeOpsSchema = {
  lifeAccountHandoffs,
  lifeConnectorGrants,
  lifeAccountPrivacy,
  lifeTaskDefinitions,
  lifeTaskOccurrences,
  lifeTaskProgressEvents,
  lifeGoalDefinitions,
  lifeGoalLinks,
  lifeReminderPlans,
  lifeReminderAttempts,
  lifeAuditEvents,
  lifeCommitmentLedger,
  lifeDelegationContracts,
  lifeEmailUnsubscribes,
  lifeActivitySignals,
  lifeHealthMetricSamples,
  lifeHealthWorkouts,
  lifeHealthSyncStates,
  lifeHealthSleepEpisodes,
  lifeChannelPolicies,
  lifeWebsiteAccessGrants,
  lifeCalendarEvents,
  lifeCalendarSyncStates,
  lifeGmailMessages,
  lifeInboxMessages,
  lifeGmailSyncStates,
  lifeGmailSpamReviewItems,
  lifeWorkflowDefinitions,
  lifeWorkflowRuns,
  lifeWorkflowBrowserSessions,
  lifeBrowserCompanionRevocations,
  lifeEscalationStates,
  lifeIntents,
  lifeCheckinReports,
  lifeRelationshipInteractions,
  // life_entities / life_entity_* / life_relationships_v2 /
  // life_relationship_audit_events are now owned by the runtime
  // (`@elizaos/agent` KnowledgeGraphService schema) — registered there,
  // not here, to avoid double-registration of the same app_lifeops tables.
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
  lifeXDms,
  lifeXFeedItems,
  lifeXSyncStates,
  lifeScreenTimeSessions,
  lifeScreenTimeDaily,
  lifeSleepEpisodes,
  lifeCircadianStates,
  lifeTelemetryEvents,
  lifeTelemetryRollupDaily,
  lifeScheduleInsights,
  lifeScheduleObservations,
  lifeScheduleMergedStates,
  lifeActivityEvents,
  lifeSchedulingNegotiations,
  lifeSchedulingProposals,
  lifeSchedulingDeliveryAttempts,
  lifeCalendarMutationAttempts,
  lifeHouseholdGrantExpiryWarningClaims,
  lifeHouseholdAccessGrants,
  lifeHouseholdAgreementArtifacts,
  lifeHouseholdAgreementObligations,
  lifeHouseholdKnowledgePins,
  lifeHouseholdKnowledgeGrants,
  lifeHouseholdCoordinationHeads,
  lifeHouseholdScheduleProposals,
  lifeHouseholdProposalApprovals,
  lifeHouseholdInboundApprovalReceipts,
  lifeHouseholdScheduleAgreements,
  lifeBlockRules,
  lifeWorkThreads,
  lifeWorkThreadEvents,
  lifeBriefItemEngagements,
  lifeopsFeaturesTable,
} as const;

// Zod validators for `ScheduledTask` now live in `@elizaos/plugin-scheduling`
// (the always-loaded scheduling spine), which owns the generic ScheduledTask
// REST boundary. Re-exported here so existing PA importers keep their path.
export {
  scheduledTaskFilterSchema,
  scheduledTaskInputSchema,
  scheduledTaskSchema,
  scheduledTaskSnoozePayloadSchema,
  scheduledTaskStateSchema,
  scheduledTaskVerbSchema,
} from "@elizaos/plugin-scheduling";
