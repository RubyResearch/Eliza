/**
 * Non-destructive data migration for the calendar tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The two legacy calendar tables (`life_calendar_events`,
 * `life_calendar_sync_states`)
 * used to live in the `app_lifeops` PostgreSQL schema, created by
 * plugin-personal-assistant. They now live in `app_calendar`, created by this
 * plugin's drizzle schema. Existing installs still hold the owner's calendar
 * rows in `app_lifeops`, so on first boot we copy them across — once,
 * idempotently, and WITHOUT ever touching the source.
 *
 * Existing completion markers and populated owner tables remain authoritative.
 * Fresh imports normalize source identities and verify the complete projection
 * before recording completion. Calendar-native schema repairs run independently
 * of whether a legacy import is authorized.
 *
 * The source table is NEVER dropped or altered. Copies name the shared columns
 * explicitly so the calendar-owned target can add sync metadata without
 * making older personal-assistant source tables unreadable.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  assertCarveOutProjectionComplete,
  type CarveOutDatabase,
  createDrizzleCarveOutDatabase,
  runCarveOutMigration,
} from "@elizaos/plugin-sql";

export const CALENDAR_MIGRATION_LOG_PREFIX = "[Calendar]";
export const CALENDAR_MIGRATION_SERVICE_TYPE = "calendar_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_calendar";

export const MIGRATED_CALENDAR_TABLES = [
  "life_calendar_events",
  "life_calendar_sync_states",
] as const;

export type MigratedCalendarTable = (typeof MIGRATED_CALENDAR_TABLES)[number];

export const MIGRATED_CALENDAR_COLUMNS: Record<
  MigratedCalendarTable,
  readonly string[]
> = {
  life_calendar_events: [
    "id",
    "agent_id",
    "provider",
    "side",
    "calendar_id",
    "external_event_id",
    "connector_account_id",
    "purge_resync_required",
    "purge_resync_reason",
    "grant_id",
    "title",
    "description",
    "location",
    "status",
    "start_at",
    "end_at",
    "is_all_day",
    "timezone",
    "html_link",
    "conference_link",
    "organizer_json",
    "attendees_json",
    "metadata_json",
    "synced_at",
    "updated_at",
  ],
  life_calendar_sync_states: [
    "id",
    "agent_id",
    "provider",
    "side",
    "calendar_id",
    "connector_account_id",
    "grant_id",
    "purge_resync_required",
    "purge_resync_reason",
    "window_start_at",
    "window_end_at",
    "synced_at",
    "updated_at",
  ],
};

const SOURCE_COLUMN_FALLBACKS: Readonly<Record<string, string>> = {
  connector_account_id: "NULL",
  grant_id: "NULL",
  purge_resync_required: "FALSE",
  purge_resync_reason: "NULL",
};

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedCalendarTable;
  outcome:
    | "copied"
    | "source-missing"
    | "target-non-empty"
    | "already-migrated";
}

/**
 * Upgrades the original calendar-only uniqueness to full source identity.
 * Every Google account exposes a `primary` calendar, so omitting the grant
 * lets one account overwrite another even though both reads succeeded.
 */
export async function ensureCalendarSourceIdentity(
  exec: SqlExecutor,
): Promise<void> {
  for (const table of MIGRATED_CALENDAR_TABLES) {
    await ensureCalendarTableSourceIdentity(exec, table);
  }
}

function canonicalGrant(column: string, alternate: string): string {
  return `COALESCE(${column}, ${alternate}, CASE
    WHEN provider = 'apple_calendar' THEN 'apple-calendar'
    ELSE 'legacy:' || provider || ':' || side
  END)`;
}

async function ensureCalendarTableSourceIdentity(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<void> {
  await exec(`
    UPDATE ${TARGET_SCHEMA}.${quoteIdent(table)}
       SET grant_id = ${canonicalGrant("grant_id", "connector_account_id")},
           connector_account_id = ${canonicalGrant("connector_account_id", "grant_id")}
     WHERE grant_id IS NULL OR connector_account_id IS NULL`);
  if (table === "life_calendar_events") {
    await exec(`
    DO $calendar_source_identity$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT c.conname
          FROM pg_constraint AS c
         WHERE c.conrelid = '${TARGET_SCHEMA}.life_calendar_events'::regclass
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) LIKE
             'UNIQUE (agent_id, provider, side, calendar_id, external_event_id)%'
      LOOP
        EXECUTE format(
          'ALTER TABLE ${TARGET_SCHEMA}.life_calendar_events DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = '${TARGET_SCHEMA}.life_calendar_events'::regclass
           AND conname = 'calendar_events_source_external_unique'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_events
          ADD CONSTRAINT calendar_events_source_external_unique
          UNIQUE (
            agent_id, provider, side, grant_id, calendar_id, external_event_id
          );
      END IF;
    END
    $calendar_source_identity$`);

    return;
  }
  await exec(`
    ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states
      ADD COLUMN IF NOT EXISTS next_sync_token TEXT`);
  await exec(`
    UPDATE ${TARGET_SCHEMA}.life_calendar_sync_states
       SET id = agent_id || ':' || provider || ':' || side || ':grant:' ||
                grant_id || ':calendar:' || calendar_id`);
  await exec(`
    DO $calendar_sync_source_identity$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT c.conname
          FROM pg_constraint AS c
         WHERE c.conrelid = '${TARGET_SCHEMA}.life_calendar_sync_states'::regclass
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) LIKE
             'UNIQUE (agent_id, provider, side, calendar_id)%'
      LOOP
        EXECUTE format(
          'ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = '${TARGET_SCHEMA}.life_calendar_sync_states'::regclass
           AND conname = 'calendar_sync_states_source_unique'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states
          ADD CONSTRAINT calendar_sync_states_source_unique
          UNIQUE (agent_id, provider, side, grant_id, calendar_id);
      END IF;
    END
    $calendar_sync_source_identity$`);
}

/**
 * Subscription sources never existed in the legacy LifeOps schema. Creating
 * their table here as well as in Drizzle keeps direct migration callers and
 * older plugin-sql boot orders safe without adding it to the legacy copy set.
 */
export async function ensureIcsCalendarSourceTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_sources (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ics',
      side TEXT NOT NULL DEFAULT 'owner',
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      secret_ref TEXT NOT NULL,
      url_fingerprint TEXT NOT NULL,
      origin TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      content_hash TEXT,
      sync_status TEXT NOT NULL DEFAULT 'never',
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_retryable BOOLEAN,
      last_synced_at TEXT,
      last_attempted_at TEXT,
      sync_generation INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_sources_agent_fingerprint_unique
        UNIQUE (agent_id, url_fingerprint)
    )`);
}

/**
 * Secret cleanup is an outbox owned by the calendar database. Rotation and
 * source deletion enqueue an opaque vault reference in the same statement as
 * the source mutation, so a vault outage cannot permanently orphan a URL.
 */
export async function ensureIcsSecretCleanupTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_secret_cleanup (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_secret_cleanup_agent_ref_unique
        UNIQUE (agent_id, secret_ref)
    )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_secret_cleanup_drain_idx
      ON ${TARGET_SCHEMA}.life_calendar_secret_cleanup (
        agent_id, created_at, id
      )`);
}

/**
 * Feed selection is an independently versioned row per exact source. The
 * composite primary key is the concurrency boundary: provider, side, grant,
 * account, and calendar identifiers are never collapsed into a delimiter key.
 */
export async function ensureCalendarFeedPreferenceTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_feed_preferences (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      connector_account_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      included BOOLEAN NOT NULL DEFAULT TRUE,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_feed_preferences_source_pk PRIMARY KEY (
        agent_id,
        provider,
        side,
        grant_id,
        connector_account_id,
        calendar_id
      ),
      CONSTRAINT calendar_feed_preferences_version_nonnegative
        CHECK (version >= 0)
    )`);
  await exec(`
    DO $calendar_feed_preference_version$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid =
               '${TARGET_SCHEMA}.life_calendar_feed_preferences'::regclass
           AND conname =
               'calendar_feed_preferences_version_nonnegative'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_feed_preferences
          ADD CONSTRAINT calendar_feed_preferences_version_nonnegative
          CHECK (version >= 0);
      END IF;
    END
    $calendar_feed_preference_version$`);
}

/** Bootstraps the agent's explicit calendar destination and pause decision. */
export async function ensureLinkedCalendarControlTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.linked_calendar_control (
    agent_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CONSTRAINT linked_calendar_control_revision_valid CHECK (revision >= 0),
    paused BOOLEAN NOT NULL DEFAULT TRUE,
    connector_account_id TEXT,
    provider_calendar_id TEXT,
    dispatch_token TEXT,
    dispatch_link_id TEXT,
    CONSTRAINT linked_calendar_control_dispatch_valid CHECK (
      (dispatch_token IS NULL AND dispatch_link_id IS NULL) OR
      (dispatch_token IS NOT NULL AND length(dispatch_token) > 0
        AND dispatch_link_id IS NOT NULL AND length(dispatch_link_id) > 0
        AND connector_account_id IS NOT NULL)),
    CONSTRAINT linked_calendar_control_destination_valid CHECK ((connector_account_id IS NULL AND provider_calendar_id IS NULL AND paused)
      OR (connector_account_id IS NOT NULL AND length(trim(connector_account_id)) > 0
        AND provider_calendar_id IS NOT NULL AND length(trim(provider_calendar_id)) > 0))
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.linked_calendar_control_mutations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    snapshot JSONB NOT NULL,
    committed_at TEXT NOT NULL,
    CONSTRAINT linked_calendar_control_mutations_operation_unique UNIQUE (agent_id, operation_key)
  )`);
}

/**
 * Linked events are calendar-native and never copied from the legacy LifeOps
 * schema. This bootstrap keeps upgrades safe when Drizzle schema registration
 * occurs after the migration service starts.
 */
export async function ensureLinkedCalendarEventTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.linked_calendar_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      local_event_id TEXT NOT NULL,
      connector_account_id TEXT NOT NULL,
      provider_calendar_id TEXT NOT NULL,
      provider_event_id TEXT,
      provider_etag TEXT,
      local_revision INTEGER NOT NULL DEFAULT 0,
      last_common_semantic_hash TEXT,
      state TEXT NOT NULL DEFAULT 'dirty',
      pending_operation TEXT,
      idempotency_key TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT linked_calendar_events_local_unique
        UNIQUE (agent_id, local_event_id),
      CONSTRAINT linked_calendar_events_provider_unique
        UNIQUE (
          agent_id, connector_account_id, provider_calendar_id, provider_event_id
        ),
      CONSTRAINT linked_calendar_events_state_valid
        CHECK (state IN ('clean', 'dirty', 'conflicted', 'quarantined', 'paused', 'local_only')),
      CONSTRAINT linked_calendar_events_operation_valid
        CHECK (pending_operation IS NULL OR pending_operation IN ('create', 'update', 'delete'))
    )`);
  await exec(`ALTER TABLE ${TARGET_SCHEMA}.linked_calendar_events
    DROP CONSTRAINT IF EXISTS linked_calendar_events_state_valid,
    ADD CONSTRAINT linked_calendar_events_state_valid
    CHECK (state IN ('clean', 'dirty', 'conflicted', 'quarantined', 'paused', 'local_only'))`);
  await exec(`
    CREATE INDEX IF NOT EXISTS linked_calendar_events_reconcile_idx
      ON ${TARGET_SCHEMA}.linked_calendar_events (agent_id, state, updated_at)`);
}

/**
 * Push channels are calendar-owned state rather than connector credentials.
 * The explicit migration path creates their table before a public callback can
 * arrive, including direct PGlite and older plugin-sql boot orders.
 */
export async function ensureGoogleCalendarWatchChannelTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.google_calendar_watch_channels (
      channel_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      connector_account_id TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      calendar_summary TEXT NOT NULL,
      calendar_access_role TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      resource_id TEXT,
      resource_uri TEXT,
      expiration_at TEXT,
      state TEXT NOT NULL,
      last_message_number TEXT NOT NULL DEFAULT '0',
      pending_message_number TEXT,
      last_notification_at TEXT,
      last_sync_at TEXT,
      sync_lease_token TEXT,
      sync_lease_expires_at TEXT,
      renewal_channel_id TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_retryable BOOLEAN,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_watch_binding_idx
      ON ${TARGET_SCHEMA}.google_calendar_watch_channels (
        agent_id, connector_account_id, grant_id, calendar_id
      )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_watch_maintenance_idx
      ON ${TARGET_SCHEMA}.google_calendar_watch_channels (
        agent_id, state, expiration_at
      )`);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

async function sourceColumnProjection(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<string> {
  const rows = await exec(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = '${SOURCE_SCHEMA}'
        AND table_name = '${table}'`,
  );
  const available = new Set(
    rows
      .map((row) => row.column_name)
      .filter((column): column is string => typeof column === "string"),
  );
  const missingRequired = MIGRATED_CALENDAR_COLUMNS[table].filter(
    (column) =>
      !available.has(column) && SOURCE_COLUMN_FALLBACKS[column] === undefined,
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `${CALENDAR_MIGRATION_LOG_PREFIX} legacy ${SOURCE_SCHEMA}.${table} is missing required column(s): ${missingRequired.join(", ")}`,
    );
  }
  const grant = available.has("grant_id") ? 's."grant_id"' : "NULL";
  const account = available.has("connector_account_id")
    ? 's."connector_account_id"'
    : "NULL";
  const canonicalGrantId = canonicalGrant(grant, account);
  const expressions: Record<string, string> = {
    grant_id: canonicalGrantId,
    connector_account_id: canonicalGrant(account, grant),
    ...(table === "life_calendar_sync_states"
      ? {
          id: `s.agent_id || ':' || s.provider || ':' || s.side || ':grant:' ||
            ${canonicalGrantId} || ':calendar:' || s.calendar_id`,
        }
      : {}),
  };
  // Preserve unexpected source columns in verification so schema drift cannot
  // silently drop a legacy value that the current copy list does not own.
  const columns = Array.from(
    new Set([...MIGRATED_CALENDAR_COLUMNS[table], ...available]),
  );
  return columns
    .map((column) => {
      const expression =
        expressions[column] ??
        (available.has(column)
          ? `s.${quoteIdent(column)}`
          : SOURCE_COLUMN_FALLBACKS[column]);
      return `${expression} AS ${quoteIdent(column)}`;
    })
    .join(", ");
}

async function targetTableIsEmpty(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(table)}) AS empty`,
  );
  return rows[0]?.empty === true || rows[0]?.empty === "true";
}

export async function migrateCalendarTable(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<TableMigrationResult> {
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
  }
  if (!(await targetTableIsEmpty(exec, table))) {
    return { table, outcome: "target-non-empty" };
  }

  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  const columns = MIGRATED_CALENDAR_COLUMNS[table];
  const targetColumns = columns.map(quoteIdent).join(", ");
  const sourceColumns = await sourceColumnProjection(exec, table);
  await ensureCalendarTableSourceIdentity(exec, table);
  const projectionTable = `calendar_projection_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  // A temporary snapshot lets copying and the shared verifier use precisely
  // the same canonical identity while leaving legacy source rows untouched.
  await exec(`CREATE TEMPORARY TABLE ${quoteIdent(projectionTable)} AS
    SELECT ${sourceColumns} FROM ${source} AS s`);
  try {
    await exec(
      `INSERT INTO ${target} (${targetColumns})
         SELECT ${targetColumns} FROM pg_temp.${quoteIdent(projectionTable)} AS s
         WHERE NOT EXISTS (
           SELECT 1 FROM ${target} AS t WHERE t.id = s.id
         )
         ON CONFLICT (${quoteIdent("id")}) DO NOTHING`,
    );
    await assertCarveOutProjectionComplete(exec, {
      migrationKey: `calendar/${table}/v2`,
      source: { schema: "pg_temp", table: projectionTable },
      target: { schema: TARGET_SCHEMA, table },
      keyColumns: ["id"],
    });
  } catch (error) {
    // error-policy:J2 preserve the copy/verification failure; transaction rollback
    // removes the temporary projection if a SQL error aborted the transaction.
    try {
      await exec(`DROP TABLE IF EXISTS pg_temp.${quoteIdent(projectionTable)}`);
    } catch (cleanupError) {
      // error-policy:J6 the owning transaction rollback removes the temporary table.
      logger.debug(
        { error: cleanupError, table },
        `${CALENDAR_MIGRATION_LOG_PREFIX} temporary projection cleanup deferred to rollback`,
      );
    }
    throw error;
  }
  await exec(`DROP TABLE pg_temp.${quoteIdent(projectionTable)}`);
  return { table, outcome: "copied" };
}

export async function migrateCalendarTables(
  database: CarveOutDatabase,
): Promise<TableMigrationResult[]> {
  const exec = database.execute;
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  await ensureIcsCalendarSourceTable(exec);
  await ensureIcsSecretCleanupTable(exec);
  await ensureCalendarFeedPreferenceTable(exec);
  await ensureGoogleCalendarWatchChannelTable(exec);
  await ensureLinkedCalendarEventTable(exec);
  await ensureLinkedCalendarControlTable(exec);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_CALENDAR_TABLES) {
    const receipt = await runCarveOutMigration(database, {
      key: `calendar/${table}/v2`,
      previousKeys: [`calendar/${table}/v1`],
      sourceTables: [{ schema: SOURCE_SCHEMA, table }],
      run: (execute) => migrateCalendarTable(execute, table),
      outcome: (result) => result.outcome,
      shouldComplete: (result) => result.outcome !== "source-missing",
    });
    results.push(
      receipt.status === "completed"
        ? receipt.value
        : { table, outcome: "already-migrated" },
    );
  }
  await ensureCalendarSourceIdentity(exec);
  return results;
}

type RuntimeDb = {
  execute: (query: unknown) => Promise<unknown>;
  transaction<T>(operation: (transaction: RuntimeDb) => Promise<T>): Promise<T>;
};

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = runtime.db as RuntimeDb | undefined;
  if (!db || typeof db.execute !== "function") {
    throw new Error(
      `${CALENDAR_MIGRATION_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-calendar.`,
    );
  }
  return db;
}

/**
 * Service whose `start()` performs the one-time, guarded, non-destructive copy
 * of the owner's calendar rows from `app_lifeops` into `app_calendar`.
 */
export class CalendarMigrationService extends Service {
  static override readonly serviceType = CALENDAR_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of calendar rows from app_lifeops into app_calendar during the plugin-calendar carve-out.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<CalendarMigrationService> {
    const service = new CalendarMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const database = await createDrizzleCarveOutDatabase(db);
    const results = await migrateCalendarTables(database);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${CALENDAR_MIGRATION_LOG_PREFIX} copied ${copied.length} calendar table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${CALENDAR_MIGRATION_LOG_PREFIX} no calendar tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}
