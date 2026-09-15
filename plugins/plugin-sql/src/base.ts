/**
 * `BaseDrizzleAdapter` is the shared `IDatabaseAdapter` implementation that
 * `PgDatabaseAdapter` and `PgliteDatabaseAdapter` both extend: every runtime
 * persistence operation (agents, entities, rooms, memories, relationships,
 * tasks, logs, cache, connector accounts/OAuth flow state, pairing) is
 * implemented once here against Drizzle, backend-agnostically, with
 * `withDatabase`/`withEntityContext` retry and Row Level Security wiring
 * left to the concrete Postgres/PGlite subclasses.
 */
import {
  type AccessContext,
  type Agent,
  type AgentRunCounts,
  type AgentRunSummary,
  type AgentRunSummaryResult,
  type AppendConnectorAccountAuditEventParams,
  actorFromAccessContext,
  advanceWorldMetadataRevision,
  appendWorldMetadataRoleAudit,
  ChannelType,
  type Component,
  type ConnectorAccountAuditEventRecord,
  type ConnectorAccountCredentialRefRecord,
  type ConnectorAccountRecord,
  type ConnectorOwnerBindingLookup,
  type ConnectorOwnerBindingRecord,
  type ConsumeOAuthFlowStateParams,
  type CreateOAuthFlowStateParams,
  canRequesterManageDocumentDirectGrants,
  canRequesterMutateDocument,
  DatabaseAdapter,
  type DeleteConnectorAccountCredentialRefsParams,
  type DeleteConnectorAccountParams,
  DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
  type DocumentCompareAndSwapParams,
  type DocumentDeleteParams,
  type DocumentDirectGrantUpdateParams,
  type DocumentFragmentQueryParams,
  type DocumentGetQueryParams,
  type DocumentListCursor,
  type DocumentListQueryParams,
  type DocumentListQueryResult,
  type DocumentMutationResult,
  type DocumentRangeReadParams,
  type DocumentRangeReadResult,
  type DocumentRevisionReplaceParams,
  decryptedCharacter,
  documentMutationSnapshotMatches,
  documentRoleHasGlobalVisibility,
  ElizaError,
  type EntitiesForRoomsResult,
  type Entity,
  encryptedCharacter,
  type GetConnectorAccountCredentialRefParams,
  type GetConnectorAccountParams,
  getWorldMetadataRevision,
  type IDatabaseAdapter,
  initializeWorldMetadataRevision,
  type JsonValue,
  type ListConnectorAccountCredentialRefsParams,
  type ListConnectorAccountsParams,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MessageSearchHit,
  type Metadata,
  normalizePairingPageOptions,
  type OAuthFlowRecord,
  type PairingAllowlistEntry,
  type PairingAllowlistQuery,
  type PairingAllowlistsResult,
  type PairingChannel,
  type PairingRequest,
  type PairingRequestQuery,
  type PairingRequestsResult,
  type Participant,
  type ParticipantsForRoomsResult,
  type ParticipantUpdateFields,
  type ParticipantUserState,
  type PatchOp,
  type Relationship,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  type Room,
  type RunStatus,
  requireFreshWorldMetadataRevision,
  type SetConnectorAccountCredentialRefParams,
  type Task,
  type TaskMetadata,
  type UpsertConnectorAccountParams,
  type UUID,
  validateDocumentDirectGrantEntityIds,
  validateDocumentFragmentQueryParams,
  validateDocumentListQueryParams,
  validateDocumentRequesterContext,
  validateDocumentRevisionReplacement,
  validateQueryEntitiesPagination,
  validateTaskQueryPagination,
  type World,
  type WorldMetadataCompareAndSwapParams,
  type WorldMetadataMutationResult,
  worldMetadataValueEquals,
} from "@elizaos/core";
import { sanitizeJsonObject, serializeDocumentJsonb, serializeJsonb } from "./sanitize-json";
import { worldRoleAuditTable } from "./schema/worldRoleAudit";
import {
  readTaskDueAt,
  serializeTaskDueAt,
  TaskTimingValidationError,
  taskMetadataForWrite,
} from "./stores/task-timing";

function agentBioRowsFromDb(bio: unknown): string[] {
  if (bio == null) return [];
  if (Array.isArray(bio)) return bio.map((entry) => String(entry));
  if (typeof bio === "string") return bio.trim() === "" ? [] : [bio];
  return [];
}

interface GetOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
  includeConsumed?: boolean;
  includeExpired?: boolean;
  now?: number | Date;
}

function applyPatchOp(target: Record<string, unknown>, op: PatchOp): void {
  if (!op.path) return;
  const parts = op.path.split(".");
  const last = parts.pop();
  if (last === undefined) return;

  let parent: Record<string, unknown> = target;
  for (const segment of parts) {
    const next = parent[segment];
    if (next === null || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      parent[segment] = created;
      parent = created;
    } else {
      parent = next as Record<string, unknown>;
    }
  }

  switch (op.op) {
    case "set":
      parent[last] = op.value;
      break;
    case "remove":
      delete parent[last];
      break;
    case "push": {
      const existing = parent[last];
      if (Array.isArray(existing)) {
        existing.push(op.value);
      } else {
        parent[last] = [op.value];
      }
      break;
    }
    case "increment": {
      const existing = parent[last];
      const delta = typeof op.value === "number" ? op.value : 1;
      parent[last] = typeof existing === "number" ? existing + delta : delta;
      break;
    }
  }
}

interface UpdateOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
  accountId?: string | null;
  redirectUri?: string | null;
  codeVerifierRef?: string | null;
  scopes?: string[];
  metadata?: Record<string, JsonValue>;
  expiresAt?: number | Date;
  consumedAt?: number | Date | null;
  consumedBy?: string | null;
}

interface DeleteOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
}

function asRawMessage(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asMetadata(value: unknown): Metadata | undefined {
  return (value ?? undefined) as Metadata | undefined;
}

function normalizeAgentBio(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
}

/** Escape an ILIKE literal so user keywords match literally (no `%`/`_` wildcards). */
function escapeIlikeLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Storage-level memory authorization predicate. Every condition returned here
 * is pushed into the same query that orders/ranks and paginates so ineligible
 * rows can neither leak nor starve an authorized page.
 */
function memoryAccessContextConditions(
  accessContext: AccessContext | undefined,
  agentId: UUID,
  tableName?: string
): SQL[] {
  if (!accessContext) return [];

  const conditions: SQL[] = [eq(memoryTable.agentId, agentId)];
  if (accessContext.authorizedRoomIds !== undefined) {
    if (accessContext.worldId !== undefined) {
      conditions.push(eq(memoryTable.worldId, accessContext.worldId));
    }
    const roomIds = [...new Set(accessContext.authorizedRoomIds)];
    conditions.push(roomIds.length === 0 ? sql`false` : inArray(memoryTable.roomId, roomIds));
  }

  const actor = actorFromAccessContext(accessContext, agentId);
  if (actor.role === "UNRESOLVED") {
    conditions.push(sql`false`);
    return conditions;
  }

  const metadata = memoryTable.metadata;
  const validScope = sql`(
    NOT (${metadata} ? 'scope')
    OR (
      jsonb_typeof(${metadata}->'scope') = 'string'
      AND ${metadata}->>'scope' IN (
        'shared', 'private', 'room', 'global', 'owner-private',
        'user-private', 'agent-private'
      )
    )
  )`;
  const unstampedScope =
    tableName === "messages" && accessContext.authorizedRoomIds !== undefined ? "room" : "private";
  const scope = sql`CASE
    WHEN NOT (${metadata} ? 'scope') THEN ${unstampedScope}
    ELSE ${metadata}->>'scope'
  END`;
  const scopedEntityId = sql`COALESCE(
    CASE
      WHEN jsonb_typeof(${metadata}->'scopedToEntityId') = 'string'
      THEN ${metadata}->>'scopedToEntityId'
    END,
    CASE
      WHEN jsonb_typeof(${metadata}->'addedBy') = 'string'
      THEN ${metadata}->>'addedBy'
    END,
    ${memoryTable.entityId}::text
  )`;
  const publicScope = sql`${scope} IN ('global', 'shared', 'room')`;

  let visibility: SQL;
  switch (actor.role) {
    case "OWNER":
      visibility = sql`(
        ${publicScope}
        OR ${scope} IN ('owner-private', 'agent-private')
        OR (${scope} IN ('private', 'user-private') AND ${scopedEntityId} = ${actor.entityId})
      )`;
      break;
    case "AGENT":
      visibility = sql`(
        ${publicScope}
        OR ${scope} = 'agent-private'
        OR ${scope} IN ('private', 'user-private')
      )`;
      break;
    case "RUNTIME":
      visibility = sql`(
        ${publicScope}
        OR ${scope} IN ('owner-private', 'agent-private', 'private', 'user-private')
      )`;
      break;
    case "ADMIN":
    case "USER":
      visibility = sql`(
        ${publicScope}
        OR (${scope} IN ('private', 'user-private') AND ${scopedEntityId} = ${actor.entityId})
      )`;
      break;
    case "GUEST":
      visibility = publicScope;
      break;
  }
  conditions.push(sql`(${validScope} AND ${visibility})`);
  return conditions;
}

const DOCUMENT_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

function validDocumentRevision(metadata: SQLWrapper): SQL {
  return sql`(
    NOT (${metadata} ? 'documentRevision')
    OR CASE
      WHEN jsonb_typeof(${metadata}->'documentRevision') = 'number' THEN
        (${metadata}->>'documentRevision')::numeric >= 0
        AND trunc((${metadata}->>'documentRevision')::numeric)
          = (${metadata}->>'documentRevision')::numeric
        AND (${metadata}->>'documentRevision')::numeric <= 9007199254740991
      ELSE false
    END
  )`;
}

function documentRevisionExpression(metadata: SQLWrapper): SQL {
  return sql`CASE
    WHEN jsonb_typeof(${metadata}->'documentRevision') = 'number'
    THEN (${metadata}->>'documentRevision')::numeric
    ELSE 0::numeric
  END`;
}

function validDocumentAuthorizationMetadata(metadata: SQLWrapper): SQL {
  return sql`(
    ${metadata}->>'scope' IN (
      'global', 'owner-private', 'user-private', 'agent-private'
    )
    AND (
      NOT (${metadata} ? 'scopedToEntityId')
      OR ${metadata}->>'scopedToEntityId' ~* ${DOCUMENT_UUID_PATTERN}
    )
    AND (
      NOT (${metadata} ? 'addedBy')
      OR ${metadata}->>'addedBy' ~* ${DOCUMENT_UUID_PATTERN}
    )
    AND (
      NOT (${metadata} ? 'directGrantEntityIds')
      OR (
        jsonb_typeof(${metadata}->'directGrantEntityIds') = 'array'
        AND jsonb_array_length(${metadata}->'directGrantEntityIds') <= 1000
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${metadata}->'directGrantEntityIds') AS grant_id
          WHERE grant_id !~* ${DOCUMENT_UUID_PATTERN}
        )
        AND jsonb_array_length(${metadata}->'directGrantEntityIds') = (
          SELECT COUNT(DISTINCT grant_id)
          FROM jsonb_array_elements_text(${metadata}->'directGrantEntityIds') AS grant_id
        )
      )
    )
    AND (
      ${metadata}->>'scope' <> 'user-private'
      OR ${metadata}->>'scopedToEntityId' ~* ${DOCUMENT_UUID_PATTERN}
    )
    AND ${validDocumentRevision(metadata)}
    AND (
      NOT (${metadata} ? 'ingestionState')
      OR ${metadata}->>'ingestionState' = 'ready'
    )
  )`;
}

function documentDirectGrantCondition(
  params: DocumentListQueryParams | DocumentGetQueryParams | DocumentFragmentQueryParams,
  metadata: SQLWrapper = memoryTable.metadata
): SQL {
  if (
    params.requesterRole === "UNRESOLVED" ||
    documentRoleHasGlobalVisibility(params.requesterRole)
  ) {
    return sql`false`;
  }
  return sql`(
    ${metadata}->>'scope' <> 'agent-private'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        COALESCE(${metadata}->'directGrantEntityIds', '[]'::jsonb)
      ) AS grant_id
      WHERE grant_id = ${params.requesterEntityId}
    )
  )`;
}

function documentRoomOrDirectGrantCondition(
  params: DocumentListQueryParams | DocumentGetQueryParams | DocumentFragmentQueryParams,
  roomCondition: SQL,
  metadata: SQLWrapper = memoryTable.metadata
): SQL {
  return sql`(
    ${roomCondition}
    OR ${documentDirectGrantCondition(params, metadata)}
  )`;
}

function documentVisibilityCondition(
  params: DocumentListQueryParams | DocumentGetQueryParams | DocumentFragmentQueryParams,
  metadata: SQLWrapper = memoryTable.metadata
): SQL {
  const validAuthorizationMetadata = validDocumentAuthorizationMetadata(metadata);
  if (documentRoleHasGlobalVisibility(params.requesterRole)) {
    return validAuthorizationMetadata;
  }
  if (params.requesterRole === "UNRESOLVED") {
    return sql`false`;
  }
  if (params.requesterRole === "ADMIN") {
    return sql`(
      ${validAuthorizationMetadata}
      AND (
        ${metadata}->>'scope' IN ('global', 'user-private')
        OR ${documentDirectGrantCondition(params, metadata)}
      )
    )`;
  }
  if (params.requesterRole === "GUEST") {
    return sql`(
      ${validAuthorizationMetadata}
      AND (
        ${metadata}->>'scope' = 'global'
        OR ${documentDirectGrantCondition(params, metadata)}
      )
    )`;
  }
  return sql`(
    ${validAuthorizationMetadata}
    AND (
      ${documentDirectGrantCondition(params, metadata)}
      OR
      ${metadata}->>'scope' = 'global'
      OR (
        ${metadata}->>'scope' = 'user-private'
        AND ${metadata}->>'scopedToEntityId' = ${params.requesterEntityId}
      )
    )
  )`;
}

function documentTimestampExpression(): SQL {
  return sql`COALESCE(
    CASE
      WHEN jsonb_typeof(${memoryTable.metadata}->'timestamp') = 'number'
      THEN (${memoryTable.metadata}->>'timestamp')::double precision
    END,
    EXTRACT(EPOCH FROM ${memoryTable.createdAt}) * 1000
  )`;
}

function isMessageSearchObjectsMissing(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const layer = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const message = typeof layer.message === "string" ? layer.message : "";
    if (
      (layer.code === "42703" || layer.code === "42883" || /does not exist/i.test(message)) &&
      /message_search_document|eliza_search_fold|eliza_search_like_pattern/i.test(message)
    ) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

type CountMemoriesParams = {
  roomIds?: UUID[];
  unique?: boolean;
  tableName?: string;
  entityId?: UUID;
  agentId?: UUID;
  metadata?: Record<string, unknown>;
};

import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const v4 = () => crypto.randomUUID();

/**
 * Detects whether an error is a postgres `unique_violation` (SQLState 23505),
 * walking the Error.cause chain because drizzle-orm rewraps the underlying
 * node-postgres / pglite error and the SQLState code lives on `error.cause`,
 * not on the outer Error. Also matches the legacy human-readable patterns
 * for callers that fabricate generic Errors.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const layer = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (layer.code === "23505") return true;
    if (typeof layer.message === "string" && /duplicate key|already exists/i.test(layer.message)) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

import { documentsFromDb } from "./agent-mapping";
import { usesWebsearchSyntax } from "./message-search";
import type { DatabaseBackend, DatabaseMigrationService } from "./migration-service";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "./schema/embedding";
import {
  agentTable,
  cacheTable,
  channelParticipantsTable,
  channelTable,
  componentTable,
  embeddingTable,
  entityTable,
  logTable,
  memoryTable,
  messageServerAgentsTable,
  messageServerTable,
  messageTable,
  pairingAllowlistTable,
  pairingRequestTable,
  participantTable,
  relationshipTable,
  roomTable,
  taskTable,
  worldTable,
} from "./schema/index";
import {
  documentSearchQueryTokensExpression,
  documentSearchTokensExpression,
} from "./schema/memory";

type AgentRow = typeof agentTable.$inferSelect;
type AgentMessageExamples = NonNullable<Agent["messageExamples"]>;
type AgentKnowledge = NonNullable<Agent["knowledge"]>;
type MemoryRow = typeof memoryTable.$inferSelect;

function memoryFromRow(row: MemoryRow, embedding?: number[], similarity?: number): Memory {
  return {
    id: row.id as UUID,
    createdAt: row.createdAt.getTime(),
    content:
      typeof row.content === "string"
        ? JSON.parse(row.content)
        : (row.content as Memory["content"]),
    entityId: row.entityId as UUID,
    agentId: row.agentId as UUID,
    roomId: row.roomId as UUID,
    worldId: (row.worldId ?? undefined) as UUID | undefined,
    unique: row.unique,
    metadata:
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : (row.metadata as MemoryMetadata),
    ...(embedding ? { embedding } : {}),
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

function normalizeAgentMessageExamples(messageExamples: unknown): AgentMessageExamples {
  if (!Array.isArray(messageExamples) || messageExamples.length === 0) {
    return [];
  }
  return messageExamples.flatMap((entry): AgentMessageExamples => {
    if (Array.isArray(entry)) {
      return [{ examples: entry }];
    }
    if (
      entry &&
      typeof entry === "object" &&
      Array.isArray((entry as { examples?: unknown }).examples)
    ) {
      return [entry as AgentMessageExamples[number]];
    }
    return [];
  });
}

function normalizeAgentKnowledge(knowledge: AgentRow["knowledge"]): AgentKnowledge {
  // Delegate to the single shared reader so `mapAgentRow` and `AgentStore.get`
  // restore directory knowledge identically (canonical `{ path, shared }`
  // value) instead of maintaining a second, divergent normalizer.
  return documentsFromDb(knowledge);
}

function transformAgentSettings(
  agent: Partial<Agent>,
  transform: typeof encryptedCharacter
): Partial<Agent> {
  if (!Object.hasOwn(agent, "settings")) return { ...agent };
  const transformed = transform({ settings: agent.settings });

  return {
    ...agent,
    settings: transformed.settings,
  };
}

function mapAgentRow(row: AgentRow): Agent {
  const agent: Agent = {
    ...row,
    username: row.username || "",
    id: row.id as UUID,
    system: !row.system ? undefined : row.system,
    bio: normalizeAgentBio(row.bio),
    messageExamples: normalizeAgentMessageExamples(row.messageExamples),
    knowledge: normalizeAgentKnowledge(row.knowledge),
    settings: row.settings as Agent["settings"],
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
  const decrypted = transformAgentSettings(agent, decryptedCharacter);
  return {
    ...agent,
    settings: decrypted.settings,
  };
}

import {
  ConnectorAccountStore,
  type ListConnectorAccountAuditEventsParams,
} from "./stores/connectorAccount.store";
import type { StoreContext } from "./stores/types";
import type { DrizzleDatabase } from "./types";

export abstract class BaseDrizzleAdapter extends DatabaseAdapter<DrizzleDatabase> {
  readonly documentListQueryCapability = DOCUMENT_LIST_QUERY_CAPABILITY_VERSION;
  readonly documentRangeReadCapability = 1 as const;
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  protected readonly databaseBackend: DatabaseBackend = "unknown";
  protected migrationService?: DatabaseMigrationService;
  private migrationRunPromise: Promise<void> | null = null;
  private readonly migratedSchemaEntries = new Map<string, Map<string, unknown>>();
  private transactionWrites?: Array<() => void>;
  private transactionEntityContext?: UUID | null;

  /** Defers external write publication until the outermost SQL transaction commits. */
  protected publishCommittedWrite(write: () => void): void {
    if (this.transactionWrites) this.transactionWrites.push(write);
    else write();
  }

  private _connectorAccountStore?: ConnectorAccountStore;
  private messageSearchTrigramAvailable: boolean | null = null;
  private lastDocumentListStatement?: {
    query: SQL;
    entityContext: UUID;
  };

  protected getConnectorAccountStore(): ConnectorAccountStore {
    if (!this._connectorAccountStore) {
      const ctx: StoreContext = {
        getDb: () => this.db as DrizzleDatabase,
        withRetry: <T>(operation: () => Promise<T>) => this.withDatabase(operation),
        withIsolationContext: <T>(
          entityId: UUID | null,
          callback: (tx: DrizzleDatabase) => Promise<T>
        ) => this.withEntityContext(entityId, callback),
        agentId: this.agentId,
        getEmbeddingDimension: () => this.embeddingDimension,
      };
      this._connectorAccountStore = new ConnectorAccountStore(ctx);
    }
    return this._connectorAccountStore;
  }

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;

  public abstract withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T>;

  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  public async initialize(): Promise<void> {
    await this.init();
  }

  public async runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    }
  ): Promise<void> {
    if (!this.migrationService) {
      const { DatabaseMigrationService } = await import("./migration-service");
      this.migrationService = new DatabaseMigrationService({
        databaseBackend: this.databaseBackend,
      });
      await this.migrationService.initializeWithDatabase(this.db as DrizzleDatabase);
    }

    if (this.migrationRunPromise) {
      logger.debug(
        { src: "plugin:sql", pluginCount: plugins.length },
        "Plugin migrations already running in this process; joining active run"
      );
      await this.migrationRunPromise;
      return this.runPluginMigrations(plugins, options);
    }

    const pendingPlugins = plugins.filter(
      (plugin): plugin is { name: string; schema: Record<string, unknown> } =>
        plugin.schema !== undefined &&
        !this.schemaEntriesAlreadyMigrated(plugin.name, plugin.schema)
    );
    if (pendingPlugins.length === 0) {
      logger.debug(
        { src: "plugin:sql", pluginCount: plugins.length },
        "All requested plugin schema instances already migrated; skipping"
      );
      return;
    }

    for (const plugin of pendingPlugins) {
      this.migrationService.registerSchema(plugin.name, plugin.schema);
    }

    this.migrationRunPromise = this.migrationService.runAllPluginMigrations(
      options,
      pendingPlugins.map((plugin) => plugin.name)
    );
    try {
      await this.migrationRunPromise;
      if (!options?.dryRun) {
        for (const plugin of pendingPlugins) {
          this.migratedSchemaEntries.set(plugin.name, new Map(Object.entries(plugin.schema)));
        }
      }
    } finally {
      this.migrationRunPromise = null;
    }
  }

  private schemaEntriesAlreadyMigrated(
    pluginName: string,
    schema: Record<string, unknown>
  ): boolean {
    const migrated = this.migratedSchemaEntries.get(pluginName);
    const entries = Object.entries(schema);
    if (!migrated || migrated.size !== entries.length) {
      return false;
    }
    return entries.every(([name, value]) => migrated.get(name) === value);
  }

  public getDatabase(): unknown {
    return this.db;
  }

  protected agentId: UUID;

  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  private normalizeEntityNames(names: unknown): string[] {
    if (names == null) {
      return [];
    }

    if (typeof names === "string") {
      return [names];
    }

    if (Array.isArray(names)) {
      return names.map(String);
    }

    if (names instanceof Set) {
      return Array.from(names).map(String);
    }

    if (typeof names === "object") {
      const iterableNames = names as { [Symbol.iterator]?: () => Iterator<unknown> };
      if (typeof iterableNames[Symbol.iterator] === "function") {
        return Array.from(names as Iterable<unknown>).map(String);
      }
    }

    return [String(names)];
  }

  private isValidUUID(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private normalizeWorldData(
    world: Partial<World> & { serverId?: UUID | null }
  ): typeof worldTable.$inferInsert {
    const worldData: typeof worldTable.$inferInsert = {
      agentId: this.agentId,
      id: (world.id || v4()) as UUID,
      name: world.name || "",
      metadata: world.metadata || {},
    };

    const serverId = world.serverId ?? world.messageServerId;
    if (typeof serverId === "string" && this.isValidUUID(serverId)) {
      worldData.messageServerId = serverId;
    } else if (serverId) {
      logger.warn(
        { src: "plugin:sql", agentId: this.agentId, serverId },
        "Ignoring non-UUID message/server identifier for world"
      );
    }

    return worldData;
  }

  private mapWorldResult(world: unknown): World {
    const mappedWorld = world as Record<string, unknown>;
    const messageServerId = mappedWorld.messageServerId || mappedWorld.serverId;
    return {
      ...mappedWorld,
      ...(typeof messageServerId === "string"
        ? {
            messageServerId: messageServerId as UUID,
            serverId: messageServerId as UUID,
          }
        : {}),
    } as World;
  }

  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // error-policy:J2 context-adding rethrow — retries transient DB errors,
      // then rethrows the last error once attempts are exhausted (never swallows).
      try {
        return await operation();
      } catch (error) {
        if (error instanceof TaskTimingValidationError) throw error;
        if (error instanceof ElizaError && error.code === "WORLD_METADATA_STALE_WRITE") {
          throw error;
        }
        lastError = error as Error;

        if (attempt < this.maxRetries) {
          const backoffDelay = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);

          const jitter = Math.random() * this.jitterMax;
          const delay = backoffDelay + jitter;

          logger.warn(
            {
              src: "plugin:sql",
              attempt,
              maxRetries: this.maxRetries,
              error: error instanceof Error ? error.message : String(error),
            },
            "Database operation failed, retrying"
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error(
            {
              src: "plugin:sql",
              totalAttempts: attempt,
              error: error instanceof Error ? error.message : String(error),
            },
            "Max retry attempts reached"
          );
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  /**
   * Asynchronously ensures that the given embedding dimension is valid for the agent.
   *
   * @param {number} dimension - The dimension to ensure for the embedding.
   * @returns {Promise<void>} - Resolves once the embedding dimension is ensured.
   */
  async ensureEmbeddingDimension(dimension: number) {
    return this.withDatabase(async () => {
      const resolvedDimension = DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
      if (!resolvedDimension) {
        logger.warn(
          {
            src: "plugin:sql",
            agentId: this.agentId,
            requestedDimension: dimension,
            fallbackDimension: this.embeddingDimension,
          },
          "Unsupported embedding dimension requested; keeping current embedding column"
        );
        return;
      }

      this.embeddingDimension = resolvedDimension;
      await this.ensureEmbeddingVectorIndex(dimension);
    });
  }

  /**
   * Create the HNSW cosine index for the active embedding column if it does
   * not exist. Without it every `searchMemoriesByEmbedding` call is a full
   * sequential scan computing cosine distance across the whole embeddings
   * table — measured at ~45ms per query over 5000x1536 vectors in-process,
   * growing linearly with table size. Only the ACTIVE dimension is indexed
   * (each row populates exactly one column, and deployments use one width),
   * so fresh agents pay nothing and existing stores pay a one-time build on
   * the first boot after upgrade.
   *
   * On shared Postgres the build runs CONCURRENTLY so other agents' memory
   * writes are not blocked behind the index build's SHARE lock; PGlite is a
   * single connection where CONCURRENTLY is meaningless (and unsupported).
   */
  private async ensureEmbeddingVectorIndex(dimension: number): Promise<void> {
    const columnName = `dim_${dimension}`;
    const indexName = `idx_embeddings_${columnName}_hnsw_cosine`;
    // CONCURRENTLY cannot run inside a transaction block; this executes as a
    // standalone autocommit statement. PGlite is a single connection with
    // nothing to lock out (and no CONCURRENTLY support).
    const concurrently = this.databaseBackend === "postgres" ? "CONCURRENTLY " : "";
    try {
      // A failed CREATE INDEX CONCURRENTLY (crash, lock timeout, OOM mid-build)
      // leaves an INVALID index behind, and IF NOT EXISTS would then treat it
      // as present forever — pinning every vector search to sequential scans.
      // Detect that leftover and drop it so the create below rebuilds it.
      const invalid = await this.db.execute(
        sql.raw(
          `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid ` +
            `WHERE c.relname = '${indexName}' AND NOT i.indisvalid`
        )
      );
      const invalidRows = invalid.rows;
      if (!Array.isArray(invalidRows)) {
        // An invalid driver result must not make an INVALID index look absent,
        // because IF NOT EXISTS would then preserve the broken index forever.
        throw new ElizaError("Embedding index validity query returned malformed rows", {
          code: "DB_QUERY_FAILED",
          context: { table: "pg_index", indexName },
        });
      }
      if (invalidRows.length > 0) {
        logger.warn(
          { src: "plugin:sql", agentId: this.agentId, indexName },
          "Dropping INVALID HNSW embeddings index left by a failed concurrent build; rebuilding"
        );
        await this.db.execute(sql.raw(`DROP INDEX IF EXISTS "${indexName}"`));
      }
      await this.db.execute(
        sql.raw(
          `CREATE INDEX ${concurrently}IF NOT EXISTS "${indexName}" ` +
            `ON "embeddings" USING hnsw ("${columnName}" vector_cosine_ops)`
        )
      );
    } catch (error) {
      // error-policy:J4 designed degrade — the index is a performance
      // structure only; the KNN query is correct (just slower) without it,
      // e.g. on a pgvector build without HNSW support. Search must not fail
      // closed over a missing optimization.
      logger.warn(
        {
          src: "plugin:sql",
          agentId: this.agentId,
          dimension,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not create HNSW index for embeddings; vector search will sequential-scan"
      );
    }

    // PGlite is one sticky session, so a single SET makes filtered HNSW index
    // scans refill in exact order until the LIMIT is satisfied instead of
    // short-reading under selective filters (pgvector >= 0.8). Pooled
    // Postgres gets the same GUC per connection in PostgresConnectionManager.
    if (this.databaseBackend === "pglite") {
      try {
        await this.db.execute(sql.raw(`SET hnsw.iterative_scan = 'strict_order'`));
      } catch (error) {
        // error-policy:J4 designed degrade — older pgvector has no
        // iterative_scan GUC; search stays correct on non-index plans.
        logger.debug(
          {
            src: "plugin:sql",
            agentId: this.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "hnsw.iterative_scan unavailable; filtered vector search may use non-index plans"
        );
      }
    }
  }

  /**
   * Delete every embedding row whose vector lives in a dimension column other
   * than the currently-active one, returning the ids of the memories left
   * without a vector so the caller can re-embed them at the active width.
   *
   * Each row populates exactly one `dimNNN` column (the others stay null), so
   * "not in the active dimension" is simply "active column IS NULL". This is the
   * store side of switching embedders — e.g. an agent moving off cloud 1536-dim
   * embeddings onto on-device gte-small (384-dim): the stale 1536 vectors would
   * otherwise sit unreadable by a 384-dim search forever. A no-op (returns `[]`)
   * once the store holds only active-dimension vectors, so it is safe to call on
   * every boot.
   */
  async clearEmbeddingsOutsideActiveDimension(): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const agentMemoryIds = this.db
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(eq(memoryTable.agentId, this.agentId));
      const cleared = await this.db
        .delete(embeddingTable)
        .where(
          and(
            isNull(embeddingTable[this.embeddingDimension]),
            inArray(embeddingTable.memoryId, agentMemoryIds)
          )
        )
        .returning();
      return cleared.map((row) => row.memoryId).filter((id): id is UUID => id !== null);
    });
  }

  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (rows.length === 0) return null;

      return mapAgentRow(rows[0]);
    });
  }

  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
   */
  async getAgents(): Promise<Partial<Agent>[]> {
    const result = await this.withDatabase(async () => {
      const rows = await this.db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          bio: agentTable.bio,
        })
        .from(agentTable);
      return rows.map(
        (row) =>
          ({
            ...row,
            id: row.id as UUID,
            bio: agentBioRowsFromDb(row.bio),
          }) as Partial<Agent>
      );
    });
    // Guard against null return
    return result || [];
  }

  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    if (agentIds.length === 0) return [];
    return this.withDatabase(async () => {
      const rows = await this.db.select().from(agentTable).where(inArray(agentTable.id, agentIds));
      return rows.map((row) => mapAgentRow(row));
    });
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    if (agents.length === 0) return [];
    return this.withDatabase(async () => {
      const ids: UUID[] = [];
      for (const agent of agents) {
        if (agent.id) {
          const success = await this.createAgent(agent as Agent);
          if (success) ids.push(agent.id);
        }
      }
      return ids;
    });
  }

  async updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<boolean> {
    for (const { agentId, agent } of updates) {
      const success = await this.updateAgent(agentId, agent);
      if (!success) return false;
    }
    return true;
  }

  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    for (const agent of agents) {
      if (!agent.id) continue;
      const existing = await this.getAgent(agent.id);
      if (existing) {
        await this.updateAgent(agent.id, agent);
      } else {
        await this.createAgent(agent as Agent);
      }
    }
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    if (agentIds.length === 0) return true;
    return this.withDatabase(async () => {
      // error-policy:J2 context-adding rethrow — a failed delete must not read
      // as "nothing matched" (both would return false); surface it as a typed error.
      try {
        await this.db.delete(agentTable).where(inArray(agentTable.id, agentIds));
        return true;
      } catch (error) {
        throw new ElizaError("deleteAgents failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "agents", agentIds },
        });
      }
    });
  }

  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  async createAgent(agent: Agent): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        // Check for existing agent with the same ID only (names can be duplicated)
        if (agent.id) {
          const existing = await this.db
            .select({ id: agentTable.id })
            .from(agentTable)
            .where(eq(agentTable.id, agent.id))
            .limit(1);

          if (existing.length > 0) {
            logger.warn(
              { src: "plugin:sql", agentId: agent.id },
              "Attempted to create agent with duplicate ID"
            );
            return false;
          }
        }

        await this.db.transaction(async (tx) => {
          const persistedAgent = transformAgentSettings(agent, encryptedCharacter);
          const agentData = {
            ...persistedAgent,
            createdAt: new Date(
              typeof agent.createdAt === "bigint"
                ? Number(agent.createdAt)
                : agent.createdAt || Date.now()
            ),
            updatedAt: new Date(
              typeof agent.updatedAt === "bigint"
                ? Number(agent.updatedAt)
                : agent.updatedAt || Date.now()
            ),
          };
          const sanitizedAgentData = Object.fromEntries(
            Object.entries(agentData).filter(([, value]) => value !== undefined)
          ) as typeof agentTable.$inferInsert;

          await tx.insert(agentTable).values(sanitizedAgentData);
        });

        return true;
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing — a duplicate id is the
        // typed "already exists" outcome (false), distinct from a write failure.
        if (isDuplicateKeyError(error)) {
          logger.warn(
            { src: "plugin:sql", agentId: agent.id },
            "Attempted to create agent with duplicate ID"
          );
          return false;
        }
        // error-policy:J2 context-adding rethrow — any other error is a real
        // write failure; surface it with context.
        throw new ElizaError("createAgent failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "agents", agentId: agent.id },
        });
      }
    });
  }

  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        if (!agentId) {
          throw new Error("Agent ID is required for update");
        }

        await this.db.transaction(async (tx) => {
          const settings = agent.settings
            ? this.mergeAgentSettings(
                (
                  await tx
                    .select({ settings: agentTable.settings })
                    .from(agentTable)
                    .where(eq(agentTable.id, agentId))
                    .limit(1)
                )[0]?.settings,
                agent.settings
              )
            : agent.settings;
          const persistedAgent = transformAgentSettings(
            {
              ...agent,
              ...(settings !== undefined ? { settings } : {}),
            },
            encryptedCharacter
          );

          // Convert numeric timestamps to Date objects for database storage
          // The Agent interface uses numbers, but the database schema expects Date objects
          const updateData: Record<string, unknown> = { ...persistedAgent };

          if (updateData.createdAt) {
            if (typeof updateData.createdAt === "number") {
              updateData.createdAt = new Date(updateData.createdAt);
            } else {
              delete updateData.createdAt; // Don't update createdAt if it's not a valid timestamp
            }
          }
          if (updateData.updatedAt) {
            if (typeof updateData.updatedAt === "number") {
              updateData.updatedAt = new Date(updateData.updatedAt);
            } else {
              updateData.updatedAt = new Date(); // Use current time if invalid
            }
          } else {
            updateData.updatedAt = new Date(); // Always set updatedAt to current time
          }

          await tx.update(agentTable).set(updateData).where(eq(agentTable.id, agentId));
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed update must not be
        // indistinguishable from a legitimate no-op; surface the failure.
        throw new ElizaError("updateAgent failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    });
  }

  /**
   * Merges updated agent settings with existing persisted settings,
   * with special handling for nested objects like secrets.
   * @param currentSettings - The settings currently stored for the agent
   * @param updatedSettings - The settings object with updates
   * @returns The merged settings object
   * @private
   */
  private mergeAgentSettings<T extends Record<string, unknown>>(
    currentSettings: unknown,
    updatedSettings: T
  ): T {
    const deepMerge = (
      target: Record<string, unknown> | unknown,
      source: Record<string, unknown>
    ): Record<string, unknown> | undefined => {
      // If source is explicitly null, it means the intention is to set this entire branch to null (or delete if top-level handled by caller).
      // For recursive calls, if a sub-object in source is null, it effectively means "remove this sub-object from target".
      // However, our primary deletion signal is a *property value* being null within an object.
      if (source === null) {
        // If the entire source for a given key is null, we treat it as "delete this key from target"
        // by returning undefined, which the caller can use to delete the key.
        return undefined;
      }

      // If source is an array or a primitive, it replaces the target value.
      if (Array.isArray(source) || typeof source !== "object") {
        return source;
      }

      // Initialize output. If target is not an object, start with an empty one to merge source into.
      const output: Record<string, unknown> =
        typeof target === "object" && target !== null && !Array.isArray(target)
          ? { ...(target as Record<string, unknown>) }
          : {};

      for (const key of Object.keys(source)) {
        // Iterate over source keys
        const sourceValue = source[key];

        if (sourceValue === null) {
          // If a value in source is null, delete the corresponding key from output.
          delete output[key];
        } else if (typeof sourceValue === "object" && !Array.isArray(sourceValue)) {
          // If value is an object, recurse.
          const nestedMergeResult = deepMerge(output[key], sourceValue as Record<string, unknown>);
          if (nestedMergeResult === undefined) {
            // If recursive merge resulted in undefined (meaning the nested object should be deleted)
            delete output[key];
          } else {
            output[key] = nestedMergeResult;
          }
        } else {
          // Primitive or array value from source, assign it.
          output[key] = sourceValue;
        }
      }

      // After processing all keys from source, check if output became empty.
      // An object is empty if all its keys were deleted or resulted in undefined.
      // This is a more direct check than iterating 'output' after building it.
      if (Object.keys(output).length === 0) {
        // If the source itself was not an explicitly empty object,
        // and the merge resulted in an empty object, signal deletion.
        if (!(typeof source === "object" && source !== null && Object.keys(source).length === 0)) {
          return undefined; // Signal to delete this (parent) key if it became empty.
        }
      }

      return output;
    }; // End of deepMerge

    const finalSettings = deepMerge(currentSettings, updatedSettings);
    // If the entire settings object becomes undefined (e.g. all keys removed),
    // return an empty object instead of undefined/null to keep the settings field present.
    return (finalSettings ?? {}) as T;
  }

  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        // Simply delete the agent - all related data will be cascade deleted
        const result = await this.db
          .delete(agentTable)
          .where(eq(agentTable.id, agentId))
          .returning();

        // false is the typed "no agent matched" outcome, distinct from failure.
        if (result.length === 0) {
          logger.warn({ src: "plugin:sql", agentId }, "Agent not found for deletion");
          return false;
        }

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — surface a real delete failure
        // with context (the not-found case already returned false above).
        throw new ElizaError("deleteAgent failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    });
  }

  /**
   * Count all agents in the database
   * Used primarily for maintenance and cleanup operations
   */
  /**
   * Asynchronously counts the number of agents in the database.
   * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
   */
  async countAgents(): Promise<number> {
    return this.withDatabase(async () => {
      // "DB broken" must never read as "0 agents": both a query failure and a
      // missing count row surface as a typed DB_COUNT_FAILED. The aggregate
      // always returns exactly one row, so a missing count is a broken pipeline.
      let total: number | undefined;
      try {
        const result = await this.db.select({ count: count() }).from(agentTable);
        total = result[0]?.count;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — surface a query failure as a
        // typed count error rather than letting a bare driver error escape.
        throw new ElizaError("countAgents query failed", {
          code: "DB_COUNT_FAILED",
          cause: error,
          context: { table: "agents" },
        });
      }
      if (typeof total !== "number") {
        throw new ElizaError("countAgents returned no count row", {
          code: "DB_COUNT_FAILED",
          context: { table: "agents" },
        });
      }
      return total;
    });
  }

  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  async cleanupAgents(): Promise<void> {
    // No catch: a delete failure propagates via withDatabase's retry layer; the
    // previous log-then-rethrow added no context the retry layer doesn't log.
    return this.withDatabase(async () => {
      await this.db.delete(agentTable);
    });
  }

  /**
   * Asynchronously retrieves an entity and its components by entity IDs.
   * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
   * @returns {Promise<Entity[]>} A Promise that resolves to the entity with its components.
   */
  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          entity: entityTable,
          components: componentTable,
        })
        .from(entityTable)
        .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
        .where(inArray(entityTable.id, entityIds));

      if (result.length === 0) return [];

      // Group components by entity
      const entities: Record<UUID, Entity> = {};
      const entityComponents: Record<UUID, Entity["components"]> = {};
      for (const e of result) {
        const key = e.entity.id;
        entities[key] = e.entity;
        if (entityComponents[key] === undefined) entityComponents[key] = [];
        if (e.components) {
          // Handle both single component and array of components
          const componentsArray = Array.isArray(e.components) ? e.components : [e.components];
          entityComponents[key] = [...entityComponents[key], ...componentsArray];
        }
      }
      for (const k of Object.keys(entityComponents)) {
        entities[k].components = entityComponents[k];
      }

      return Object.values(entities);
    });
  }

  /**
   * Asynchronously retrieves all entities for a given room, optionally including their components.
   * @param {UUID} roomId - The unique identifier of the room to get entities for
   * @param {boolean} [includeComponents] - Whether to include component data for each entity
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room
   */
  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const query = this.db
        .select({
          entity: entityTable,
          ...(includeComponents && { components: componentTable }),
        })
        .from(participantTable)
        .leftJoin(
          entityTable,
          and(eq(participantTable.entityId, entityTable.id), eq(entityTable.agentId, this.agentId))
        );

      if (includeComponents) {
        query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
      }

      const result = await query.where(eq(participantTable.roomId, roomId));

      // Group components by entity if includeComponents is true
      const entitiesByIdMap = new Map<UUID, Entity>();

      for (const row of result) {
        if (!row.entity) continue;

        const entityId = row.entity.id as UUID;
        if (!entitiesByIdMap.has(entityId)) {
          const entity: Entity = {
            ...row.entity,
            id: entityId,
            agentId: row.entity.agentId as UUID,
            metadata: (row.entity.metadata || {}) as Metadata,
            components: includeComponents ? [] : undefined,
          };
          entitiesByIdMap.set(entityId, entity);
        }

        if (includeComponents && row.components) {
          const entity = entitiesByIdMap.get(entityId);
          if (entity) {
            if (!entity.components) {
              entity.components = [];
            }
            entity.components.push(row.components);
          }
        }
      }

      return Array.from(entitiesByIdMap.values());
    });
  }

  /**
   * Asynchronously creates new entities in the database.
   * @param {Entity[]} entities - The entity objects to be created.
   * @returns {Promise<UUID[]>} The IDs of the created entities.
   */
  async createEntities(entities: Entity[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      // Pre-assign IDs so duplicates (by id) can be reported as
      // already-created → success (idempotent create; see ON CONFLICT below).
      const normalizedEntities = entities.map((entity) => {
        const { names, metadata, ...normalizedEntity } = entity as Entity & {
          names?: unknown;
          metadata?: Metadata;
        };
        const id = (entity.id || v4()) as UUID;
        return {
          ...normalizedEntity,
          id,
          agentId: this.agentId,
          names: this.normalizeEntityNames(names),
          metadata: metadata || {},
        };
      });

      try {
        // ON CONFLICT DO NOTHING keeps the create idempotent per row: rows
        // whose id already exists are skipped (never clobbered — that's
        // upsertEntities' job) while the rest of the batch still lands. The
        // previous catch-on-duplicate approach rolled back the whole batch and
        // then claimed success for entities that were never written. Both of
        // entityTable's unique constraints (PK id, unique(id, agentId)) are
        // id-based, so any conflict here is a duplicate id.
        const inserted = await this.db
          .insert(entityTable)
          .values(normalizedEntities)
          .onConflictDoNothing()
          .returning();
        if (inserted.length < normalizedEntities.length) {
          logger.warn(
            {
              src: "plugin:sql",
              requested: normalizedEntities.length,
              inserted: inserted.length,
            },
            "Some entities already existed; treating them as created"
          );
        }
        return normalizedEntities.map((entity) => entity.id as UUID);
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed batch insert must
        // not read as "created zero entities" (an empty return is a valid
        // success for an empty input); surface the write failure.
        throw new ElizaError("createEntities failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "entities", count: normalizedEntities.length },
        });
      }
    });
  }

  /**
   * Asynchronously ensures an entity exists, creating it if it doesn't
   * @param entity The entity to ensure exists
   * @returns Promise resolving to boolean indicating success
   */
  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    if (!entity.id) {
      throw new ElizaError("Entity ID is required for ensureEntityExists", {
        code: "DB_INVALID_ARGUMENT",
        context: { table: "entities" },
      });
    }

    // No catch: a lookup/insert failure propagates so callers see a broken
    // pipeline instead of a fabricated "could not ensure" (false).
    const existingEntities = await this.getEntitiesByIds([entity.id]);
    if (!existingEntities.length) {
      return (await this.createEntities([entity])).length > 0;
    }
    return true;
  }

  /**
   * Asynchronously updates an entity in the database.
   * @param {Entity} entity - The entity object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the entity is updated.
   */
  async updateEntity(entity: Entity): Promise<void> {
    if (!entity.id) {
      throw new Error("Entity ID is required for update");
    }
    return this.withDatabase(async () => {
      // Normalize entity data to ensure names is a proper array
      const normalizedEntity = {
        ...entity,
        agentId: this.agentId,
        names: this.normalizeEntityNames(entity.names),
        metadata: entity.metadata || {},
      };

      await this.db
        .update(entityTable)
        .set(normalizedEntity)
        .where(eq(entityTable.id, entity.id as string));
    });
  }

  /**
   * Asynchronously deletes an entity from the database based on the provided ID.
   * @param {UUID} entityId - The ID of the entity to delete.
   * @returns {Promise<void>} A Promise that resolves when the entity is deleted.
   */
  async deleteEntity(entityId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete related components first
        await tx
          .delete(componentTable)
          .where(
            or(eq(componentTable.entityId, entityId), eq(componentTable.sourceEntityId, entityId))
          );

        // Delete the entity
        await tx.delete(entityTable).where(eq(entityTable.id, entityId));
      });
    });
  }

  /**
   * Asynchronously retrieves entities by their names and agentId.
   * @param {Object} params - The parameters for retrieving entities.
   * @param {string[]} params.names - The names to search for.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { names, agentId } = params;

      // Build a condition to match any of the names
      const nameConditions = names.map((name) => sql`${name} = ANY(${entityTable.names})`);

      const query = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND (${sql.join(nameConditions, sql` OR `)})
      `;

      const result = await this.db.execute(query);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));
    });
  }

  /**
   * Asynchronously searches for entities by name with fuzzy matching.
   * @param {Object} params - The parameters for searching entities.
   * @param {string} params.query - The search query.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @param {number} params.limit - The maximum number of results to return.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { query, agentId, limit = 10 } = params;

      // If query is empty, return all entities up to limit
      if (!query || query.trim() === "") {
        const result = await this.db
          .select()
          .from(entityTable)
          .where(eq(entityTable.agentId, agentId))
          .limit(limit);

        return result.map((row: Record<string, unknown>) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          names: (row.names || []) as string[],
          metadata: (row.metadata || {}) as Metadata,
        }));
      }

      // Otherwise, search for entities with names containing the query (case-insensitive)
      const searchQuery = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND EXISTS (
          SELECT 1 FROM unnest(${entityTable.names}) AS name
          WHERE LOWER(name) LIKE LOWER(${`%${query}%`})
        )
        LIMIT ${limit}
      `;

      const result = await this.db.execute(searchQuery);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));
    });
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return null;

      const component = result[0];

      return {
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      };
    });
  }

  /**
   * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve components for
   * @param {UUID} [worldId] - Optional world ID to filter components by
   * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by
   * @returns {Promise<Component[]>} A Promise that resolves to an array of components
   */
  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select({
          id: componentTable.id,
          entityId: componentTable.entityId,
          type: componentTable.type,
          data: componentTable.data,
          worldId: componentTable.worldId,
          agentId: componentTable.agentId,
          roomId: componentTable.roomId,
          sourceEntityId: componentTable.sourceEntityId,
          createdAt: componentTable.createdAt,
        })
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return [];

      const components = result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));

      return components;
    });
  }

  /**
   * Asynchronously creates a new component in the database.
   * @param {Component} component - The component object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createComponent(component: Component): Promise<boolean> {
    return this.withDatabase(async () => {
      await this.db.insert(componentTable).values({
        ...component,
        createdAt: new Date(),
      });
      return true;
    });
  }

  /**
   * Asynchronously updates an existing component in the database.
   * @param {Component} component - The component object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the component is updated.
   */
  async updateComponent(component: Component): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Convert createdAt from number to Date for database compatibility
        const { createdAt, ...rest } = component;
        await this.db
          .update(componentTable)
          .set({
            ...rest,
            createdAt: new Date(createdAt),
          })
          .where(eq(componentTable.id, component.id));
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a swallowed update left the
        // component silently stale; surface the write failure instead.
        throw new ElizaError("updateComponent failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "components", componentId: component.id },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a component from the database.
   * @param {UUID} componentId - The unique identifier of the component to delete.
   * @returns {Promise<void>} A Promise that resolves when the component is deleted.
   */
  async deleteComponent(componentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
    });
  }

  async queryDocuments(params: DocumentListQueryParams): Promise<DocumentListQueryResult> {
    validateDocumentListQueryParams(params);
    const hasGlobalVisibility = documentRoleHasGlobalVisibility(params.requesterRole);
    const entityContext = hasGlobalVisibility ? params.agentId : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const visibleConditions: SQL[] = [
        eq(memoryTable.type, "documents"),
        eq(memoryTable.agentId, params.agentId),
        isNotNull(memoryTable.roomId),
        isNotNull(memoryTable.entityId),
        sql`${memoryTable.metadata}->>'type' = 'document'`,
      ];
      if (!hasGlobalVisibility) {
        visibleConditions.push(
          documentRoomOrDirectGrantCondition(
            params,
            params.requesterRoomIds.length > 0
              ? inArray(memoryTable.roomId, params.requesterRoomIds)
              : sql`false`
          )
        );
      }
      visibleConditions.push(documentVisibilityCondition(params));

      const availableConditions: SQL[] = [];
      if (params.scope) {
        availableConditions.push(sql`${memoryTable.metadata}->>'scope' = ${params.scope}`);
      }
      if (params.scopedToEntityId) {
        availableConditions.push(
          sql`${memoryTable.metadata}->>'scopedToEntityId' = ${params.scopedToEntityId}`
        );
      }
      if (params.addedBy) {
        availableConditions.push(sql`${memoryTable.metadata}->>'addedBy' = ${params.addedBy}`);
      }
      if (params.timeRangeStart !== undefined) {
        availableConditions.push(sql`${documentTimestampExpression()} >= ${params.timeRangeStart}`);
      }
      if (params.timeRangeEnd !== undefined) {
        availableConditions.push(sql`${documentTimestampExpression()} <= ${params.timeRangeEnd}`);
      }
      if (params.tags?.length) {
        availableConditions.push(
          sql`COALESCE(${memoryTable.metadata}->'tags', '[]'::jsonb) @> ${JSON.stringify(
            params.tags
          )}::jsonb`
        );
      }
      const availableCondition =
        availableConditions.length > 0 ? and(...availableConditions) : sql`true`;

      const normalizedQuery = params.query?.trim();
      let queryCondition: SQL = sql`true`;
      if (normalizedQuery) {
        queryCondition = sql`(
          ${documentSearchTokensExpression(memoryTable.content, memoryTable.metadata, true)}
          @> ${documentSearchQueryTokensExpression(sql`${normalizedQuery}`, true)}
        ) AND (
          ${documentSearchTokensExpression(memoryTable.content, memoryTable.metadata)}
          @> ${documentSearchQueryTokensExpression(sql`${normalizedQuery}`)}
        )`;
      }

      type DocumentRow = {
        id: string;
        type: string;
        createdAt: Date | string;
        cursorCreatedAt: Date | string;
        content: unknown;
        entityId: string | null;
        agentId: string;
        roomId: string | null;
        worldId: string | null;
        unique: boolean;
        metadata: unknown;
      };
      const databaseTimestampToMs = (value: Date | string): number => {
        const milliseconds =
          value instanceof Date
            ? value.getTime()
            : Date.parse(
                /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value) ? value : `${value.replace(" ", "T")}Z`
              );
        if (!Number.isFinite(milliseconds)) {
          throw new ElizaError("Document list query returned an invalid timestamp", {
            code: "DOCUMENT_LIST_TIMESTAMP_INVALID",
            context: { agentId: params.agentId, value },
            severity: "fatal",
          });
        }
        return milliseconds;
      };
      const mapDocument = (row: DocumentRow): Memory => ({
        id: row.id as UUID,
        createdAt: databaseTimestampToMs(row.createdAt),
        content:
          typeof row.content === "string"
            ? JSON.parse(row.content)
            : (row.content as Memory["content"]),
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        worldId: (row.worldId ?? undefined) as UUID | undefined,
        unique: row.unique,
        metadata:
          typeof row.metadata === "string"
            ? JSON.parse(row.metadata)
            : (row.metadata as MemoryMetadata),
      });

      type Page = {
        documents: Memory[];
        hasMore: boolean;
        nextCursor?: DocumentListCursor;
      };
      const buildPage = (rows: DocumentRow[]): Page => {
        const hasMore = rows.length > params.limit;
        const pageRows = rows.slice(0, params.limit);
        const documents = pageRows.map(mapDocument);
        const last = pageRows.at(-1);
        const first = pageRows.at(0);
        const snapshotCreatedAt =
          params.cursor?.snapshotCreatedAt ??
          params.cursor?.createdAt ??
          (first ? databaseTimestampToMs(first.cursorCreatedAt) : undefined);
        const snapshotId = params.cursor?.snapshotId ?? params.cursor?.id ?? first?.id;
        return {
          documents,
          hasMore,
          ...(hasMore && last && snapshotCreatedAt !== undefined && snapshotId
            ? {
                nextCursor: {
                  createdAt: databaseTimestampToMs(last.cursorCreatedAt),
                  id: last.id as UUID,
                  snapshotCreatedAt,
                  snapshotId: snapshotId as UUID,
                },
              }
            : {}),
        };
      };

      const cursorCreatedAt = sql`date_trunc('milliseconds', ${memoryTable.createdAt})`;
      if (params.cursor) {
        const snapshotCreatedAt = params.cursor.snapshotCreatedAt ?? params.cursor.createdAt;
        const snapshotId = params.cursor.snapshotId ?? params.cursor.id;
        visibleConditions.push(sql`(
          ${cursorCreatedAt} < (
            timestamp 'epoch' + ${snapshotCreatedAt} * interval '1 millisecond'
          )
          OR (
            ${cursorCreatedAt} = (
              timestamp 'epoch' + ${snapshotCreatedAt} * interval '1 millisecond'
            )
            AND ${memoryTable.id} <= ${snapshotId}::uuid
          )
        )`);
      }
      const cursorCondition = params.cursor
        ? sql`(
            ${cursorCreatedAt} < (
              timestamp 'epoch' + ${params.cursor.createdAt} * interval '1 millisecond'
            )
            OR (
              ${cursorCreatedAt} = (
                timestamp 'epoch' + ${params.cursor.createdAt} * interval '1 millisecond'
              )
              AND ${memoryTable.id} < ${params.cursor.id}::uuid
            )
          )`
        : sql`true`;
      const offsetClause = params.cursor ? sql`` : sql`OFFSET ${params.offset}`;
      const pageSize = params.limit + 1;
      const productionQuery = sql`
        WITH counts AS MATERIALIZED (
          SELECT
            (
              SELECT COUNT(*)
              FROM ${memoryTable}
              WHERE ${and(...visibleConditions)}
            ) AS total_visible,
            (
              SELECT COUNT(*)
              FROM ${memoryTable}
              WHERE ${and(...visibleConditions)} AND ${availableCondition}
            ) AS total_available,
            (
              SELECT COUNT(*)
              FROM ${memoryTable}
              WHERE
                ${and(...visibleConditions)}
                AND ${availableCondition}
                AND ${queryCondition}
            ) AS total_matched
        ),
        matched_page AS MATERIALIZED (
          SELECT
            ${memoryTable.id} AS id,
            ${memoryTable.type} AS type,
            ${memoryTable.createdAt} AS created_at,
            ${cursorCreatedAt} AS cursor_created_at,
            ${memoryTable.content} AS content,
            ${memoryTable.entityId} AS entity_id,
            ${memoryTable.agentId} AS agent_id,
            ${memoryTable.roomId} AS room_id,
            ${memoryTable.worldId} AS world_id,
            ${memoryTable.unique} AS unique,
            ${memoryTable.metadata} AS metadata,
            'matched'::text AS page_kind
          FROM ${memoryTable}
          WHERE
            ${and(...visibleConditions)}
            AND ${availableCondition}
            AND ${queryCondition}
            AND ${cursorCondition}
          ORDER BY ${cursorCreatedAt} DESC, ${memoryTable.id} DESC
          LIMIT ${pageSize}
          ${offsetClause}
        ),
        available_page AS MATERIALIZED (
          SELECT
            ${memoryTable.id} AS id,
            ${memoryTable.type} AS type,
            ${memoryTable.createdAt} AS created_at,
            ${cursorCreatedAt} AS cursor_created_at,
            ${memoryTable.content} AS content,
            ${memoryTable.entityId} AS entity_id,
            ${memoryTable.agentId} AS agent_id,
            ${memoryTable.roomId} AS room_id,
            ${memoryTable.worldId} AS world_id,
            ${memoryTable.unique} AS unique,
            ${memoryTable.metadata} AS metadata,
            'available'::text AS page_kind
          FROM ${memoryTable}
          CROSS JOIN counts
          WHERE
            ${Boolean(normalizedQuery)}
            AND counts.total_matched = 0
            AND ${and(...visibleConditions)}
            AND ${availableCondition}
            AND ${cursorCondition}
          ORDER BY ${cursorCreatedAt} DESC, ${memoryTable.id} DESC
          LIMIT ${pageSize}
          ${offsetClause}
        ),
        page_rows AS (
          SELECT * FROM matched_page
          UNION ALL
          SELECT * FROM available_page
        )
        SELECT
          counts.total_visible AS "totalVisible",
          counts.total_available AS "totalAvailable",
          counts.total_matched AS "totalMatched",
          page_rows.page_kind AS "pageKind",
          page_rows.id,
          page_rows.type,
          page_rows.created_at AS "createdAt",
          page_rows.cursor_created_at AS "cursorCreatedAt",
          page_rows.content,
          page_rows.entity_id AS "entityId",
          page_rows.agent_id AS "agentId",
          page_rows.room_id AS "roomId",
          page_rows.world_id AS "worldId",
          page_rows.unique,
          page_rows.metadata
        FROM counts
        LEFT JOIN page_rows ON true
        ORDER BY
          CASE page_rows.page_kind WHEN 'matched' THEN 0 ELSE 1 END,
          page_rows.cursor_created_at DESC,
          page_rows.id DESC
      `;
      this.lastDocumentListStatement = { query: productionQuery, entityContext };
      const result = await tx.execute(productionQuery);
      type QueryRow = Partial<DocumentRow> & {
        totalVisible: unknown;
        totalAvailable: unknown;
        totalMatched: unknown;
        pageKind: "matched" | "available" | null;
      };
      const rows = result.rows as QueryRow[];
      const countRow = rows[0];
      if (!countRow) {
        throw new ElizaError("Document list query returned no count row", {
          code: "DOCUMENT_LIST_COUNT_MISSING",
          context: { agentId: params.agentId },
          severity: "fatal",
        });
      }
      const parseCount = (value: unknown, label: string): number => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new ElizaError("Document list query returned an invalid count", {
            code: "DOCUMENT_LIST_COUNT_INVALID",
            context: { agentId: params.agentId, label, value: String(value) },
            severity: "fatal",
          });
        }
        return parsed;
      };
      const totalVisible = parseCount(countRow.totalVisible, "visible");
      const totalAvailable = parseCount(countRow.totalAvailable, "available");
      const totalMatched = parseCount(countRow.totalMatched, "matched");
      const matchedRows = rows.filter(
        (row): row is QueryRow & DocumentRow => row.pageKind === "matched"
      );
      const availableRows = rows.filter(
        (row): row is QueryRow & DocumentRow => row.pageKind === "available"
      );
      const matchedPage = buildPage(matchedRows);
      const availablePage = buildPage(availableRows);

      return {
        documents: matchedPage.documents,
        availableDocuments: availablePage.documents,
        totalVisible,
        totalAvailable,
        totalMatched,
        hasMore: matchedPage.hasMore,
        availableHasMore: availablePage.hasMore,
        ...(matchedPage.nextCursor ? { nextCursor: matchedPage.nextCursor } : {}),
        ...(availablePage.nextCursor ? { availableNextCursor: availablePage.nextCursor } : {}),
      };
    });
  }

  /**
   * Explains the exact most recently executed document-list CTE. This is a
   * diagnostics boundary for real database regression tests; callers must run
   * it immediately after the query they are measuring.
   */
  async explainLastDocumentListQuery(): Promise<unknown[]> {
    const statement = this.lastDocumentListStatement;
    if (!statement) {
      throw new ElizaError("No document-list query is available to explain", {
        code: "DOCUMENT_LIST_EXPLAIN_UNAVAILABLE",
      });
    }
    return this.withEntityContext(statement.entityContext, async (tx) => {
      const result = await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`
      );
      return result.rows;
    });
  }

  private documentReadConditions(
    params: DocumentGetQueryParams | DocumentCompareAndSwapParams | DocumentDeleteParams
  ): SQL[] {
    const hasGlobalVisibility = documentRoleHasGlobalVisibility(params.requesterRole);
    return [
      eq(memoryTable.id, params.documentId),
      eq(memoryTable.type, "documents"),
      eq(memoryTable.agentId, params.agentId),
      isNotNull(memoryTable.roomId),
      isNotNull(memoryTable.entityId),
      sql`${memoryTable.metadata}->>'type' = 'document'`,
      ...(hasGlobalVisibility
        ? []
        : [
            documentRoomOrDirectGrantCondition(
              params,
              params.requesterRoomIds.length > 0
                ? inArray(memoryTable.roomId, params.requesterRoomIds)
                : sql`false`
            ),
          ]),
      documentVisibilityCondition(params),
    ];
  }

  private documentStorageConditions(
    params: DocumentCompareAndSwapParams | DocumentDeleteParams
  ): SQL[] {
    return [
      eq(memoryTable.id, params.documentId),
      eq(memoryTable.type, "documents"),
      eq(memoryTable.agentId, params.agentId),
      sql`${memoryTable.metadata}->>'type' = 'document'`,
    ];
  }

  async getDocument(params: DocumentGetQueryParams): Promise<Memory | null> {
    validateDocumentRequesterContext(params);
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryTable)
        .where(and(...this.documentReadConditions(params)))
        .limit(1);
      return rows[0] ? memoryFromRow(rows[0]) : null;
    });
  }

  async readDocumentRange(
    params: DocumentRangeReadParams
  ): Promise<DocumentRangeReadResult | null> {
    validateDocumentRequesterContext(params);
    if (
      !Number.isSafeInteger(params.offset) ||
      params.offset < 0 ||
      (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1))
    ) {
      throw new ElizaError(
        "Document range read requires a non-negative offset and positive limit",
        {
          code: "DOCUMENT_READ_INVALID_RANGE",
        }
      );
    }
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const linePattern = "([^\\r\\n]*(?:\\r\\n|\\r|\\n)|[^\\r\\n]+$)";
      const units =
        params.unit === "line"
          ? sql`line_units AS (
              SELECT matched[1] AS unit_text, ordinal - 1 AS unit_index
              FROM authorized
              CROSS JOIN LATERAL regexp_matches(source_text, ${linePattern}, 'g')
                WITH ORDINALITY AS matches(matched, ordinal)
            )`
          : sql`raw_lines AS (
              SELECT matched[1] AS unit_text, ordinal - 1 AS line_index
              FROM authorized
              CROSS JOIN LATERAL regexp_matches(source_text, ${linePattern}, 'g')
                WITH ORDINALITY AS matches(matched, ordinal)
            ), grouped_lines AS (
              SELECT unit_text, line_index,
                COALESCE(SUM(
                  CASE WHEN btrim(regexp_replace(unit_text, E'[\\r\\n]', '', 'g')) = ''
                    THEN 1 ELSE 0 END
                ) OVER (
                  ORDER BY line_index
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0) AS unit_index
              FROM raw_lines
            ), line_units AS (
              SELECT string_agg(unit_text, '' ORDER BY line_index) AS unit_text, unit_index
              FROM grouped_lines
              GROUP BY unit_index
            )`;
      const rangeFilter =
        params.limit === undefined
          ? sql`unit_index >= ${params.offset}`
          : sql`unit_index >= ${params.offset}
              AND unit_index < ${params.offset + params.limit}`;
      const result = await tx.execute(sql`
        WITH authorized AS (
          SELECT content->>'text' AS source_text, metadata
          FROM ${memoryTable}
          WHERE ${and(...this.documentReadConditions(params))}
          LIMIT 1
        ), ${units}
        SELECT
          COALESCE(
            string_agg(unit_text, '' ORDER BY unit_index)
              FILTER (
                WHERE ${rangeFilter}
              ),
            ''
          ) AS text,
          COUNT(*)::integer AS total,
          (SELECT COALESCE((metadata->>'documentRevision')::integer, 0) FROM authorized)
            AS document_revision,
          (SELECT metadata->>'revisionAttemptId' FROM authorized) AS revision_attempt_id,
          (SELECT md5(source_text) FROM authorized) AS source_fingerprint
        FROM line_units
      `);
      const row = result.rows[0] as
        | {
            text?: unknown;
            total?: unknown;
            document_revision?: unknown;
            revision_attempt_id?: unknown;
            source_fingerprint?: unknown;
          }
        | undefined;
      if (!row || typeof row.source_fingerprint !== "string") return null;
      const total = Number(row.total);
      const start = params.offset;
      return {
        text: typeof row.text === "string" ? row.text : "",
        start,
        end: params.limit === undefined ? total : Math.min(start + params.limit, total),
        total,
        documentRevision: Number(row.document_revision ?? 0),
        ...(typeof row.revision_attempt_id === "string"
          ? { revisionAttemptId: row.revision_attempt_id }
          : {}),
        sourceFingerprint: `md5:${row.source_fingerprint}`,
      };
    });
  }

  async queryDocumentFragments(params: DocumentFragmentQueryParams): Promise<Memory[]> {
    const expectedEmbeddingDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
    validateDocumentFragmentQueryParams(params, expectedEmbeddingDimension);
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const parent = alias(memoryTable, "document_parent");
      const fragment = alias(memoryTable, "document_fragment");
      const hasGlobalVisibility = documentRoleHasGlobalVisibility(params.requesterRole);
      const conditions: SQL[] = [
        eq(parent.type, "documents"),
        eq(parent.agentId, params.agentId),
        isNotNull(parent.roomId),
        isNotNull(parent.entityId),
        sql`${parent.metadata}->>'type' = 'document'`,
        eq(fragment.type, "document_fragments"),
        eq(fragment.agentId, params.agentId),
        sql`${fragment.metadata}->>'type' = 'fragment'`,
        validDocumentRevision(fragment.metadata),
        sql`${documentRevisionExpression(fragment.metadata)}
          = ${documentRevisionExpression(parent.metadata)}`,
        // When the parent commits an update attempt token, only fragments
        // staged by that attempt are readable; concurrent losing attempts
        // stage the same revision number but a different token.
        sql`(
          NOT (${parent.metadata} ? 'revisionAttemptId')
          OR ${fragment.metadata}->>'revisionAttemptId'
            = ${parent.metadata}->>'revisionAttemptId'
        )`,
        documentVisibilityCondition(params, parent.metadata),
      ];
      if (!hasGlobalVisibility) {
        conditions.push(
          documentRoomOrDirectGrantCondition(
            params,
            params.requesterRoomIds.length > 0
              ? inArray(parent.roomId, params.requesterRoomIds)
              : sql`false`,
            parent.metadata
          )
        );
      }
      if (params.roomId) conditions.push(eq(parent.roomId, params.roomId));
      if (params.worldId) conditions.push(eq(parent.worldId, params.worldId));
      if (params.entityId) conditions.push(eq(parent.entityId, params.entityId));
      if (params.documentId) conditions.push(eq(parent.id, params.documentId));

      const parentJoin = sql`${parent.id}::text = ${fragment.metadata}->>'documentId'`;
      if (!params.embedding) {
        const rows = await tx
          .select({
            memory: fragment,
            sourceFingerprint: sql<string>`md5(${parent.content}->>'text')`,
          })
          .from(fragment)
          .innerJoin(parent, parentJoin)
          .where(and(...conditions))
          .orderBy(desc(fragment.createdAt), desc(fragment.id))
          .limit(params.limit)
          .offset(params.offset ?? 0);
        return rows.map((row) => {
          const memory = memoryFromRow(row.memory);
          return {
            ...memory,
            metadata: {
              ...(memory.metadata ?? {}),
              sourceFingerprint: `md5:${row.sourceFingerprint}`,
            } as Memory["metadata"],
          };
        });
      }

      const activeColumn = embeddingTable[this.embeddingDimension];
      const distance = cosineDistance(activeColumn, params.embedding);
      const similarity = sql<number>`1 - (${distance})`;
      conditions.push(isNotNull(activeColumn));
      if (params.matchThreshold !== undefined) {
        conditions.push(gte(similarity, params.matchThreshold));
      }
      const rows = await tx
        .select({
          memory: fragment,
          embedding: activeColumn,
          similarity,
          sourceFingerprint: sql<string>`md5(${parent.content}->>'text')`,
        })
        .from(embeddingTable)
        .innerJoin(fragment, eq(fragment.id, embeddingTable.memoryId))
        .innerJoin(parent, parentJoin)
        .where(and(...conditions))
        .orderBy(asc(distance), desc(fragment.createdAt), desc(fragment.id))
        .limit(params.limit)
        .offset(params.offset ?? 0);
      return rows.map((row) => {
        const memory = memoryFromRow(
          row.memory,
          row.embedding ? Array.from(row.embedding) : undefined,
          row.similarity
        );
        return {
          ...memory,
          metadata: {
            ...(memory.metadata ?? {}),
            sourceFingerprint: `md5:${row.sourceFingerprint}`,
          } as Memory["metadata"],
        };
      });
    });
  }

  async compareAndSwapDocument(
    params: DocumentCompareAndSwapParams
  ): Promise<DocumentMutationResult> {
    validateDocumentRequesterContext(params);
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryTable)
        .where(and(...this.documentStorageConditions(params)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "not_found" };
      const existing = memoryFromRow(row);
      if (!documentMutationSnapshotMatches(existing, params.expected)) {
        return { status: "conflict" };
      }
      if (!canRequesterMutateDocument(existing, params)) return { status: "forbidden" };
      const replacement = params.replacement;
      const content = serializeDocumentJsonb(replacement.content);
      const metadata = serializeJsonb(replacement.metadata ?? {});
      const updated = await tx
        .update(memoryTable)
        .set({
          content: sql`${content}::jsonb`,
          entityId: replacement.entityId,
          roomId: replacement.roomId,
          worldId: replacement.worldId,
          unique: replacement.unique ?? row.unique,
          metadata: sql`${metadata}::jsonb`,
        })
        .where(eq(memoryTable.id, params.documentId))
        .returning();
      return updated[0]
        ? { status: "updated", document: memoryFromRow(updated[0]) }
        : { status: "conflict" };
    });
  }

  async updateDocumentDirectGrants(
    params: DocumentDirectGrantUpdateParams
  ): Promise<DocumentMutationResult> {
    validateDocumentRequesterContext(params);
    const directGrantEntityIds = validateDocumentDirectGrantEntityIds(params.directGrantEntityIds);
    return this.withEntityContext(params.agentId, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryTable)
        .where(and(...this.documentStorageConditions(params)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "not_found" };
      const existing = memoryFromRow(row);
      if (!documentMutationSnapshotMatches(existing, params.expected)) {
        return { status: "conflict" };
      }
      if (!canRequesterManageDocumentDirectGrants(existing, params)) {
        return { status: "forbidden" };
      }
      if (params.requesterRole === "ADMIN") {
        // Serialize against membership removal before granting durable access.
        const [membership] = await tx
          .select({ id: participantTable.id })
          .from(participantTable)
          .where(
            and(
              eq(participantTable.agentId, params.agentId),
              eq(participantTable.roomId, existing.roomId),
              eq(participantTable.entityId, params.requesterEntityId)
            )
          )
          .for("share")
          .limit(1);
        if (!membership) return { status: "forbidden" };
      }
      if (directGrantEntityIds.length > 0) {
        const grantees = await tx
          .select({ id: entityTable.id })
          .from(entityTable)
          .where(
            and(
              inArray(entityTable.id, directGrantEntityIds),
              eq(entityTable.agentId, params.agentId)
            )
          );
        if (grantees.length !== directGrantEntityIds.length) {
          return { status: "not_found" };
        }
      }
      const metadata = { ...((row.metadata ?? {}) as Record<string, unknown>) };
      if (directGrantEntityIds.length > 0) {
        metadata.directGrantEntityIds = directGrantEntityIds;
      } else {
        delete metadata.directGrantEntityIds;
      }
      const updated = await tx
        .update(memoryTable)
        .set({ metadata })
        .where(eq(memoryTable.id, params.documentId))
        .returning();
      return updated[0]
        ? { status: "updated", document: memoryFromRow(updated[0]) }
        : { status: "conflict" };
    });
  }

  async replaceDocumentRevision(
    params: DocumentRevisionReplaceParams
  ): Promise<DocumentMutationResult & { removedFragmentIds?: UUID[] }> {
    validateDocumentRevisionReplacement(params);
    this.validateMemoryBatchEmbeddings(
      params.fragments.map((memory) => ({ memory, tableName: "document_fragments" }))
    );
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryTable)
        .where(and(...this.documentStorageConditions(params)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "not_found" };
      const existing = memoryFromRow(row);
      if (!documentMutationSnapshotMatches(existing, params.expected)) {
        return { status: "conflict" };
      }
      if (!canRequesterMutateDocument(existing, params)) return { status: "forbidden" };

      const oldFragments = await tx
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(
          and(
            eq(memoryTable.type, "document_fragments"),
            eq(memoryTable.agentId, params.agentId),
            sql`${memoryTable.metadata}->>'type' = 'fragment'`,
            sql`${memoryTable.metadata}->>'documentId' = ${params.documentId}`
          )
        );
      const oldFragmentIds = new Set(oldFragments.map(({ id }) => String(id)));
      const reusedFragment = params.fragments.find(({ id }) => oldFragmentIds.has(String(id)));
      if (reusedFragment) {
        throw new ElizaError("Atomic document fragment id already exists", {
          code: "DOCUMENT_REVISION_FRAGMENT_ID_CONFLICT",
          context: { documentId: params.documentId, fragmentId: reusedFragment.id },
        });
      }
      if (oldFragments.length > 0) {
        const deleted = await tx
          .delete(memoryTable)
          .where(
            inArray(
              memoryTable.id,
              oldFragments.map(({ id }) => id)
            )
          )
          .returning();
        if (deleted.length !== oldFragments.length) {
          throw new ElizaError("Atomic document replacement did not delete every old fragment", {
            code: "DOCUMENT_REVISION_DELETE_INCOMPLETE",
            context: {
              documentId: params.documentId,
              expected: oldFragments.length,
              deleted: deleted.length,
            },
          });
        }
      }
      for (const fragment of params.fragments) {
        await this.insertMemoryInTransaction(
          tx,
          fragment,
          "document_fragments",
          fragment.id as UUID,
          true
        );
      }
      const replacement = params.replacement;
      const content = serializeDocumentJsonb(replacement.content);
      const metadata = serializeJsonb(replacement.metadata ?? {});
      const updated = await tx
        .update(memoryTable)
        .set({
          content: sql`${content}::jsonb`,
          entityId: replacement.entityId,
          roomId: replacement.roomId,
          worldId: replacement.worldId,
          unique: replacement.unique ?? row.unique,
          metadata: sql`${metadata}::jsonb`,
        })
        .where(eq(memoryTable.id, params.documentId))
        .returning();
      if (updated.length !== 1) {
        throw new ElizaError("Atomic document replacement did not update its parent", {
          code: "DOCUMENT_REVISION_PARENT_UPDATE_INCOMPLETE",
          context: { documentId: params.documentId, updated: updated.length },
        });
      }
      return {
        status: "updated",
        document: memoryFromRow(updated[0]),
        removedFragmentIds: oldFragments.map(({ id }) => id),
      };
    });
  }

  async deleteDocumentWithSnapshot(params: DocumentDeleteParams): Promise<DocumentMutationResult> {
    validateDocumentRequesterContext(params);
    const entityContext = documentRoleHasGlobalVisibility(params.requesterRole)
      ? params.agentId
      : params.requesterEntityId;
    return this.withEntityContext(entityContext, async (tx) => {
      const rows = await tx
        .select()
        .from(memoryTable)
        .where(and(...this.documentStorageConditions(params)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "not_found" };
      const existing = memoryFromRow(row);
      if (!documentMutationSnapshotMatches(existing, params.expected)) {
        return { status: "conflict" };
      }
      if (!canRequesterMutateDocument(existing, params)) return { status: "forbidden" };
      await tx
        .delete(memoryTable)
        .where(
          and(
            inArray(memoryTable.type, ["documents", "document_fragments"]),
            eq(memoryTable.agentId, params.agentId),
            sql`${memoryTable.metadata}->>'type' = 'fragment'`,
            sql`${memoryTable.metadata}->>'documentId' = ${params.documentId}`
          )
        );
      const deleted = await tx
        .delete(memoryTable)
        .where(eq(memoryTable.id, params.documentId))
        .returning();
      return deleted[0] ? { status: "deleted", document: existing } : { status: "conflict" };
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID} params.roomId - The ID of the room to retrieve memories for.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {number} [params.offset] - The offset for pagination.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @param {number} [params.start] - The start date to retrieve memories from.
   * @param {number} [params.end] - The end date to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemories(params: {
    entityId?: UUID;
    authorEntityIds?: UUID[];
    agentId?: UUID;
    limit?: number;
    count?: number;
    offset?: number;
    cursor?: { createdAt: number; id: UUID };
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    excludeRoomIds?: UUID[];
    worldId?: UUID;
    textContains?: string;
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
    /**
     * When `false`, skip fetching/materializing the embedding vector. List and
     * browse callers discard embeddings, so fetching the 384-float column for
     * every row (via the embeddingTable join) is pure waste. Defaults to `true`
     * (embeddings included) to preserve existing behavior.
     */
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    const { entityId, agentId, roomId, worldId, unique, start, end, offset, cursor } = params;
    const includeEmbedding = params.includeEmbedding !== false;
    const tableName = params.tableName;
    // tableName is required by the IDatabaseAdapter contract (there is no
    // default table for reads). Untyped callers that omit it must get a loud
    // error, not a silent empty result from `type = undefined`.
    if (!tableName) {
      throw new Error("getMemories requires tableName");
    }
    const textContains = params.textContains?.trim();
    // Honor either `limit` (canonical) or `count` (legacy) so callers that pass
    // only `limit` still get a LIMIT clause applied (see IDatabaseAdapter.getMemories).
    const effectiveLimit = params.limit ?? params.count;
    // Default newest-first; `orderDirection: "asc"` powers around-message paging
    // (load the messages immediately *after* an anchor, not the newest tail).
    // `Memory.createdAt` is a JavaScript millisecond timestamp. PostgreSQL
    // stores microseconds, so keyset ordering must truncate to the precision
    // represented by the cursor; comparing the raw column to a reconstructed
    // Date would skip rows later in the same millisecond.
    const cursorCreatedAt = sql`date_trunc('milliseconds', ${memoryTable.createdAt})`;
    const order =
      params.orderDirection === "asc"
        ? [asc(cursorCreatedAt), asc(memoryTable.id)]
        : [desc(cursorCreatedAt), desc(memoryTable.id)];

    if (offset !== undefined && offset < 0) {
      throw new Error("offset must be a non-negative number");
    }
    if (cursor && offset !== undefined) {
      throw new Error("getMemories cursor and offset are mutually exclusive");
    }

    return this.withEntityContext(entityId ?? null, async (tx) => {
      const conditions = [eq(memoryTable.type, tableName)];

      conditions.push(
        ...memoryAccessContextConditions(params.accessContext, this.agentId, tableName)
      );

      if (start !== undefined) {
        conditions.push(gte(memoryTable.createdAt, new Date(start)));
      }

      // RLS handles access control - no explicit entityId filter needed

      if (params.authorEntityIds) {
        conditions.push(
          params.authorEntityIds.length === 0
            ? sql`false`
            : inArray(memoryTable.entityId, params.authorEntityIds)
        );
      }

      if (roomId) {
        conditions.push(eq(memoryTable.roomId, roomId));
      }

      if (params.excludeRoomIds && params.excludeRoomIds.length > 0) {
        conditions.push(notInArray(memoryTable.roomId, params.excludeRoomIds));
      }

      // Add worldId condition
      if (worldId) {
        conditions.push(eq(memoryTable.worldId, worldId));
      }

      if (end !== undefined) {
        conditions.push(lte(memoryTable.createdAt, new Date(end)));
      }

      if (cursor) {
        const cursorTimestamp = sql`(
          timestamp 'epoch' + ${cursor.createdAt} * interval '1 millisecond'
        )`;
        conditions.push(
          params.orderDirection === "asc"
            ? sql`(
                ${cursorCreatedAt} > ${cursorTimestamp}
                OR (${cursorCreatedAt} = ${cursorTimestamp} AND ${memoryTable.id} > ${cursor.id}::uuid)
              )`
            : sql`(
                ${cursorCreatedAt} < ${cursorTimestamp}
                OR (${cursorCreatedAt} = ${cursorTimestamp} AND ${memoryTable.id} < ${cursor.id}::uuid)
              )`
        );
      }

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      // An adapter is bound to one agent; a read that names no agent is a read
      // of that agent's memories. Relying on RLS alone leaked one agent's facts
      // into another agent's prompt on a database without RLS policies (live
      // 2026-09-06: the owner's facts stored by a second agent rendered in the
      // first agent's FACTS block and could not be forgotten from it).
      conditions.push(eq(memoryTable.agentId, agentId ?? this.agentId));

      if (textContains) {
        // Push the keyword filter into the store as a case-insensitive ILIKE;
        // user input is escaped so `%`/`_` match literally, not as wildcards.
        // This is a sequential filter over `content->>'text'`, not index-backed.
        // TODO(#9955): pg_trgm GIN index on content->>'text' for sub-linear
        // keyword search at scale.
        conditions.push(
          sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(textContains)}%`} ESCAPE '\\'`
        );
      }

      const memorySelect = {
        id: memoryTable.id,
        type: memoryTable.type,
        createdAt: memoryTable.createdAt,
        content: memoryTable.content,
        entityId: memoryTable.entityId,
        agentId: memoryTable.agentId,
        roomId: memoryTable.roomId,
        worldId: memoryTable.worldId,
        unique: memoryTable.unique,
        metadata: memoryTable.metadata,
      };
      type SelectedMemory = {
        id: string;
        type: string;
        createdAt: Date;
        content: unknown;
        entityId: string | null;
        agentId: string;
        roomId: string | null;
        worldId: string | null;
        unique: boolean;
        metadata: unknown;
      };
      const mapRow = (m: SelectedMemory, embedding: ArrayLike<number> | null | undefined) => ({
        id: m.id as UUID,
        type: m.type,
        createdAt: m.createdAt.getTime(),
        content: typeof m.content === "string" ? JSON.parse(m.content) : m.content,
        entityId: m.entityId as UUID,
        agentId: m.agentId as UUID,
        roomId: m.roomId as UUID,
        // Include worldId (matching searchMemoriesByEmbedding): dropping it here
        // stripped the world association from every read — e.g. agent-export
        // round-trips silently lost memory→world links on restore.
        worldId: (m.worldId ?? undefined) as UUID | undefined,
        unique: m.unique,
        metadata: m.metadata as MemoryMetadata,
        embedding: embedding ? Array.from(embedding) : undefined,
      });

      if (includeEmbedding) {
        const baseQuery = tx
          .select({
            memory: memorySelect,
            embedding: embeddingTable[this.embeddingDimension],
          })
          .from(memoryTable)
          .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
          .where(and(...conditions))
          .orderBy(...order);
        const rows = await (async () => {
          // Honor `effectiveLimit` (params.limit ?? params.count), matching the
          // no-embedding branch below. Gating the LIMIT on `params.count` alone
          // meant any caller passing only `limit` got NO limit clause and the
          // whole table back (e.g. evaluator recent-message fetches returning
          // thousands of rows instead of 10).
          if (effectiveLimit && offset !== undefined && offset > 0) {
            return baseQuery.limit(effectiveLimit).offset(offset);
          } else if (effectiveLimit) {
            return baseQuery.limit(effectiveLimit);
          } else if (offset !== undefined && offset > 0) {
            return baseQuery.offset(offset);
          } else {
            return baseQuery;
          }
        })();
        return rows.map((row) => mapRow(row.memory as SelectedMemory, row.embedding));
      }

      // includeEmbedding === false: skip the embeddingTable join + column. The
      // left join never filtered rows, so the result set is identical — only the
      // 384-float vector is omitted (callers that requested this discard it).
      const baseQuery = tx
        .select({ memory: memorySelect })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(...order);
      const rows = await (async () => {
        if (effectiveLimit && offset !== undefined && offset > 0) {
          return baseQuery.limit(effectiveLimit).offset(offset);
        } else if (effectiveLimit) {
          return baseQuery.limit(effectiveLimit);
        } else if (offset !== undefined && offset > 0) {
          return baseQuery.offset(offset);
        } else {
          return baseQuery;
        }
      })();
      return rows.map((row) => mapRow(row.memory as SelectedMemory, undefined));
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
   * @param {string} params.tableName - The name of the table to retrieve memories from.
   * @param {number} [params.limit] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
    offset?: number;
    textContains?: string;
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];

      const conditions = [
        eq(memoryTable.type, params.tableName),
        inArray(memoryTable.roomId, params.roomIds),
        ...memoryAccessContextConditions(params.accessContext, this.agentId, params.tableName),
      ];

      conditions.push(eq(memoryTable.agentId, this.agentId));

      const textContains = params.textContains?.trim();
      if (textContains) {
        // Same case-insensitive keyword predicate as getMemories: a sequential
        // ILIKE over `content->>'text'` (not index-backed). Escaped so `%`/`_`
        // match literally. Scoping to roomIds first narrows the scan via the
        // (type, roomId) index. TODO(#9955): pg_trgm GIN index for scale.
        conditions.push(
          sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(textContains)}%`} ESCAPE '\\'`
        );
      }

      const baseQuery = this.db
        .select({
          id: memoryTable.id,
          type: memoryTable.type,
          createdAt: memoryTable.createdAt,
          content: memoryTable.content,
          entityId: memoryTable.entityId,
          agentId: memoryTable.agentId,
          roomId: memoryTable.roomId,
          worldId: memoryTable.worldId,
          unique: memoryTable.unique,
          metadata: memoryTable.metadata,
        })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt), desc(memoryTable.id));

      const { limit, offset } = params;
      const rows = await (async () => {
        if (limit !== undefined && offset !== undefined && offset > 0) {
          return baseQuery.limit(limit).offset(offset);
        } else if (limit !== undefined) {
          return baseQuery.limit(limit);
        } else if (offset !== undefined && offset > 0) {
          return baseQuery.offset(offset);
        }
        return baseQuery;
      })();

      return rows.map((row) => ({
        id: row.id as UUID,
        createdAt: row.createdAt.getTime(),
        content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        worldId: (row.worldId ?? undefined) as UUID | undefined,
        unique: row.unique,
        metadata: row.metadata,
      })) as Memory[];
    });
  }

  /**
   * Corpus-wide full-text + trigram message search (#13534). Ranks in the store
   * with Postgres `ts_rank_cd` over a `websearch_to_tsquery` match (multi-word,
   * quoted phrases, `-negation`) plus a `pg_trgm`-accelerated `LIKE` fallback for
   * partial-word/typo/code/URL/emoji/CJK tokens the FTS lexer misses — both over
   * the GIN-indexed `eliza_message_search_document(content)` expression so the
   * plan is index-backed, not an O(n) `ILIKE` scan. The query and the stored
   * document are folded identically (`eliza_search_fold`: lowercase, strip
   * accents/apostrophes) so "café"/"cafe" and "don't"/"dont" agree. Room-scoping,
   * `agentId`, and LIMIT/OFFSET are all applied in SQL, after ranking, so a
   * relevant hit older than any recency window is still found and ordered.
   */
  async searchMessages(params: {
    roomIds: UUID[];
    query: string;
    tableName?: string;
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
    accessContext?: AccessContext;
  }): Promise<MessageSearchHit[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];
      const tableName = params.tableName ?? "messages";
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      // Inclusive created_at window, applied with the match predicate BEFORE
      // ranking and LIMIT/OFFSET so a "one year ago" window never loses hits to
      // a recency-truncated slice. Both branches below share these conditions.
      const timeConditions: SQL[] = [];
      if (typeof params.since === "number") {
        timeConditions.push(gte(memoryTable.createdAt, new Date(params.since)));
      }
      if (typeof params.until === "number") {
        timeConditions.push(lte(memoryTable.createdAt, new Date(params.until)));
      }
      const trigramAvailable = await this.isTrigramAvailable();

      // Fold the query in SQL with the same function the document is folded with.
      const foldedQuery = sql`eliza_search_fold(${params.query})`;
      // Read the pre-folded document from the STORED generated column rather than
      // recomputing the fold+attachment function per row — that materialization
      // is what keeps the trigram/LIKE fallback off the O(n)-recompute hot path.
      const document = sql`message_search_document`;
      const tsvector = sql`to_tsvector('english', ${document})`;
      const tsquery = sql`websearch_to_tsquery('english', ${foldedQuery})`;
      const ftsRankExpr = sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`;
      const allowLexicalFallback = !usesWebsearchSyntax(params.query);
      // `similarity()` only exists when pg_trgm is installed; degrade to 0 so the
      // ORDER BY and DTO carry a real (extension-absent) signal, not a fake rank.
      const trigramExpr = trigramAvailable
        ? sql<number>`GREATEST(similarity(${document}, ${foldedQuery}), word_similarity(${foldedQuery}, ${document}))`
        : sql<number>`0`;
      const literalMatch = allowLexicalFallback
        ? sql`${document} LIKE eliza_search_like_pattern(${params.query})`
        : sql`FALSE`;
      // The trigram fallback is a bag-of-terms AND: it has no notion of phrase
      // adjacency, term exclusion, or union. Every websearch operator would be
      // silently relaxed by it — `"alpha beta"` would match non-adjacent rows,
      // `alpha -far` would match rows containing `far`, and `alpha OR zephyr`
      // would degrade to a conjunction. Any websearch syntax therefore stays
      // FTS-only, matching the `literalMatch` gate above.
      const trigramMatch =
        trigramAvailable && allowLexicalFallback
          ? sql`NOT EXISTS (
            SELECT 1
            FROM unnest(regexp_split_to_array(${foldedQuery}, '[[:space:]]+')) AS query_terms(term)
            WHERE query_terms.term <> ''
              AND NOT (
                ${document} LIKE eliza_search_like_pattern(query_terms.term)
                OR word_similarity(query_terms.term, ${document}) >= 0.45
              )
          )`
          : sql`FALSE`;

      const conditions = [
        eq(memoryTable.type, tableName),
        eq(memoryTable.agentId, this.agentId),
        inArray(memoryTable.roomId, params.roomIds),
        ...memoryAccessContextConditions(params.accessContext, this.agentId, tableName),
        ...timeConditions,
        sql`(${tsvector} @@ ${tsquery} OR ${literalMatch} OR ${trigramMatch})`,
      ];

      let rows: Array<{
        id: string;
        createdAt: Date;
        content: unknown;
        entityId: string | null;
        agentId: string;
        roomId: string | null;
        worldId: string | null;
        unique: boolean;
        metadata: unknown;
        ftsRank: unknown;
        trigramSimilarity: unknown;
      }>;
      try {
        rows = await this.db
          .select({
            id: memoryTable.id,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            worldId: memoryTable.worldId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
            ftsRank: ftsRankExpr.as("fts_rank"),
            trigramSimilarity: trigramExpr.as("trgm_sim"),
          })
          .from(memoryTable)
          .where(and(...conditions))
          .orderBy(
            sql`fts_rank DESC`,
            sql`trgm_sim DESC`,
            desc(memoryTable.createdAt),
            asc(memoryTable.id)
          )
          .limit(limit)
          .offset(offset);
      } catch (error) {
        if (!isMessageSearchObjectsMissing(error)) {
          throw error;
        }
        // error-policy:J4 production Postgres can deliberately skip the heavy
        // generated-column/index DDL at startup; until an operator applies it,
        // keep search functional with the older sequential text/attachment scan.
        logger.warn(
          {
            src: "plugin:sql",
            error: error instanceof Error ? error.message : String(error),
          },
          "[MessageSearch] search objects are missing; falling back to sequential message search"
        );
        rows = await this.db
          .select({
            id: memoryTable.id,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            worldId: memoryTable.worldId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
            ftsRank: sql<number>`0`.as("fts_rank"),
            trigramSimilarity: sql<number>`0`.as("trgm_sim"),
          })
          .from(memoryTable)
          .where(
            and(
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId),
              inArray(memoryTable.roomId, params.roomIds),
              ...memoryAccessContextConditions(params.accessContext, this.agentId, tableName),
              ...timeConditions,
              or(
                sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(params.query)}%`} ESCAPE '\\'`,
                sql`${memoryTable.content}::text ILIKE ${`%${escapeIlikeLiteral(params.query)}%`} ESCAPE '\\'`
              )
            )
          )
          .orderBy(desc(memoryTable.createdAt), asc(memoryTable.id))
          .limit(limit)
          .offset(offset);
      }

      return rows.map((row) => ({
        memory: {
          id: row.id as UUID,
          createdAt: row.createdAt.getTime(),
          content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
          entityId: row.entityId as UUID,
          agentId: row.agentId as UUID,
          roomId: row.roomId as UUID,
          worldId: (row.worldId ?? undefined) as UUID | undefined,
          unique: row.unique,
          metadata: row.metadata,
        } as Memory,
        ftsRank: Number(row.ftsRank),
        trigramSimilarity: Number(row.trigramSimilarity),
      }));
    });
  }

  /**
   * Whether `pg_trgm` is installed, memoized per adapter. Gates the `similarity`
   * ranking + gin_trgm_ops `LIKE` acceleration in {@link searchMessages}.
   */
  private async isTrigramAvailable(): Promise<boolean> {
    if (this.messageSearchTrigramAvailable !== null) {
      return this.messageSearchTrigramAvailable;
    }
    const result = await this.db.execute(
      sql`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`
    );
    const rows = (result as { rows?: unknown[] }).rows ?? result;
    this.messageSearchTrigramAvailable = Array.isArray(rows) && rows.length > 0;
    return this.messageSearchTrigramAvailable;
  }

  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(eq(memoryTable.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const row = result[0];
      return {
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: (row.memory.worldId ?? undefined) as UUID | undefined,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      };
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (memoryIds.length === 0) return [];

      const conditions = [inArray(memoryTable.id, memoryIds)];

      if (tableName) {
        conditions.push(eq(memoryTable.type, tableName));
      }

      const rows = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: (row.memory.worldId ?? undefined) as UUID | undefined,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      }));
    });
  }

  /**
   * Asynchronously retrieves cached embeddings from the database based on the provided parameters.
   * @param {Object} opts - The parameters for retrieving cached embeddings.
   * @param {string} opts.query_table_name - The name of the table to retrieve embeddings from.
   * @param {number} opts.query_threshold - The threshold for the levenshtein distance.
   * @param {string} opts.query_input - The input string to search for.
   * @param {string} opts.query_field_name - The name of the field to retrieve embeddings from.
   * @param {string} opts.query_field_sub_name - The name of the sub-field to retrieve embeddings from.
   * @param {number} opts.query_match_count - The maximum number of matches to retrieve.
   * @returns {Promise<{ embedding: number[]; levenshtein_score: number }[]>} A Promise that resolves to an array of cached embeddings.
   */
  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.withDatabase(async () => {
      try {
        // Drizzle database has execute method for raw SQL
        interface DrizzleDatabaseWithExecute {
          execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }>;
        }
        const results = await (this.db as DrizzleDatabaseWithExecute).execute(sql`
                    WITH content_text AS (
                        SELECT
                            m.id,
                            COALESCE(
                                m.content->>${opts.query_field_sub_name},
                                ''
                            ) as content_text
                        FROM memories m
                        WHERE m.type = ${opts.query_table_name}
                            AND m.content->>${opts.query_field_sub_name} IS NOT NULL
                    ),
                    embedded_text AS (
                        SELECT
                            ct.content_text,
                            COALESCE(
                                e.dim_384,
                                e.dim_512,
                                e.dim_768,
                                e.dim_1024,
                                e.dim_1536,
                                e.dim_3072
                            ) as embedding
                        FROM content_text ct
                        LEFT JOIN embeddings e ON e.memory_id = ct.id
                        WHERE e.memory_id IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(CAST(${opts.query_input} AS text), content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(CAST(${opts.query_input} AS text), content_text) <= ${opts.query_threshold}
                    ORDER BY levenshtein_score
                    LIMIT ${opts.query_match_count}
                `);

        return results.rows
          .map((row) => ({
            embedding: Array.isArray(row.embedding)
              ? row.embedding
              : typeof row.embedding === "string"
                ? JSON.parse(row.embedding)
                : [],
            levenshtein_score: Number(row.levenshtein_score),
          }))
          .filter((row) => Array.isArray(row.embedding));
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing — an over-long query
        // string exceeds levenshtein's 255-char ceiling, so no fuzzy cache
        // match can exist for it: an empty result is the correct typed answer,
        // not a masked failure. Every other error is a real fault → rethrow.
        if (
          error instanceof Error &&
          error.message === "levenshtein argument exceeds maximum length of 255 characters"
        ) {
          return [];
        }
        throw new ElizaError("getCachedEmbeddings failed", {
          code: "DB_QUERY_FAILED",
          cause: error,
          context: {
            table: opts.query_table_name,
            field: opts.query_field_name,
          },
        });
      }
    });
  }

  /**
   * Asynchronously logs an event in the database.
   * @param {Object} params - The parameters for logging an event.
   * @param {Object} params.body - The body of the event to log.
   * @param {UUID} params.entityId - The ID of the entity associated with the event.
   * @param {UUID} params.roomId - The ID of the room associated with the event.
   * @param {string} params.type - The type of the event to log.
   * @returns {Promise<void>} A Promise that resolves when the event is logged.
   */
  async log(params: { body: LogBody; entityId: UUID; roomId: UUID; type: string }): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Sanitize JSON body to prevent Unicode escape sequence errors
        const sanitizedBody = sanitizeJsonObject(params.body);

        // Serialize to JSON string first for an additional layer of protection
        // This ensures any problematic characters are properly escaped during JSON serialization
        const jsonString = JSON.stringify(sanitizedBody);

        // Use withEntityContext to set Entity RLS context before inserting
        // This ensures the log entry passes STRICT Entity RLS policy
        await this.withEntityContext(params.entityId, async (tx) => {
          await tx.insert(logTable).values({
            body: sql`${jsonString}::jsonb`,
            entityId: params.entityId,
            roomId: params.roomId,
            type: params.type,
          });
        });
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a swallowed insert dropped
        // the log entry silently; the caller decides whether a failed diagnostic
        // write should be tolerated (J7), not this deep adapter method.
        throw new ElizaError("log insert failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "logs",
            type: params.type,
            roomId: params.roomId,
            entityId: params.entityId,
          },
        });
      }
    });
  }

  /**
   * Asynchronously retrieves logs from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving logs.
   * @param {UUID} params.entityId - The ID of the entity associated with the logs.
   * @param {UUID} [params.roomId] - The ID of the room associated with the logs.
   * @param {string} [params.type] - The type of the logs to retrieve.
   * @param {number} [params.limit] - The maximum number of logs to retrieve (`count` is a legacy alias).
   * @param {number} [params.offset] - The offset to retrieve logs from.
   * @returns {Promise<Log[]>} A Promise that resolves to an array of logs.
   */
  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    limit?: number;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    const { entityId, roomId, type, offset } = params;
    // Honor `limit` (the IDatabaseAdapter contract param — see
    // types/database.ts getLogs) with `count` as a legacy alias, matching
    // getMemories. Reading only `count` meant every caller passing `limit`
    // (runtime.getLogs, agent-export's `getLogs({ limit: MAX_SAFE_INTEGER })`)
    // silently fell back to the default 10 rows.
    const effectiveLimit = params.limit ?? params.count ?? 10;

    // Use withEntityContext for RLS only when entityId is provided
    // Without entityId, bypass RLS to see all logs (for non-RLS mode)
    return this.withEntityContext(entityId ?? null, async (tx) => {
      const result = await tx
        .select()
        .from(logTable)
        .where(
          and(
            roomId ? eq(logTable.roomId, roomId) : undefined,
            type ? eq(logTable.type, type) : undefined
          )
        )
        .orderBy(desc(logTable.createdAt))
        .limit(effectiveLimit)
        .offset(offset ?? 0);

      const logs = result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        type: log.type as string,
        body: log.body as LogBody,
        createdAt: new Date(log.createdAt as string | number | Date),
      }));

      if (logs.length === 0) return [];

      return logs;
    });
  }

  async getAgentRunSummaries(
    params: {
      limit?: number;
      roomId?: UUID;
      status?: RunStatus | "all";
      from?: number;
      to?: number;
      entityId?: UUID;
    } = {}
  ): Promise<AgentRunSummaryResult> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const fromDate = typeof params.from === "number" ? new Date(params.from) : undefined;
    const toDate = typeof params.to === "number" ? new Date(params.to) : undefined;

    // Use withEntityContext for RLS when entityId is provided
    return this.withEntityContext(params.entityId ?? null, async (tx) => {
      const runMap = new Map<string, AgentRunSummary>();

      const conditions: SQL<unknown>[] = [
        eq(logTable.type, "run_event"),
        sql`${logTable.body} ? 'runId'`,
        eq(roomTable.agentId, this.agentId),
      ];

      if (params.roomId) {
        conditions.push(eq(logTable.roomId, params.roomId));
      }
      if (fromDate) {
        conditions.push(gte(logTable.createdAt, fromDate));
      }
      if (toDate) {
        conditions.push(lte(logTable.createdAt, toDate));
      }

      const whereClause = and(...conditions);

      const eventLimit = Math.max(limit * 20, 200);

      const runEventRows = await tx
        .select({
          runId: sql<string>`(${logTable.body} ->> 'runId')`,
          status: sql<string | null>`(${logTable.body} ->> 'status')`,
          messageId: sql<string | null>`(${logTable.body} ->> 'messageId')`,
          rawBody: logTable.body,
          createdAt: logTable.createdAt,
          roomId: logTable.roomId,
          entityId: logTable.entityId,
        })
        .from(logTable)
        .innerJoin(roomTable, eq(roomTable.id, logTable.roomId))
        .where(whereClause)
        .orderBy(desc(logTable.createdAt))
        .limit(eventLimit);

      for (const row of runEventRows) {
        const runId = row.runId;
        if (!runId) continue;

        const summary: AgentRunSummary = runMap.get(runId) ?? {
          runId,
          status: "started",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          messageId: undefined,
          roomId: undefined,
          entityId: undefined,
          metadata: {},
        };

        if (!summary.messageId && row.messageId) {
          summary.messageId = row.messageId as UUID;
        }
        if (!summary.roomId && row.roomId) {
          summary.roomId = row.roomId as UUID;
        }
        if (!summary.entityId && row.entityId) {
          summary.entityId = row.entityId as UUID;
        }

        const body = row.rawBody as Record<string, unknown> | undefined;
        if (body && typeof body === "object") {
          if (!summary.roomId && typeof body.roomId === "string") {
            summary.roomId = body.roomId as UUID;
          }
          if (!summary.entityId && typeof body.entityId === "string") {
            summary.entityId = body.entityId as UUID;
          }
          if (!summary.messageId && typeof body.messageId === "string") {
            summary.messageId = body.messageId as UUID;
          }
          if (!summary.metadata || Object.keys(summary.metadata).length === 0) {
            const metadata = (body.metadata as Record<string, unknown> | undefined) ?? undefined;
            summary.metadata = metadata ? ({ ...metadata } as Record<string, JsonValue>) : {};
          }
        }

        const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        const timestamp = createdAt.getTime();
        const bodyStatus = body?.status;
        const eventStatus =
          (row.status as RunStatus | undefined) ?? (bodyStatus as RunStatus | undefined);

        if (eventStatus === "started") {
          const currentStartedAt =
            summary.startedAt === null
              ? null
              : typeof summary.startedAt === "bigint"
                ? Number(summary.startedAt)
                : summary.startedAt;
          summary.startedAt =
            currentStartedAt === null ? timestamp : Math.min(currentStartedAt, timestamp);
        } else if (
          eventStatus === "completed" ||
          eventStatus === "timeout" ||
          eventStatus === "error"
        ) {
          summary.status = eventStatus;
          summary.endedAt = timestamp;
          if (summary.startedAt !== null) {
            const startedAtNum =
              typeof summary.startedAt === "bigint" ? Number(summary.startedAt) : summary.startedAt;
            summary.durationMs = Math.max(timestamp - startedAtNum, 0);
          }
        }

        runMap.set(runId, summary);
      }

      let runs = Array.from(runMap.values());
      if (params.status && params.status !== "all") {
        runs = runs.filter((run) => run.status === params.status);
      }

      runs.sort((a, b) => {
        const aStarted =
          a.startedAt === null
            ? 0
            : typeof a.startedAt === "bigint"
              ? Number(a.startedAt)
              : a.startedAt;
        const bStarted =
          b.startedAt === null
            ? 0
            : typeof b.startedAt === "bigint"
              ? Number(b.startedAt)
              : b.startedAt;
        return bStarted - aStarted;
      });

      const total = runs.length;
      const limitedRuns = runs.slice(0, limit);
      const hasMore = total > limit;

      const runCounts = new Map<string, AgentRunCounts>();
      for (const run of limitedRuns) {
        runCounts.set(run.runId, {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        });
      }

      const runIds = limitedRuns.map((run) => run.runId).filter(Boolean);

      if (runIds.length > 0) {
        const runIdArray = sql`array[${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `
        )}]::text[]`;

        const actionSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "actions",
            SUM(CASE WHEN COALESCE(body->'result'->>'success', 'true') = 'false' THEN 1 ELSE 0 END)::int as "errors",
            SUM(COALESCE((body->>'promptCount')::int, 0))::int as "modelCalls"
          FROM ${logTable}
          WHERE type = 'action'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const actionRows = actionSummary.rows as Array<{
          runId: string;
          actions: number | string;
          errors: number | string;
          modelCalls: number | string;
        }>;

        for (const row of actionRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.actions += Number(row.actions);
          counts.errors += Number(row.errors);
          counts.modelCalls += Number(row.modelCalls);
        }

        const evaluatorSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "evaluators"
          FROM ${logTable}
          WHERE type = 'evaluator'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const evaluatorRows = evaluatorSummary.rows as Array<{
          runId: string;
          evaluators: number | string;
        }>;

        for (const row of evaluatorRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.evaluators += Number(row.evaluators);
        }

        const genericSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*) FILTER (WHERE type LIKE 'useModel:%')::int as "modelLogs",
            COUNT(*) FILTER (WHERE type = 'embedding_event' AND body->>'status' = 'failed')::int as "embeddingErrors"
          FROM ${logTable}
          WHERE (type LIKE 'useModel:%' OR type = 'embedding_event')
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const genericRows = genericSummary.rows as Array<{
          runId: string;
          modelLogs: number | string;
          embeddingErrors: number | string;
        }>;

        for (const row of genericRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.modelCalls += Number(row.modelLogs);
          counts.errors += Number(row.embeddingErrors);
        }
      }

      for (const run of limitedRuns) {
        const counts = runCounts.get(run.runId) ?? {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        };
        run.counts = counts;
      }

      return {
        runs: limitedRuns,
        total,
        hasMore,
      } as AgentRunSummaryResult;
    });
  }

  /**
   * Asynchronously deletes a log from the database based on the provided parameters.
   * @param {UUID} logId - The ID of the log to delete.
   * @returns {Promise<void>} A Promise that resolves when the log is deleted.
   */
  async deleteLog(logId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(eq(logTable.id, logId));
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {Object} params - The parameters for searching for memories.
   * @param {string} params.tableName - The name of the table to search for memories in.
   * @param {number[]} params.embedding - The embedding to search for.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.query] - Optional query string for potential reranking.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemories(params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    count?: number;
    limit?: number;
    offset?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return await this.searchMemoriesByEmbedding(params.embedding, {
      match_threshold: params.match_threshold,
      // `limit` is the IDatabaseAdapter contract param; honour it (with `count`
      // as a legacy alias) instead of silently ignoring it and capping the
      // candidate pool at the default 10.
      count: params.count ?? params.limit,
      offset: params.offset,
      // Pass direct scope fields down
      roomId: params.roomId,
      worldId: params.worldId,
      entityId: params.entityId,
      unique: params.unique,
      tableName: params.tableName,
      accessContext: params.accessContext,
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {number[]} embedding - The embedding to search for.
   * @param {Object} params - The parameters for searching for memories.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to search for memories in.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      offset?: number;
      roomId?: UUID;
      worldId?: UUID;
      entityId?: UUID;
      unique?: boolean;
      tableName: string;
      accessContext?: AccessContext;
    }
  ): Promise<Memory[]> {
    return this.withDatabase(async () => {
      const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));
      const activeColumn = embeddingTable[this.embeddingDimension];
      // SCOPE eligibility lives INSIDE the ordered scan: every scope predicate
      // (type, agent, room, world, entity, uniqueness) is part of the WHERE of
      // the same query that orders by the raw distance operator. The contract
      // is "top K among eligible memories" — a two-stage form that takes a
      // global top-K first and filters afterwards silently drops eligible
      // matches whenever closer out-of-scope vectors outnumber the candidate
      // pool (multi-agent and room-scoped recall starve first). Ordering by
      // `asc(cosineDistance(...))` — not by the derived similarity — is the
      // shape the HNSW index (ensureEmbeddingVectorIndex) can serve;
      // `hnsw.iterative_scan = strict_order` keeps a scope-filtered index scan
      // refilling until the LIMIT is satisfied, and when the planner prefers a
      // non-index plan for a selective scope the result is identical, just
      // unaccelerated.
      //
      // The THRESHOLD is deliberately NOT in the WHERE. Unlike the scope
      // predicates it is monotone in the ORDER BY key (similarity >= T is
      // distance <= 1 - T), so every row passing it is a prefix of the
      // distance-ordered scope-eligible sequence and filtering the top K
      // after the LIMIT returns the identical result set. Inside the WHERE it
      // is a starvation predicate instead: on a no-close-match query (most
      // turns) nothing passes, and the strict_order iterative scan chews
      // through the index up to hnsw.max_scan_tuples computing distances for
      // rows it will discard — measured as the dominant composeState cost.
      const distance = cosineDistance(activeColumn, cleanVector);
      const similarity = sql<number>`1 - (${distance})`;
      const conditions = [
        isNotNull(activeColumn),
        eq(memoryTable.type, params.tableName),
        eq(memoryTable.agentId, this.agentId),
        ...memoryAccessContextConditions(params.accessContext, this.agentId, params.tableName),
      ];

      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }
      if (params.roomId) {
        conditions.push(eq(memoryTable.roomId, params.roomId));
      }
      if (params.worldId) {
        conditions.push(eq(memoryTable.worldId, params.worldId));
      }
      if (params.entityId) {
        conditions.push(eq(memoryTable.entityId, params.entityId));
      }

      const orderedQuery = this.db
        .select({
          memory: memoryTable,
          similarity,
          embedding: activeColumn,
        })
        .from(embeddingTable)
        .innerJoin(memoryTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(and(...conditions))
        .orderBy(asc(distance), desc(memoryTable.createdAt), desc(memoryTable.id));
      const candidates = await (params.count === undefined
        ? orderedQuery.offset(params.offset ?? 0)
        : orderedQuery.limit(params.count).offset(params.offset ?? 0));

      // Same truthiness contract as the removed WHERE predicate: an absent or
      // zero threshold applies no similarity floor.
      const matchThreshold = params.match_threshold;
      const results = matchThreshold
        ? candidates.filter((row) => row.similarity >= matchThreshold)
        : candidates;

      return results.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: row.memory.worldId as UUID | undefined, // Include worldId
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
        similarity: row.similarity,
      }));
    });
  }

  /**
   * Asynchronously creates a new memory in the database.
   * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
   * @param {string} tableName - The name of the table to create the memory in.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
   */
  async createMemory(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<UUID> {
    const memoryId = memory.id ?? (v4() as UUID);

    await this.resolveMemoryUniqueness(memory, tableName);

    // Use withEntityContext to set Entity RLS context if needed. The helper
    // also supplies the real Drizzle transaction used for both the memory row
    // and its optional embedding.
    await this.withEntityContext(memory.entityId, async (tx) => {
      await this.insertMemoryInTransaction(tx, memory, tableName, memoryId);
    });

    return memoryId;
  }

  private async resolveMemoryUniqueness(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<void> {
    // only do costly check if we need to
    if (memory.unique === undefined) {
      memory.unique = true; // set default
      if (memory.embedding && Array.isArray(memory.embedding)) {
        const similarMemories = await this.searchMemoriesByEmbedding(memory.embedding, {
          tableName,
          // Use the scope fields from the memory object for similarity check
          roomId: memory.roomId,
          worldId: memory.worldId,
          entityId: memory.entityId,
          match_threshold: 0.95,
          count: 1,
        });
        memory.unique = similarMemories.length === 0;
      }
    }
  }

  private validateMemoryBatchEmbeddings(
    memories: Array<{ memory: Memory; tableName: string }>
  ): void {
    const expectedDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
    for (let index = 0; index < memories.length; index++) {
      const { memory, tableName } = memories[index];
      if (!memory.embedding) continue;
      if (
        !Array.isArray(memory.embedding) ||
        memory.embedding.length !== expectedDimension ||
        memory.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Invalid embedding in atomic memory batch at index ${index} (${tableName}); expected ${expectedDimension} finite values`
        );
      }
    }
  }

  private async insertMemoryInTransaction(
    tx: DrizzleDatabase,
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string,
    memoryId: UUID,
    requireInserted = false
  ): Promise<void> {
    // Ensure we always pass a JSON string to the SQL bind parameter; if we pass an
    // object directly PG sees `[object Object]` and fails the `::jsonb` cast.
    const contentToInsert =
      tableName === "documents"
        ? serializeJsonb(memory.content, { documentText: true })
        : tableName === "document_fragments"
          ? serializeDocumentJsonb(memory.content)
          : serializeJsonb(memory.content);

    const metadataToInsert = serializeJsonb(memory.metadata ?? {});

    const inserted = await tx
      .insert(memoryTable)
      .values([
        {
          id: memoryId,
          type: tableName,
          content: sql`${contentToInsert}::jsonb`,
          metadata: sql`${metadataToInsert}::jsonb`,
          entityId: memory.entityId,
          roomId: memory.roomId,
          worldId: memory.worldId,
          agentId: memory.agentId || this.agentId,
          unique: memory.unique,
          createdAt: memory.createdAt !== undefined ? new Date(memory.createdAt) : new Date(),
        },
      ])
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      if (requireInserted) {
        throw new ElizaError("Atomic memory insert collided with an existing id", {
          code: "DOCUMENT_REVISION_FRAGMENT_ID_CONFLICT",
          context: { memoryId },
        });
      }
      return;
    }

    if (memory.embedding && Array.isArray(memory.embedding)) {
      const expectedDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
      if (memory.embedding.length !== expectedDimension) {
        // The runtime's TEXT_EMBEDDING provider returned a vector whose width
        // does not match the column this agent is configured to write to —
        // typically because a fallback provider (e.g. cloud at 1536 dims) ran
        // before the configured local model finished warmup. Persist the
        // memory itself; skip the embedding so a later write with the right
        // model can supply one.
        logger.warn(
          {
            src: "plugin:sql",
            agentId: this.agentId,
            expectedDimension,
            receivedDimension: memory.embedding.length,
            column: this.embeddingDimension,
          },
          "Skipping embedding insert: dimension mismatch with configured column"
        );
      } else {
        const embeddingValues: Record<string, unknown> = {
          id: v4(),
          memoryId: memoryId,
          createdAt: memory.createdAt !== undefined ? new Date(memory.createdAt) : new Date(),
        };

        const cleanVector = memory.embedding.map((n) =>
          Number.isFinite(n) ? Number(n.toFixed(6)) : 0
        );

        embeddingValues[this.embeddingDimension] = cleanVector;

        await tx.insert(embeddingTable).values([embeddingValues]);
      }
    }
  }

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          // Update memory content if provided
          if (memory.content) {
            const [stored] = await tx
              .select({ type: memoryTable.type })
              .from(memoryTable)
              .where(eq(memoryTable.id, memory.id))
              .for("update");
            const contentToUpdate =
              stored?.type === "documents"
                ? serializeJsonb(memory.content, { documentText: true })
                : stored?.type === "document_fragments"
                  ? serializeDocumentJsonb(memory.content)
                  : serializeJsonb(memory.content);

            const metadataToUpdate = serializeJsonb(memory.metadata ?? {});

            await tx
              .update(memoryTable)
              .set({
                content: sql`${contentToUpdate}::jsonb`,
                ...(memory.metadata && {
                  metadata: sql`${metadataToUpdate}::jsonb`,
                }),
              })
              .where(eq(memoryTable.id, memory.id));
          } else if (memory.metadata) {
            // Update only metadata if content is not provided
            const metadataToUpdate = serializeJsonb(memory.metadata);

            await tx
              .update(memoryTable)
              .set({
                metadata: sql`${metadataToUpdate}::jsonb`,
              })
              .where(eq(memoryTable.id, memory.id));
          }

          // Update embedding if provided
          if (memory.embedding && Array.isArray(memory.embedding)) {
            const expectedDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
            if (memory.embedding.length !== expectedDimension) {
              logger.warn(
                {
                  src: "plugin:sql",
                  agentId: this.agentId,
                  memoryId: memory.id,
                  expectedDimension,
                  receivedDimension: memory.embedding.length,
                  column: this.embeddingDimension,
                },
                "Skipping embedding update: dimension mismatch with configured column"
              );
            } else {
              const cleanVector = memory.embedding.map((n) =>
                Number.isFinite(n) ? Number(n.toFixed(6)) : 0
              );

              // Check if embedding exists
              const existingEmbedding = await tx
                .select({ id: embeddingTable.id })
                .from(embeddingTable)
                .where(eq(embeddingTable.memoryId, memory.id))
                .limit(1);

              if (existingEmbedding.length > 0) {
                // Update existing embedding
                const updateValues: Record<string, unknown> = {};
                updateValues[this.embeddingDimension] = cleanVector;

                await tx
                  .update(embeddingTable)
                  .set(updateValues)
                  .where(eq(embeddingTable.memoryId, memory.id));
              } else {
                // Create new embedding
                const embeddingValues: Record<string, unknown> = {
                  id: v4(),
                  memoryId: memory.id,
                };
                embeddingValues[this.embeddingDimension] = cleanVector;

                await tx.insert(embeddingTable).values([embeddingValues]);
              }
            }
          }
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed memory update must
        // not read as a benign false; surface the write failure.
        throw new ElizaError("updateMemory failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "memories", memoryId: memory.id },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // See if there are any fragments that we need to delete
        await this.deleteMemoryFragments(tx, memoryId);

        // Then delete the embedding for the main memory
        await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));

        // Finally delete the memory itself
        await tx.delete(memoryTable).where(eq(memoryTable.id, memoryId));
      });
    });
  }

  /**
   * Asynchronously deletes multiple memories from the database in a single batch operation.
   * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
   * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
   */
  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Process in smaller batches to avoid query size limits
        const BATCH_SIZE = 100;
        for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
          const batch = memoryIds.slice(i, i + BATCH_SIZE);

          // Delete any fragments for document memories in this batch
          await Promise.all(
            batch.map(async (memoryId) => {
              await this.deleteMemoryFragments(tx, memoryId);
            })
          );

          // Delete embeddings for the batch
          await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));

          // Delete the memories themselves
          await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
        }
      });
    });
  }

  /**
   * Deletes all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be deleted
   * @private
   */
  private async deleteMemoryFragments(tx: DrizzleDatabase, documentId: UUID): Promise<void> {
    const fragmentsToDelete = await this.getMemoryFragments(tx, documentId);

    if (fragmentsToDelete.length > 0) {
      const fragmentIds = fragmentsToDelete.map((f) => f.id) as UUID[];

      // Delete embeddings for fragments
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));

      // Delete the fragments
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
    }
  }

  /**
   * Retrieves all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be retrieved
   * @returns An array of memory fragments
   * @private
   */
  private async getMemoryFragments(tx: DrizzleDatabase, documentId: UUID): Promise<{ id: UUID }[]> {
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, this.agentId),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
        )
      );

    return fragments.map((f) => ({ id: f.id as UUID }));
  }

  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void>;
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;
  async deleteAllMemories(roomIdsOrRoomId: UUID[] | UUID, tableName: string): Promise<void> {
    return this.withDatabase(async () => {
      const roomIds = Array.isArray(roomIdsOrRoomId) ? roomIdsOrRoomId : [roomIdsOrRoomId];

      if (roomIds.length === 0) {
        return;
      }

      await this.db.transaction(async (tx) => {
        // 1) fetch all memory IDs for the requested rooms + table
        const rows = await tx
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(
            and(
              inArray(memoryTable.roomId, roomIds),
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId)
            )
          );

        const ids = rows.map((r) => r.id);
        logger.debug(
          { src: "plugin:sql", roomIds, tableName, memoryCount: ids.length },
          "Deleting all memories"
        );

        if (ids.length === 0) {
          return;
        }

        // 2) delete any fragments for "document" memories & their embeddings
        await Promise.all(
          ids.map(async (memoryId) => {
            await this.deleteMemoryFragments(tx, memoryId);
            await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));
          })
        );

        // 3) delete the memories themselves
        await tx
          .delete(memoryTable)
          .where(
            and(
              inArray(memoryTable.roomId, roomIds),
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId)
            )
          );
      });
    });
  }

  /**
   * Count memories using the current object-based adapter contract while preserving
   * the legacy positional signature used by older tests and callers.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  async countMemories(params: CountMemoriesParams): Promise<number>;
  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;
  async countMemories(
    paramsOrRoomId: CountMemoriesParams | UUID,
    unique = true,
    tableName?: string
  ): Promise<number> {
    const params: CountMemoriesParams =
      typeof paramsOrRoomId === "string"
        ? {
            roomIds: [paramsOrRoomId],
            unique,
            tableName: tableName ?? "messages",
          }
        : {
            ...paramsOrRoomId,
            tableName: paramsOrRoomId.tableName ?? "messages",
            unique: paramsOrRoomId.unique ?? false,
          };

    return this.withDatabase(async () => {
      const tableName = params.tableName ?? "messages";
      const conditions = [eq(memoryTable.type, tableName)];

      if (params.roomIds && params.roomIds.length > 0) {
        conditions.push(inArray(memoryTable.roomId, params.roomIds));
      }
      if (params.entityId) {
        conditions.push(eq(memoryTable.entityId, params.entityId));
      }
      conditions.push(eq(memoryTable.agentId, params.agentId ?? this.agentId));
      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }
      if (params.metadata && Object.keys(params.metadata).length > 0) {
        conditions.push(sql`${memoryTable.metadata} @> ${JSON.stringify(params.metadata)}::jsonb`);
      }

      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(memoryTable)
        .where(and(...conditions));

      const result0 = result[0];
      return Number(result0?.count);
    });
  }

  /**
   * Asynchronously retrieves rooms from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
   * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
   */
  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: roomTable.id,
          name: roomTable.name, // Added name
          channelId: roomTable.channelId,
          agentId: roomTable.agentId,
          messageServerId: roomTable.messageServerId,
          worldId: roomTable.worldId,
          type: roomTable.type,
          source: roomTable.source,
          metadata: roomTable.metadata, // Added metadata
        })
        .from(roomTable)
        .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, this.agentId)));

      // Map the result to properly typed Room objects
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID, // Backward compatibility alias
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));

      return rooms;
    });
  }

  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(roomTable).where(eq(roomTable.worldId, worldId));
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID, // Backward compatibility alias
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));
      return rooms;
    });
  }

  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  async updateRoom(room: Room): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(roomTable)
        .set({ ...room, agentId: this.agentId })
        .where(eq(roomTable.id, room.id));
    });
  }

  /**
   * Asynchronously creates a new room in the database based on the provided parameters.
   * @param {Room} room - The room object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created room.
   */
  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const roomsWithIds = rooms.map((room) => ({
        ...room,
        agentId: this.agentId,
        id: room.id || v4(), // ensure each room has a unique ID
      }));

      const insertedRooms = await this.db
        .insert(roomTable)
        .values(roomsWithIds)
        .onConflictDoNothing()
        .returning();
      const insertedIds = insertedRooms.map((r) => r.id as UUID);
      return insertedIds;
    });
  }

  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  async deleteRoom(roomId: UUID): Promise<void> {
    if (!roomId) throw new Error("Room ID is required");
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.id, roomId));
      });
    });
  }

  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.agentId)));

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    const roomIds = new Set<UUID>();
    for (const entityId of entityIds) {
      const result = await this.withEntityContext(entityId, async (tx) =>
        tx
          .selectDistinct({ roomId: participantTable.roomId })
          .from(participantTable)
          .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
          .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.agentId)))
      );
      for (const row of result) roomIds.add(row.roomId as UUID);
    }
    return [...roomIds];
  }

  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const existing = await this.db
          .select({ id: participantTable.id })
          .from(participantTable)
          .where(
            and(
              eq(participantTable.entityId, entityId),
              eq(participantTable.roomId, roomId),
              eq(participantTable.agentId, this.agentId)
            )
          )
          .limit(1);
        if (existing.length === 0) {
          await this.db.insert(participantTable).values({
            entityId,
            roomId,
            agentId: this.agentId,
          });
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only ever
        // returns true on success, so false here masked a real write failure.
        throw new ElizaError("addParticipant failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId, agentId: this.agentId },
        });
      }
    });
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        for (const id of entityIds) {
          const existing = await this.db
            .select({ id: participantTable.id })
            .from(participantTable)
            .where(
              and(
                eq(participantTable.entityId, id),
                eq(participantTable.roomId, roomId),
                eq(participantTable.agentId, this.agentId)
              )
            )
            .limit(1);
          if (existing.length === 0) {
            await this.db.insert(participantTable).values({
              entityId: id,
              roomId,
              agentId: this.agentId,
            });
          }
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only ever
        // returns true on success, so false here masked a real write failure.
        throw new ElizaError("addParticipantsRoom failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "participants",
            roomId,
            agentId: this.agentId,
            count: entityIds.length,
          },
        });
      }
    });
  }

  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.transaction(async (tx) => {
          return await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, entityId), eq(participantTable.roomId, roomId))
            )
            .returning();
        });

        const removed = result.length > 0;
        return removed;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — false is the typed "no row
        // matched" signal; a delete failure must not collapse into it.
        throw new ElizaError("removeParticipant failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId },
        });
      }
    });
  }

  /**
   * Asynchronously retrieves all participants for an entity from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve participants for.
   * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
   */
  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: participantTable.id,
          entityId: participantTable.entityId,
          roomId: participantTable.roomId,
        })
        .from(participantTable)
        .where(eq(participantTable.entityId, entityId));

      const entities = await this.getEntitiesByIds([entityId]);

      if (!entities.length) {
        return [];
      }

      return result.map((row) => ({
        id: row.id as UUID,
        entity: entities[0],
      }));
    });
  }

  /**
   * Asynchronously retrieves all participants for a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve participants for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
   */
  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    });
  }

  /**
   * Check if an entity is a participant in a specific room/channel.
   * More efficient than getParticipantsForRoom when only checking membership.
   * @param {UUID} roomId - The ID of the room to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(participantTable)
        .where(and(eq(participantTable.roomId, roomId), eq(participantTable.entityId, entityId)))
        .limit(1);

      return result.length > 0;
    });
  }

  /**
   * Asynchronously retrieves the user state for a participant in a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
   * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
   */
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomState: participantTable.roomState })
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, roomId),
            eq(participantTable.entityId, entityId),
            eq(participantTable.agentId, this.agentId)
          )
        )
        .limit(1);

      const result0 = result[0];
      return (result0?.roomState as "FOLLOWED" | "MUTED" | null) ?? null;
    });
  }

  /**
   * Asynchronously sets the user state for a participant in a room in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to set the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to set the user state for.
   * @param {string} state - The state to set the participant's user state to.
   * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
   */
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null
  ): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(participantTable)
            .set({ roomState: state })
            .where(
              and(
                eq(participantTable.roomId, roomId),
                eq(participantTable.entityId, entityId),
                eq(participantTable.agentId, this.agentId)
              )
            );
        });
      } catch (error) {
        // error-policy:J2 context-adding rethrow — attach the participant/state
        // context to the surfaced failure.
        throw new ElizaError("setParticipantUserState failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "participants", roomId, entityId, state },
        });
      }
    });
  }

  /**
   * Asynchronously creates a new relationship in the database based on the provided parameters.
   * @param {Object} params - The parameters for creating a new relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @param {string[]} [params.tags] - The tags for the relationship.
   * @param {Object} [params.metadata] - The metadata for the relationship.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the relationship was created successfully.
   */
  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    return this.withDatabase(async () => {
      const id = v4();
      const saveParams = {
        id,
        sourceEntityId: params.sourceEntityId,
        targetEntityId: params.targetEntityId,
        agentId: this.agentId,
        tags: params.tags || [],
        metadata: params.metadata || {},
      };
      try {
        const inserted = await this.db
          .insert(relationshipTable)
          .values(saveParams)
          .onConflictDoNothing()
          .returning();
        return inserted.length > 0;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — false is the typed "already
        // existed (onConflictDoNothing)" signal; an insert failure must not
        // collapse into it.
        throw new ElizaError("createRelationship failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "relationships",
            agentId: this.agentId,
            sourceEntityId: params.sourceEntityId,
            targetEntityId: params.targetEntityId,
          },
        });
      }
    });
  }

  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .update(relationshipTable)
          .set({
            tags: relationship.tags || [],
            metadata: relationship.metadata || {},
          })
          .where(eq(relationshipTable.id, relationship.id));
      } catch (error) {
        // error-policy:J2 context-adding rethrow — attach relationship context.
        throw new ElizaError("updateRelationship failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: {
            table: "relationships",
            agentId: this.agentId,
            relationshipId: relationship.id,
          },
        });
      }
    });
  }

  /**
   * Asynchronously retrieves a relationship from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving a relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
   */
  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return this.withDatabase(async () => {
      const { sourceEntityId, targetEntityId } = params;
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(
          and(
            eq(relationshipTable.sourceEntityId, sourceEntityId),
            eq(relationshipTable.targetEntityId, targetEntityId),
            eq(relationshipTable.agentId, this.agentId)
          )
        );
      if (result.length === 0) return null;
      const relationship = result[0];
      return {
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt: relationship.createdAt.toISOString(),
      };
    });
  }

  /**
   * Asynchronously retrieves relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID[]} [params.entityIds] - Entity IDs to retrieve relationships for.
   * @param {UUID} [params.entityId] - Legacy single-entity alias.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  async getRelationships(params: {
    entityIds?: UUID[];
    entityId?: UUID;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Relationship[]> {
    return this.withDatabase(async () => {
      const { entityIds: rawEntityIds, entityId, tags, limit, offset } = params;
      const entityIds = (
        rawEntityIds && rawEntityIds.length > 0 ? rawEntityIds : entityId ? [entityId] : []
      ).filter((id): id is UUID => typeof id === "string" && id.trim().length > 0);

      if (entityIds.length === 0) {
        return [];
      }

      const entityFilter = sql.join(
        entityIds.map(
          (id) =>
            sql`(${relationshipTable.sourceEntityId} = ${id} OR ${relationshipTable.targetEntityId} = ${id})`
        ),
        sql` OR `
      );
      let query = sql`
        SELECT * FROM ${relationshipTable}
        WHERE (${entityFilter})
      `;

      if (tags && tags.length > 0) {
        query = sql`
          ${query}
          AND ${relationshipTable.tags} && CAST(ARRAY[${sql.join(tags, sql`, `)}] AS text[])
        `;
      }

      if (typeof limit === "number") {
        query = sql`${query} LIMIT ${limit}`;
      }

      if (typeof offset === "number" && offset > 0) {
        query = sql`${query} OFFSET ${offset}`;
      }

      const result = await this.db.execute(query);

      return result.rows.map((relationship: Record<string, unknown>) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: (relationship.source_entity_id || relationship.sourceEntityId) as UUID,
        targetEntityId: (relationship.target_entity_id || relationship.targetEntityId) as UUID,
        agentId: (relationship.agent_id || relationship.agentId) as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt:
          relationship.created_at || relationship.createdAt
            ? (relationship.created_at || relationship.createdAt) instanceof Date
              ? ((relationship.created_at || relationship.createdAt) as Date).toISOString()
              : new Date(
                  (relationship.created_at as string) || (relationship.createdAt as string)
                ).toISOString()
            : new Date().toISOString(),
      }));
    });
  }

  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  async getCache<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db
          .select({ value: cacheTable.value })
          .from(cacheTable)
          .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)))
          .limit(1);

        if (result && result.length > 0 && result[0]) {
          return result[0].value as T | undefined;
        }

        return undefined;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — undefined is the typed cache
        // miss; a query failure must not read as "not cached".
        throw new ElizaError("getCache failed", {
          code: "DB_QUERY_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .insert(cacheTable)
          .values({
            key: key,
            agentId: this.agentId,
            value: value,
          })
          .onConflictDoUpdate({
            target: [cacheTable.key, cacheTable.agentId],
            set: {
              value: value,
            },
          });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — setCache only returns true on
        // success, so false here masked a real write failure.
        throw new ElizaError("setCache failed", {
          code: "DB_UPSERT_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  async deleteCache(key: string): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .delete(cacheTable)
            .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)));
        });
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — deleteCache only returns true
        // on success, so false here masked a real delete failure.
        throw new ElizaError("deleteCache failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  async createWorld(world: World): Promise<UUID> {
    return this.withDatabase(async () => {
      const normalizedWorld = this.normalizeWorldData(world);
      normalizedWorld.metadata = initializeWorldMetadataRevision(
        normalizedWorld.metadata as Metadata | undefined
      );
      const newWorldId = normalizedWorld.id as UUID;

      try {
        await this.db.insert(worldTable).values(normalizedWorld);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ElizaError("World already exists", {
            code: "WORLD_ALREADY_EXISTS",
            cause: error,
            context: { worldId: newWorldId, agentId: this.agentId },
          });
        }
        throw error;
      }
      return newWorldId;
    });
  }

  /**
   * Asynchronously retrieves a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to retrieve.
   * @returns {Promise<World | null>} A Promise that resolves to the world if found, null otherwise.
   */
  async getWorld(id: UUID): Promise<World | null> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
      return result.length > 0 ? this.mapWorldResult(result[0]) : null;
    });
  }

  /**
   * Asynchronously retrieves all worlds from the database based on the provided parameters.
   * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
   */
  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(eq(worldTable.agentId, this.agentId));
      return result.map((world) => this.mapWorldResult(world));
    });
  }

  /**
   * Asynchronously updates an existing world in the database based on the provided parameters.
   * @param {World} world - The world object to update.
   * @returns {Promise<void>} A Promise that resolves when the world is updated.
   */
  async updateWorld(world: World): Promise<void> {
    return this.withDatabase(async () => {
      const normalizedWorld = this.normalizeWorldData(world);
      delete normalizedWorld.id;
      const committedMetadata = await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(worldTable)
          .where(and(eq(worldTable.id, world.id), eq(worldTable.agentId, this.agentId)))
          .for("update")
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const storedRevision = requireFreshWorldMetadataRevision(
          row.metadata as Metadata | undefined,
          world.metadata as Metadata | undefined,
          String(world.id)
        );
        const nextMetadata = advanceWorldMetadataRevision(
          normalizedWorld.metadata as Metadata | undefined,
          storedRevision
        );
        normalizedWorld.metadata = nextMetadata;
        await tx
          .update(worldTable)
          .set(normalizedWorld)
          .where(and(eq(worldTable.id, world.id), eq(worldTable.agentId, this.agentId)));
        return nextMetadata;
      });
      if (committedMetadata) {
        world.metadata = structuredClone(committedMetadata) as World["metadata"];
      }
    });
  }

  /**
   * Compare-and-swap replacement of a world's whole metadata under the exact
   * prior snapshot (#23100 role-write atomicity). SELECT ... FOR UPDATE pins
   * the row, the stored metadata is compared against `expectedMetadata` by
   * canonical JSON value, the durable `role_audit` log row is inserted in the
   * SAME transaction, and only then does the metadata column advance — so a
   * concurrent metadata writer surfaces as a typed conflict instead of being
   * silently overwritten, and a committed authority change is never
   * separable from its audit record.
   */
  async compareAndSwapWorldMetadata(
    params: WorldMetadataCompareAndSwapParams
  ): Promise<WorldMetadataMutationResult> {
    return this.withEntityContext(params.audit?.actorEntityId ?? null, async (tx) => {
      const rows = await tx
        .select()
        .from(worldTable)
        .where(and(eq(worldTable.id, params.worldId), eq(worldTable.agentId, this.agentId)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { status: "not_found" as const };

      const storedMetadata = (row.metadata ?? {}) as Record<string, unknown>;
      if (
        !worldMetadataValueEquals(
          storedMetadata,
          params.expectedMetadata as Record<string, unknown>
        )
      ) {
        return { status: "conflict" as const };
      }
      const storedRevision = getWorldMetadataRevision(row.metadata as Metadata | undefined);
      if (storedRevision === null) return { status: "conflict" as const };

      if (params.audit) {
        const audit = params.audit;
        await tx.insert(worldRoleAuditTable).values({
          agentId: this.agentId,
          worldId: params.worldId,
          actorEntityId: audit.actorEntityId,
          targetEntityId: audit.targetEntityId,
          roomId: audit.roomId,
          previousRole: audit.previousRole,
          newRole: audit.newRole,
          grantSource: audit.source,
        });
        const sanitizedBody = sanitizeJsonObject({
          source: "role-write-cas",
          metadata: {
            worldId: params.worldId,
            actorEntityId: audit.actorEntityId,
            targetEntityId: audit.targetEntityId,
            previousRole: audit.previousRole,
            newRole: audit.newRole,
            grantSource: audit.source,
            outcome: "committed",
          },
        });
        await tx.insert(logTable).values({
          entityId: audit.actorEntityId,
          roomId: audit.roomId,
          type: ROLE_WRITE_AUDIT_LOG_TYPE,
          body: sql`${JSON.stringify(sanitizedBody)}::jsonb`,
        });
      }

      const replacementMetadata = params.audit
        ? appendWorldMetadataRoleAudit(params.replacementMetadata, {
            actorEntityId: params.audit.actorEntityId,
            targetEntityId: params.audit.targetEntityId,
            previousRole: params.audit.previousRole,
            newRole: params.audit.newRole,
            source: params.audit.source,
            roomId: params.audit.roomId,
          })
        : params.replacementMetadata;
      await tx
        .update(worldTable)
        .set({
          metadata: advanceWorldMetadataRevision(replacementMetadata, storedRevision),
        })
        .where(eq(worldTable.id, params.worldId));
      return { status: "updated" as const };
    });
  }

  /**
   * Asynchronously removes a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to remove.
   * @returns {Promise<void>} A Promise that resolves when the world is removed.
   */
  async removeWorld(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(worldTable).where(eq(worldTable.id, id));
    });
  }

  /**
   * Asynchronously creates a new task in the database based on the provided parameters.
   * @param {Task} task - The task object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created task.
   */
  async createTask(task: Task): Promise<UUID> {
    // Default worldId to agentId for agent-internal tasks
    if (!task.worldId) {
      task = { ...task, worldId: this.agentId as UUID };
    }
    const metadata = taskMetadataForWrite(task.metadata, task.dueAt);
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const now = new Date();
        const values = {
          // Only include id when provided; otherwise let the DB use its
          // gen_random_uuid() DEFAULT — passing undefined explicitly causes
          // Drizzle to insert NULL which violates the NOT NULL constraint.
          ...(task.id ? { id: task.id as UUID } : {}),
          name: task.name,
          description: task.description,
          roomId: task.roomId as UUID,
          worldId: task.worldId as UUID,
          entityId: task.entityId as UUID,
          tags: task.tags,
          metadata: metadata,
          createdAt: now,
          updatedAt: now,
          agentId: this.agentId as UUID,
        };

        const result = await this.db.insert(taskTable).values(values).returning();

        return result[0].id as UUID;
      });
    });
  }

  /**
   * Asynchronously retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId, tags, and entityId to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  async getTasks(params: {
    roomId?: UUID;
    worldId?: UUID;
    tags?: string[];
    entityId?: UUID;
    agentIds: UUID[];
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    validateTaskQueryPagination(params);
    if (params.agentIds.length === 0) return [];
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const query = this.db
          .select()
          .from(taskTable)
          .where(
            and(
              inArray(taskTable.agentId, params.agentIds),
              ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
              ...(params.worldId ? [eq(taskTable.worldId, params.worldId)] : []),
              ...(params.entityId ? [eq(taskTable.entityId, params.entityId)] : []),
              ...(params.tags && params.tags.length > 0
                ? [
                    sql`${taskTable.tags} @> ARRAY[${sql.join(
                      params.tags.map((t) => sql`${t}`),
                      sql`, `
                    )}]::text[]`,
                  ]
                : [])
            )
          )
          .orderBy(asc(taskTable.createdAt), asc(taskTable.id))
          .offset(params.offset ?? 0);
        const result = params.limit === undefined ? await query : await query.limit(params.limit);

        return result.map((row) => {
          const metadata = (row.metadata || {}) as TaskMetadata;
          return {
            id: row.id as UUID,
            agentId: row.agentId as UUID,
            name: row.name,
            description: row.description ?? "",
            roomId: row.roomId as UUID,
            worldId: row.worldId as UUID,
            entityId: row.entityId as UUID,
            tags: row.tags || [],
            dueAt: readTaskDueAt(metadata),
            metadata,
          };
        });
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTasksByName(name: string): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.name, name), eq(taskTable.agentId, this.agentId)));

        return result.map((row) => {
          const metadata = (row.metadata || {}) as TaskMetadata;
          return {
            id: row.id as UUID,
            agentId: row.agentId as UUID,
            name: row.name,
            description: row.description ?? "",
            roomId: row.roomId as UUID,
            worldId: row.worldId as UUID,
            entityId: row.entityId as UUID,
            tags: row.tags || [],
            dueAt: readTaskDueAt(metadata),
            metadata,
          };
        });
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTask(id: UUID): Promise<Task | null> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)))
          .limit(1);

        if (result.length === 0) {
          return null;
        }

        const row = result[0];
        const metadata = (row.metadata || {}) as TaskMetadata;
        return {
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          name: row.name,
          description: row.description ?? "",
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          entityId: row.entityId as UUID,
          tags: row.tags || [],
          dueAt: readTaskDueAt(metadata),
          metadata,
        };
      });
    });
  }

  /**
   * Asynchronously updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    const scheduledAt = task.dueAt == null ? undefined : serializeTaskDueAt(task.dueAt);
    const replacementMetadata =
      task.metadata === undefined ? undefined : taskMetadataForWrite(task.metadata, task.dueAt);
    await this.withRetry(async () => {
      await this.withDatabase(async () => {
        const updateValues: Partial<typeof taskTable.$inferInsert> = {};

        // Add fields to update if they exist in the partial task object
        if (task.name !== undefined) updateValues.name = task.name;
        if (task.description !== undefined) updateValues.description = task.description;
        if (task.roomId !== undefined) updateValues.roomId = task.roomId;
        if (task.worldId !== undefined) updateValues.worldId = task.worldId;
        if (task.entityId !== undefined) updateValues.entityId = task.entityId;
        if (task.tags !== undefined) updateValues.tags = task.tags;
        if (task.metadata !== undefined) {
          updateValues.metadata = replacementMetadata;
        } else if (scheduledAt !== undefined) {
          const dueAtPatch = JSON.stringify({ scheduledAt });
          updateValues.metadata = sql`COALESCE(${taskTable.metadata}, '{}'::jsonb) || ${dueAtPatch}::jsonb`;
        } else if (task.dueAt === null) {
          updateValues.metadata = sql`COALESCE(${taskTable.metadata}, '{}'::jsonb) - 'scheduledAt'`;
        }
        // Handle createdAt if present in the task object (using type assertion for compatibility)
        const taskWithCreatedAt = task as {
          createdAt?: number | bigint | null;
        };
        if (taskWithCreatedAt.createdAt !== undefined && taskWithCreatedAt.createdAt !== null) {
          const createdAtValue = taskWithCreatedAt.createdAt;
          updateValues.createdAt = new Date(
            typeof createdAtValue === "bigint" ? Number(createdAtValue) : createdAtValue
          );
        }

        // Always update the updatedAt timestamp as a Date (schema uses Date, not number)
        const dbUpdateValues: Partial<typeof taskTable.$inferInsert> = {
          ...updateValues,
          updatedAt: new Date(),
        };

        // Handle metadata updates - just set it directly without merging
        await this.db
          .update(taskTable)
          // createdAt is hella borked, number / Date
          .set(dbUpdateValues)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
      });
    });
  }

  /**
   * Asynchronously deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  async deleteTask(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .delete(taskTable)
        .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
    });
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      // First, get all rooms for the given worldId
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, params.worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        return [];
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      const memories = await this.getMemoriesByRoomIds({
        roomIds,
        tableName: params.tableName || "messages",
        limit: params.count,
      });

      return memories;
    });
  }

  async getMemoriesByServerId(params: {
    serverId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(
          and(eq(roomTable.messageServerId, params.serverId), eq(roomTable.agentId, this.agentId))
        );

      if (rooms.length === 0) {
        return [];
      }

      return this.getMemoriesByRoomIds({
        roomIds: rooms.map((room) => room.id as UUID),
        tableName: params.tableName || "messages",
        limit: params.count,
      });
    });
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        return;
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      if (roomIds.length > 0) {
        await this.db.delete(logTable).where(inArray(logTable.roomId, roomIds));
        await this.db.delete(participantTable).where(inArray(participantTable.roomId, roomIds));

        const memoriesInRooms = await this.db
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(inArray(memoryTable.roomId, roomIds));
        const memoryIdsInRooms = memoriesInRooms.map((m) => m.id as UUID);

        if (memoryIdsInRooms.length > 0) {
          await this.db
            .delete(embeddingTable)
            .where(inArray(embeddingTable.memoryId, memoryIdsInRooms));
          await this.db.delete(memoryTable).where(inArray(memoryTable.id, memoryIdsInRooms));
        }

        await this.db.delete(roomTable).where(inArray(roomTable.id, roomIds));

        logger.debug(
          {
            src: "plugin:sql",
            worldId,
            roomsDeleted: roomIds.length,
            memoriesDeleted: memoryIdsInRooms.length,
          },
          "World cleanup completed"
        );
      }
    });
  }

  // Message Server Database Operations

  /**
   * Creates a new message server in the central database
   */
  async createMessageServer(data: {
    id?: UUID; // Allow passing a specific ID
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
  }): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const serverToInsert = {
        id: newId,
        name: data.name,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing(); // In case the ID already exists

      // If server already existed, fetch it
      if (data.id) {
        const existing = await this.db
          .select()
          .from(messageServerTable)
          .where(eq(messageServerTable.id, data.id))
          .limit(1);
        if (existing.length > 0) {
          return {
            id: existing[0].id as UUID,
            name: existing[0].name,
            sourceType: existing[0].sourceType,
            sourceId: existing[0].sourceId || undefined,
            metadata: (existing[0].metadata || undefined) as Metadata | undefined,
            createdAt: existing[0].createdAt,
            updatedAt: existing[0].updatedAt,
          };
        }
      }

      return serverToInsert;
    });
  }

  /**
   * Gets all message servers
   */
  async getMessageServers(): Promise<
    Array<{
      id: UUID;
      name: string;
      sourceType: string;
      sourceId?: string;
      metadata?: Metadata;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const result = await this.withDatabase(async () => {
      const results = await this.db.select().from(messageServerTable);
      return results.map((r) => ({
        id: r.id as UUID,
        name: r.name,
        sourceType: r.sourceType,
        sourceId: r.sourceId || undefined,
        metadata: (r.metadata || undefined) as Metadata | undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
    // Guard against null return
    return result || [];
  }

  /**
   * Gets a message server by ID
   */
  async getMessageServerById(serverId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(messageServerTable)
        .where(eq(messageServerTable.id, serverId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            name: results[0].name,
            sourceType: results[0].sourceType,
            sourceId: results[0].sourceId || undefined,
            metadata: (results[0].metadata || undefined) as Metadata | undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Gets a message server by RLS server_id.
   * The server_id column is added dynamically when RLS is enabled.
   */
  async getMessageServerByRlsServerId(rlsServerId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      // Use raw SQL since server_id column is dynamically added by RLS and not in Drizzle schema
      const results = await this.db.execute(sql`
        SELECT id, name, source_type, source_id, metadata, created_at, updated_at
        FROM message_servers
        WHERE server_id = ${rlsServerId}
        LIMIT 1
      `);

      const rows = results.rows || results;
      return (rows as Record<string, unknown>[]).length > 0
        ? {
            id: (rows as Record<string, unknown>[])[0].id as UUID,
            name: (rows as Record<string, unknown>[])[0].name as string,
            sourceType: (rows as Record<string, unknown>[])[0].source_type as string,
            sourceId: ((rows as Record<string, unknown>[])[0].source_id || undefined) as
              | string
              | undefined,
            metadata: ((rows as Record<string, unknown>[])[0].metadata || undefined) as
              | Metadata
              | undefined,
            createdAt: new Date((rows as Record<string, unknown>[])[0].created_at as string),
            updatedAt: new Date((rows as Record<string, unknown>[])[0].updated_at as string),
          }
        : null;
    });
  }

  /**
   * Creates a new channel
   */
  async createChannel(
    data: {
      id?: UUID; // Allow passing a specific ID
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Metadata;
    },
    participantIds?: UUID[]
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const channelToInsert = {
        id: newId,
        messageServerId: data.messageServerId,
        name: data.name,
        type: data.type,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        topic: data.topic,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.transaction(async (tx) => {
        await tx.insert(channelTable).values(channelToInsert);

        if (participantIds && participantIds.length > 0) {
          const participantValues = participantIds.map((entityId) => ({
            channelId: newId,
            entityId: entityId,
          }));
          await tx.insert(channelParticipantsTable).values(participantValues).onConflictDoNothing();
        }
      });

      return channelToInsert;
    });
  }

  /**
   * Gets channels for a message server
   */
  async getChannelsForMessageServer(messageServerId: UUID): Promise<
    Array<{
      id: UUID;
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Metadata;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.messageServerId, messageServerId));
      return results.map((r) => ({
        id: r.id as UUID,
        messageServerId: r.messageServerId as UUID,
        name: r.name,
        type: r.type,
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        topic: r.topic || undefined,
        metadata: (r.metadata || undefined) as Metadata | undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Gets channel details
   */
  async getChannelDetails(channelId: UUID): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.id, channelId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            messageServerId: results[0].messageServerId as UUID,
            name: results[0].name,
            type: results[0].type,
            sourceType: results[0].sourceType || undefined,
            sourceId: results[0].sourceId || undefined,
            topic: results[0].topic || undefined,
            metadata: (results[0].metadata || undefined) as Metadata | undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Creates a message
   */
  async createMessage(data: {
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    messageId?: UUID;
  }): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = data.messageId || (v4() as UUID);
      const now = new Date();
      const messageToInsert = {
        id: newId,
        channelId: data.channelId,
        authorId: data.authorId,
        content: data.content,
        rawMessage: data.rawMessage,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        inReplyToRootMessageId: data.inReplyToRootMessageId,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageTable).values(messageToInsert);
      return messageToInsert;
    });
  }

  async getMessageById(id: UUID): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(messageTable)
        .where(eq(messageTable.id, id))
        .limit(1);
      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id as UUID,
        channelId: row.channelId as UUID,
        authorId: row.authorId as UUID,
        content: row.content,
        rawMessage: asRawMessage(row.rawMessage),
        sourceType: row.sourceType || undefined,
        sourceId: row.sourceId || undefined,
        metadata: (row.metadata || undefined) as Metadata | undefined,
        inReplyToRootMessageId: (row.inReplyToRootMessageId || undefined) as UUID | undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async updateMessage(
    id: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
    }
  ): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const existing = await this.getMessageById(id);
      if (!existing) return null;

      const updatedAt = new Date();
      const next = {
        content: patch.content ?? existing.content,
        rawMessage: patch.rawMessage ?? existing.rawMessage,
        sourceType: patch.sourceType ?? existing.sourceType,
        sourceId: patch.sourceId ?? existing.sourceId,
        metadata: patch.metadata ?? existing.metadata,
        inReplyToRootMessageId: patch.inReplyToRootMessageId ?? existing.inReplyToRootMessageId,
        updatedAt,
      };

      await this.db.update(messageTable).set(next).where(eq(messageTable.id, id));

      // Return merged object
      return {
        ...existing,
        ...next,
      };
    });
  }

  /**
   * Gets messages for a channel
   */
  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
  ): Promise<
    Array<{
      id: UUID;
      channelId: UUID;
      authorId: UUID;
      content: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return this.withDatabase(async () => {
      const conditions = [eq(messageTable.channelId, channelId)];
      if (beforeTimestamp) {
        conditions.push(lt(messageTable.createdAt, beforeTimestamp));
      }

      const query = this.db
        .select()
        .from(messageTable)
        .where(and(...conditions))
        .orderBy(desc(messageTable.createdAt))
        .limit(limit);

      const results = await query;
      return results.map((r) => ({
        id: r.id as UUID,
        channelId: r.channelId as UUID,
        authorId: r.authorId as UUID,
        content: r.content,
        rawMessage: asRawMessage(r.rawMessage),
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        metadata: asMetadata(r.metadata),
        inReplyToRootMessageId: r.inReplyToRootMessageId as UUID | undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Deletes a message
   */
  async deleteMessage(messageId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(messageTable).where(eq(messageTable.id, messageId));
    });
  }

  /**
   * Updates a channel
   */
  async updateChannel(
    channelId: UUID,
    updates: {
      name?: string;
      participantCentralUserIds?: UUID[];
      metadata?: Metadata;
    }
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const now = new Date();

      await this.db.transaction(async (tx) => {
        // Update channel details
        const updateData: Record<string, unknown> = { updatedAt: now };
        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

        await tx.update(channelTable).set(updateData).where(eq(channelTable.id, channelId));

        // Update participants if provided
        if (updates.participantCentralUserIds !== undefined) {
          // Remove existing participants
          await tx
            .delete(channelParticipantsTable)
            .where(eq(channelParticipantsTable.channelId, channelId));

          // Add new participants
          if (updates.participantCentralUserIds.length > 0) {
            const participantValues = updates.participantCentralUserIds.map((entityId) => ({
              channelId: channelId,
              entityId: entityId,
            }));
            await tx
              .insert(channelParticipantsTable)
              .values(participantValues)
              .onConflictDoNothing();
          }
        }
      });

      // Return updated channel details
      const updatedChannel = await this.getChannelDetails(channelId);
      if (!updatedChannel) {
        throw new Error(`Channel ${channelId} not found after update`);
      }
      return updatedChannel;
    });
  }

  /**
   * Deletes a channel and all its associated data
   */
  async deleteChannel(channelId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete all messages in the channel (cascade delete will handle this, but explicit is better)
        await tx.delete(messageTable).where(eq(messageTable.channelId, channelId));

        // Delete all participants (cascade delete will handle this, but explicit is better)
        await tx
          .delete(channelParticipantsTable)
          .where(eq(channelParticipantsTable.channelId, channelId));

        // Delete the channel itself
        await tx.delete(channelTable).where(eq(channelTable.id, channelId));
      });
    });
  }

  /**
   * Adds participants to a channel
   */
  async addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void> {
    return this.withDatabase(async () => {
      if (!entityIds || entityIds.length === 0) return;

      const participantValues = entityIds.map((entityId) => ({
        channelId: channelId,
        entityId: entityId,
      }));

      await this.db
        .insert(channelParticipantsTable)
        .values(participantValues)
        .onConflictDoNothing();
    });
  }

  /**
   * Gets participants for a channel
   */
  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ entityId: channelParticipantsTable.entityId })
        .from(channelParticipantsTable)
        .where(eq(channelParticipantsTable.channelId, channelId));

      return results.map((r) => r.entityId as UUID);
    });
  }

  /**
   * Check if an entity is a participant in a specific messaging channel.
   * @param {UUID} channelId - The ID of the channel to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  async isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(channelParticipantsTable)
        .where(
          and(
            eq(channelParticipantsTable.channelId, channelId),
            eq(channelParticipantsTable.entityId, entityId)
          )
        )
        .limit(1);

      return result.length > 0;
    });
  }

  /**
   * Adds an agent to a message server (Discord/Telegram server)
   */
  async addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .insert(messageServerAgentsTable)
        .values({
          messageServerId,
          agentId,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * Gets agents for a message server (Discord/Telegram server)
   */
  async getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ agentId: messageServerAgentsTable.agentId })
        .from(messageServerAgentsTable)
        .where(eq(messageServerAgentsTable.messageServerId, messageServerId));

      return results.map((r) => r.agentId as UUID);
    });
  }

  /**
   * Removes an agent from a message server (Discord/Telegram server)
   */
  async removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .delete(messageServerAgentsTable)
        .where(
          and(
            eq(messageServerAgentsTable.messageServerId, messageServerId),
            eq(messageServerAgentsTable.agentId, agentId)
          )
        );
    });
  }

  /**
   * Finds or creates a DM channel between two users
   */
  async findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const ids = [user1Id, user2Id].sort();
      const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

      const existingChannels = await this.db
        .select()
        .from(channelTable)
        .where(
          and(
            eq(channelTable.type, ChannelType.DM),
            eq(channelTable.name, dmChannelName),
            eq(channelTable.messageServerId, messageServerId)
          )
        )
        .limit(1);

      if (existingChannels.length > 0) {
        return {
          id: existingChannels[0].id as UUID,
          messageServerId: existingChannels[0].messageServerId as UUID,
          name: existingChannels[0].name,
          type: existingChannels[0].type,
          sourceType: existingChannels[0].sourceType || undefined,
          sourceId: existingChannels[0].sourceId || undefined,
          topic: existingChannels[0].topic || undefined,
          metadata: (existingChannels[0].metadata || undefined) as Metadata | undefined,
          createdAt: existingChannels[0].createdAt,
          updatedAt: existingChannels[0].updatedAt,
        };
      }

      // Create new DM channel
      return this.createChannel(
        {
          messageServerId,
          name: dmChannelName,
          type: ChannelType.DM,
          metadata: { user1: ids[0], user2: ids[1] },
        },
        ids
      );
    });
  }

  // ===============================
  // Pairing Methods
  // ===============================

  /**
   * Get all pending pairing requests for a channel and agent.
   */
  async getPairingRequests(queries: PairingRequestQuery[]): Promise<PairingRequestsResult> {
    return this.withDatabase(async () => {
      if (queries.length === 0) {
        return [];
      }

      return Promise.all(
        queries.map(async (query) => {
          const { channel, agentId } = query;
          const isPaged = query.limit !== undefined || query.offset !== undefined;
          const pageOptions = isPaged ? normalizePairingPageOptions(query) : null;
          const filteredQuery = this.db
            .select()
            .from(pairingRequestTable)
            .where(
              and(
                eq(pairingRequestTable.channel, channel),
                eq(pairingRequestTable.agentId, agentId),
                query.createdAfter
                  ? gte(pairingRequestTable.createdAt, query.createdAfter)
                  : undefined
              )
            );
          const orderedQuery =
            query.order === "newest"
              ? filteredQuery.orderBy(
                  desc(pairingRequestTable.createdAt),
                  desc(pairingRequestTable.id)
                )
              : query.order === "oldest"
                ? filteredQuery.orderBy(
                    asc(pairingRequestTable.createdAt),
                    asc(pairingRequestTable.id)
                  )
                : isPaged
                  ? filteredQuery.orderBy(
                      asc(pairingRequestTable.createdAt),
                      asc(pairingRequestTable.id)
                    )
                  : filteredQuery.orderBy(pairingRequestTable.createdAt);
          const results = pageOptions
            ? await orderedQuery.limit(pageOptions.limit + 1).offset(pageOptions.offset)
            : await orderedQuery;
          const hasMore = pageOptions ? results.length > pageOptions.limit : false;
          const rows = pageOptions ? results.slice(0, pageOptions.limit) : results;

          return {
            channel,
            agentId,
            requests: rows.map((row) => ({
              id: row.id as UUID,
              channel: row.channel as PairingChannel,
              senderId: row.senderId,
              code: row.code,
              createdAt: row.createdAt,
              lastSeenAt: row.lastSeenAt,
              metadata: (row.metadata as Record<string, string>) || undefined,
              agentId: row.agentId as UUID,
            })),
            ...(pageOptions
              ? {
                  pageInfo: {
                    limit: pageOptions.limit,
                    offset: pageOptions.offset,
                    hasMore,
                    nextOffset: hasMore ? pageOptions.offset + pageOptions.limit : null,
                  },
                }
              : {}),
          };
        })
      );
    });
  }

  /**
   * Create a new pairing request.
   */
  async createPairingRequest(request: PairingRequest): Promise<UUID> {
    return this.withDatabase(async () => {
      const id = request.id || (v4() as UUID);
      await this.db.insert(pairingRequestTable).values({
        id,
        channel: request.channel,
        senderId: request.senderId,
        code: request.code,
        createdAt: request.createdAt,
        lastSeenAt: request.lastSeenAt,
        metadata: request.metadata || {},
        agentId: request.agentId,
      });
      return id;
    });
  }

  /**
   * Update an existing pairing request.
   */
  async updatePairingRequest(request: PairingRequest): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(pairingRequestTable)
        .set({
          lastSeenAt: request.lastSeenAt,
          metadata: request.metadata || {},
        })
        .where(eq(pairingRequestTable.id, request.id));
    });
  }

  /**
   * Delete a pairing request by ID.
   */
  async deletePairingRequest(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(pairingRequestTable).where(eq(pairingRequestTable.id, id));
    });
  }

  /**
   * Get the allowlist for a channel and agent.
   */
  async getPairingAllowlist(
    channel: PairingChannel,
    agentId: UUID
  ): Promise<PairingAllowlistEntry[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(pairingAllowlistTable)
        .where(
          and(
            eq(pairingAllowlistTable.channel, channel),
            eq(pairingAllowlistTable.agentId, agentId)
          )
        )
        .orderBy(pairingAllowlistTable.createdAt);

      return results.map((row) => ({
        id: row.id as UUID,
        channel: row.channel as PairingChannel,
        senderId: row.senderId,
        createdAt: row.createdAt,
        metadata: (row.metadata as Record<string, string>) || undefined,
        agentId: row.agentId as UUID,
      }));
    });
  }

  /**
   * Create a new allowlist entry.
   */
  async createPairingAllowlistEntry(entry: PairingAllowlistEntry): Promise<UUID> {
    return this.withDatabase(async () => {
      const id = entry.id || (v4() as UUID);
      await this.db
        .insert(pairingAllowlistTable)
        .values({
          id,
          channel: entry.channel,
          senderId: entry.senderId,
          createdAt: entry.createdAt,
          metadata: entry.metadata || {},
          agentId: entry.agentId,
        })
        .onConflictDoNothing();
      return id;
    });
  }

  /**
   * Delete an allowlist entry by ID.
   */
  async deletePairingAllowlistEntry(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(pairingAllowlistTable).where(eq(pairingAllowlistTable.id, id));
    });
  }

  // ── Lifecycle methods ─────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    // error-policy:J4 explicit availability probe — false IS the designed answer
    // to "can the DB serve a query?"; a failing SELECT 1 means not-ready.
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async getConnection(): Promise<DrizzleDatabase> {
    return this.db;
  }

  async transaction<T>(
    callback: (tx: IDatabaseAdapter<DrizzleDatabase>) => Promise<T>,
    options?: { entityContext?: UUID }
  ): Promise<T> {
    const writes: Array<() => void> = [];
    const entityContext = options?.entityContext ?? this.transactionEntityContext ?? null;
    const result = await this.withEntityContext(entityContext, async (db) => {
      // The facade shares immutable adapter configuration but never replaces
      // the global connection or its connection-bound store cache.
      const scoped = Object.create(this) as BaseDrizzleAdapter;
      scoped.db = db;
      scoped.transactionWrites = writes;
      scoped.transactionEntityContext = entityContext;
      scoped._connectorAccountStore = undefined;
      scoped.withDatabase = (operation) => operation();
      scoped.withEntityContext = (requestedEntity, operation) => {
        if (
          entityContext !== null &&
          requestedEntity !== null &&
          requestedEntity !== entityContext
        ) {
          throw new ElizaError("A transaction cannot change its entity context.", {
            code: "TRANSACTION_ENTITY_CONTEXT_MISMATCH",
            context: { entityContext, requestedEntity },
          });
        }
        return db.transaction(async (savepoint) => {
          // System transactions may call entity-scoped methods for multiple
          // entities. A child scope must restore the parent's RLS setting.
          if (
            entityContext === null &&
            requestedEntity !== null &&
            this.databaseBackend !== "pglite" &&
            process.env.ENABLE_DATA_ISOLATION === "true"
          ) {
            const before = await savepoint.execute(
              sql`SELECT current_setting('app.entity_id', true) AS entity_id`
            );
            await savepoint.execute(
              sql`SELECT set_config('app.entity_id', ${requestedEntity}, true)`
            );
            const value = await operation(savepoint);
            await savepoint.execute(
              sql`SELECT set_config('app.entity_id', ${before.rows[0]?.entity_id ?? ""}, true)`
            );
            return value;
          }
          return operation(savepoint);
        });
      };
      return callback(scoped);
    });
    const publicationErrors: unknown[] = [];
    for (const write of writes) {
      try {
        this.publishCommittedWrite(write);
      } catch (error) {
        // error-policy:J2 attempt every committed publication before reporting the committed failure.
        publicationErrors.push(error);
      }
    }
    if (publicationErrors.length > 0) {
      throw new ElizaError(
        "SQL committed, but publishing its writes failed. Do not replay the transaction.",
        {
          code: "TRANSACTION_PUBLICATION_FAILED",
          context: { committed: true, failedPublications: publicationErrors.length },
          cause: new AggregateError(publicationErrors, "Committed write publication failed"),
        }
      );
    }
    return result;
  }

  // ── Component batch methods ───────────────────────────────────────────

  async getComponentsByNaturalKeys(
    keys: Array<{
      entityId: UUID;
      type: string;
      worldId?: UUID;
      sourceEntityId?: UUID;
    }>
  ): Promise<(Component | null)[]> {
    if (keys.length === 0) return [];
    const results: (Component | null)[] = [];
    for (const key of keys) {
      const component = await this.getComponent(
        key.entityId,
        key.type,
        key.worldId,
        key.sourceEntityId
      );
      results.push(component);
    }
    return results;
  }

  async getComponentsForEntities(
    entityIds: UUID[],
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component[]> {
    if (entityIds.length === 0) return [];
    return this.withDatabase(async () => {
      const conditions: SQL[] = [inArray(componentTable.entityId, entityIds)];
      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }
      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }
      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));
      return result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));
    });
  }

  async createComponents(components: Component[]): Promise<UUID[]> {
    if (components.length === 0) return [];
    return this.withDatabase(async () => {
      const ids: UUID[] = [];
      for (const component of components) {
        const success = await this.createComponent(component);
        if (success) ids.push(component.id);
      }
      return ids;
    });
  }

  async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
    if (componentIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(componentTable)
        .where(inArray(componentTable.id, componentIds));
      return result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));
    });
  }

  async updateComponents(components: Component[]): Promise<void> {
    for (const component of components) {
      await this.updateComponent(component);
    }
  }

  async deleteComponents(componentIds: UUID[]): Promise<void> {
    if (componentIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(inArray(componentTable.id, componentIds));
    });
  }

  async upsertComponents(
    components: Component[],
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const component of components) {
      const existing = await this.getComponent(
        component.entityId,
        component.type,
        component.worldId,
        component.sourceEntityId
      );
      if (existing) {
        await this.updateComponent({ ...component, id: existing.id });
      } else {
        await this.createComponent(component);
      }
    }
  }

  async patchComponents(
    updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const update of updates) {
      const rows = await this.withDatabase(async () =>
        this.db.select().from(componentTable).where(eq(componentTable.id, update.componentId))
      );
      const row = rows[0];
      if (!row) continue;

      const data = { ...((row.data ?? {}) as Record<string, unknown>) };
      for (const op of update.ops) {
        applyPatchOp(data, op);
      }

      await this.withDatabase(async () => {
        await this.db
          .update(componentTable)
          .set({ data })
          .where(eq(componentTable.id, update.componentId));
      });
    }
  }

  // ── Entity batch methods ──────────────────────────────────────────────

  async upsertEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      if (!entity.id) {
        await this.createEntities([entity]);
        continue;
      }
      const existing = await this.getEntitiesByIds([entity.id]);
      if (existing.length > 0) {
        await this.updateEntity(entity);
      } else {
        await this.createEntities([entity]);
      }
    }
  }

  async queryEntities(params: {
    componentType?: string;
    componentDataFilter?: Record<string, unknown>;
    agentId?: UUID;
    entityIds?: UUID[];
    worldId?: UUID;
    limit?: number;
    offset?: number;
    includeAllComponents?: boolean;
    entityContext?: UUID;
  }): Promise<Entity[]> {
    validateQueryEntitiesPagination(params);
    return this.withDatabase(async () => {
      const conditions: SQL[] = [];
      const hasComponentQuery =
        params.componentType !== undefined ||
        params.componentDataFilter !== undefined ||
        params.worldId !== undefined;

      if (params.agentId) {
        conditions.push(eq(entityTable.agentId, params.agentId));
      }
      if (params.entityIds?.length) {
        conditions.push(inArray(entityTable.id, params.entityIds));
      }

      // Build a single EXISTS subquery when filtering by componentType,
      // component data, and/or worldId.
      // Both predicates apply to the component table so they share one subquery.
      if (hasComponentQuery) {
        const subConditions: SQL[] = [sql`${componentTable.entityId} = ${entityTable.id}`];
        if (params.agentId) {
          subConditions.push(sql`${componentTable.agentId} = ${params.agentId}`);
        }
        if (params.componentType !== undefined) {
          subConditions.push(sql`${componentTable.type} = ${params.componentType}`);
        }
        if (params.componentDataFilter !== undefined) {
          subConditions.push(
            sql`${componentTable.data} @> ${JSON.stringify(params.componentDataFilter)}::jsonb`
          );
        }
        if (params.worldId !== undefined) {
          subConditions.push(sql`${componentTable.worldId} = ${params.worldId}`);
        }
        const subquery = sql`EXISTS (
          SELECT 1 FROM ${componentTable}
          WHERE ${sql.join(subConditions, sql` AND `)}
        )`;
        conditions.push(subquery);
      }

      let query = this.db
        .select()
        .from(entityTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      if (params.limit !== undefined && !params.entityIds?.length) {
        query = query.limit(params.limit) as typeof query;
      }
      if (params.offset !== undefined && !params.entityIds?.length) {
        query = query.offset(params.offset) as typeof query;
      }

      const result = await query;

      let entities: Entity[] = result.map((row) => ({
        ...row,
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));
      if (params.entityIds?.length) {
        const inputOrder = new Map(params.entityIds.map((entityId, index) => [entityId, index]));
        entities.sort(
          (left, right) =>
            (inputOrder.get(left.id as UUID) ?? Number.MAX_SAFE_INTEGER) -
            (inputOrder.get(right.id as UUID) ?? Number.MAX_SAFE_INTEGER)
        );
        const offset = params.offset ?? 0;
        const limit = params.limit ?? entities.length;
        entities = entities.slice(offset, offset + limit);
      }

      // Component-filtered queries return the components that established the
      // match. Callers may explicitly request every component on those entities.
      if ((params.includeAllComponents || hasComponentQuery) && entities.length > 0) {
        const entityIds = entities.flatMap((entity) => (entity.id ? [entity.id] : []));
        const componentConditions: SQL[] = [inArray(componentTable.entityId, entityIds)];
        if (params.agentId) {
          componentConditions.push(eq(componentTable.agentId, params.agentId));
        }
        if (!params.includeAllComponents) {
          if (params.componentType !== undefined) {
            componentConditions.push(eq(componentTable.type, params.componentType));
          }
          if (params.componentDataFilter !== undefined) {
            componentConditions.push(
              sql`${componentTable.data} @> ${JSON.stringify(params.componentDataFilter)}::jsonb`
            );
          }
          if (params.worldId !== undefined) {
            componentConditions.push(eq(componentTable.worldId, params.worldId));
          }
        }
        const componentRows = await this.db
          .select()
          .from(componentTable)
          .where(and(...componentConditions));
        const components: Component[] = componentRows.map((component) => ({
          ...component,
          id: component.id as UUID,
          entityId: component.entityId as UUID,
          agentId: component.agentId as UUID,
          roomId: component.roomId as UUID,
          worldId: (component.worldId ?? "") as UUID,
          sourceEntityId: (component.sourceEntityId ?? "") as UUID,
          data: component.data as Metadata,
          createdAt: component.createdAt.getTime(),
        }));
        const componentsByEntity = new Map<UUID, Component[]>();
        for (const comp of components) {
          const list = componentsByEntity.get(comp.entityId) ?? [];
          list.push(comp);
          componentsByEntity.set(comp.entityId, list);
        }
        for (const entity of entities) {
          entity.components = entity.id ? (componentsByEntity.get(entity.id) ?? []) : [];
        }
      }

      return entities;
    });
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      await this.updateEntity(entity);
    }
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    for (const entityId of entityIds) {
      await this.deleteEntity(entityId);
    }
  }

  async getEntitiesForRooms(
    roomIds: UUID[],
    includeComponents?: boolean
  ): Promise<EntitiesForRoomsResult> {
    const result: EntitiesForRoomsResult = [];
    for (const roomId of roomIds) {
      const entities = await this.getEntitiesForRoom(roomId, includeComponents);
      result.push({ roomId, entities });
    }
    return result;
  }

  // ── Log batch methods ─────────────────────────────────────────────────

  async createLogs(
    params: Array<{
      body: LogBody;
      entityId: UUID;
      roomId: UUID;
      type: string;
    }>
  ): Promise<void> {
    for (const param of params) {
      await this.log(param);
    }
  }

  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    if (logIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db.select().from(logTable).where(inArray(logTable.id, logIds));
      return result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        type: log.type as string,
        body: log.body as LogBody,
        createdAt: new Date(log.createdAt as string | number | Date),
      }));
    });
  }

  async updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void> {
    return this.withDatabase(async () => {
      for (const { id, updates } of logs) {
        const setValues: Record<string, unknown> = {};
        if (updates.body !== undefined) setValues.body = updates.body;
        if (updates.type !== undefined) setValues.type = updates.type;
        if (Object.keys(setValues).length > 0) {
          await this.db.update(logTable).set(setValues).where(eq(logTable.id, id));
        }
      }
    });
  }

  async deleteLogs(logIds: UUID[]): Promise<void> {
    if (logIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(inArray(logTable.id, logIds));
    });
  }

  // ── Memory batch methods ──────────────────────────────────────────────

  async createMemories(
    memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>
  ): Promise<UUID[]> {
    if (memories.length === 0) return [];

    this.validateMemoryBatchEmbeddings(memories);

    const entityContexts = new Set(memories.map(({ memory }) => memory.entityId ?? null));
    // A homogeneous batch keeps its entity-scoped RLS context. Mixed-entity
    // bulk imports are system operations, so they run under the server context
    // while retaining one all-or-nothing database transaction.
    const entityContext = entityContexts.size === 1 ? (memories[0].memory.entityId ?? null) : null;

    const prepared = memories.map(({ memory, tableName, unique }) => ({
      memory: unique !== undefined ? { ...memory, unique } : memory,
      tableName,
      id: memory.id ?? (v4() as UUID),
    }));
    for (const entry of prepared) {
      await this.resolveMemoryUniqueness(entry.memory, entry.tableName);
    }

    await this.withEntityContext(entityContext, async (tx) => {
      for (const entry of prepared) {
        await this.insertMemoryInTransaction(tx, entry.memory, entry.tableName, entry.id);
      }
    });

    const ids = prepared.map((entry) => entry.id);
    return ids;
  }

  async updateMemories(
    memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>
  ): Promise<void> {
    for (const memory of memories) {
      await this.updateMemory(memory);
    }
  }

  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const { memory, tableName } of memories) {
      if (memory.id) {
        const existing = await this.getMemoryById(memory.id);
        if (existing) {
          await this.updateMemory(memory as Partial<Memory> & { id: UUID });
          continue;
        }
      }
      await this.createMemory(memory, tableName);
    }
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    await this.deleteManyMemories(memoryIds);
  }

  // ── World batch methods ───────────────────────────────────────────────

  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    if (worldIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(inArray(worldTable.id, worldIds));
      return result.map((world) => this.mapWorldResult(world));
    });
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const world of worlds) {
      const id = await this.createWorld(world);
      ids.push(id);
    }
    return ids;
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    for (const id of worldIds) {
      await this.removeWorld(id);
    }
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      await this.updateWorld(world);
    }
  }

  async upsertWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      const existing = await this.getWorld(world.id);
      if (existing) {
        await this.updateWorld(world);
      } else {
        await this.createWorld(world);
      }
    }
  }

  // ── Room batch methods ────────────────────────────────────────────────

  async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
    for (const worldId of worldIds) {
      await this.deleteRoomsByWorldId(worldId);
    }
  }

  async getRoomsByWorlds(worldIds: UUID[], limit?: number, offset?: number): Promise<Room[]> {
    if (worldIds.length === 0) return [];
    return this.withDatabase(async () => {
      const conditions = [
        inArray(roomTable.worldId, worldIds),
        eq(roomTable.agentId, this.agentId),
      ];
      let query = this.db
        .select()
        .from(roomTable)
        .where(and(...conditions));
      if (offset != null) {
        query = query.offset(offset) as typeof query;
      }
      if (limit != null) {
        query = query.limit(limit) as typeof query;
      }
      const result = await query;
      return result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));
    });
  }

  async upsertRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      const existing = await this.getRoomsByIds([room.id]);
      if (existing && existing.length > 0) {
        await this.updateRoom(room);
      } else {
        await this.createRooms([room]);
      }
    }
  }

  async createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entityId of entityIds) {
      const success = await this.addParticipant(entityId, roomId);
      if (success) {
        ids.push(`${roomId}:${entityId}` as UUID);
      }
    }
    return ids;
  }

  async deleteParticipants(
    participants: Array<{ entityId: UUID; roomId: UUID }>
  ): Promise<boolean> {
    for (const { entityId, roomId } of participants) {
      const success = await this.removeParticipant(entityId, roomId);
      if (!success) return false;
    }
    return true;
  }

  async updateParticipants(
    participants: Array<{
      entityId: UUID;
      roomId: UUID;
      updates: ParticipantUpdateFields;
    }>
  ): Promise<void> {
    for (const { entityId, roomId, updates } of participants) {
      if (updates.roomState !== undefined) {
        await this.setParticipantUserState(roomId, entityId, updates.roomState);
      }
    }
  }

  async updateRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      await this.updateRoom(room);
    }
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    for (const roomId of roomIds) {
      await this.deleteRoom(roomId);
    }
  }

  // ── Participant batch methods ─────────────────────────────────────────

  async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
    const result: Participant[] = [];
    for (const entityId of entityIds) {
      const participants = await this.getParticipantsForEntity(entityId);
      result.push(...participants);
    }
    return result;
  }

  async getParticipantsForRooms(roomIds: UUID[]): Promise<ParticipantsForRoomsResult> {
    const result: ParticipantsForRoomsResult = [];
    for (const roomId of roomIds) {
      const entityIds = await this.getParticipantsForRoom(roomId);
      result.push({ roomId, entityIds });
    }
    return result;
  }

  async areRoomParticipants(pairs: Array<{ roomId: UUID; entityId: UUID }>): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const { roomId, entityId } of pairs) {
      const isParticipant = await this.isRoomParticipant(roomId, entityId);
      results.push(isParticipant);
    }
    return results;
  }

  async getParticipantUserStates(
    pairs: Array<{ roomId: UUID; entityId: UUID }>
  ): Promise<ParticipantUserState[]> {
    const results: ParticipantUserState[] = [];
    for (const { roomId, entityId } of pairs) {
      const state = await this.getParticipantUserState(roomId, entityId);
      results.push(state);
    }
    return results;
  }

  async updateParticipantUserStates(
    updates: Array<{
      roomId: UUID;
      entityId: UUID;
      state: ParticipantUserState;
    }>
  ): Promise<void> {
    for (const { roomId, entityId, state } of updates) {
      await this.setParticipantUserState(roomId, entityId, state);
    }
  }

  // ── Relationship batch methods ────────────────────────────────────────

  async getRelationshipsByPairs(
    pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>
  ): Promise<(Relationship | null)[]> {
    const results: (Relationship | null)[] = [];
    for (const pair of pairs) {
      const rel = await this.getRelationship(pair);
      results.push(rel);
    }
    return results;
  }

  async createRelationships(
    relationships: Array<{
      sourceEntityId: UUID;
      targetEntityId: UUID;
      tags?: string[];
      metadata?: Metadata;
    }>
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const rel of relationships) {
      const success = await this.createRelationship(rel);
      if (success) {
        const persisted = await this.getRelationship(rel);
        if (!persisted) {
          throw new ElizaError("createRelationships readback failed", {
            code: "DB_READBACK_FAILED",
            context: {
              table: "relationships",
              agentId: this.agentId,
              sourceEntityId: rel.sourceEntityId,
              targetEntityId: rel.targetEntityId,
            },
          });
        }
        ids.push(persisted.id);
      }
    }
    return ids;
  }

  async getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]> {
    if (relationshipIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(inArray(relationshipTable.id, relationshipIds));
      return result.map((relationship) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt: relationship.createdAt.toISOString(),
      }));
    });
  }

  async updateRelationships(relationships: Relationship[]): Promise<void> {
    for (const relationship of relationships) {
      await this.updateRelationship(relationship);
    }
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    if (relationshipIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(relationshipTable).where(inArray(relationshipTable.id, relationshipIds));
    });
  }

  // ── Cache batch methods ───────────────────────────────────────────────

  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of keys) {
      const value = await this.getCache<T>(key);
      if (value !== undefined) {
        result.set(key, value);
      }
    }
    return result;
  }

  async setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    for (const { key, value } of entries) {
      const success = await this.setCache(key, value);
      if (!success) return false;
    }
    return true;
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const success = await this.deleteCache(key);
      if (!success) return false;
    }
    return true;
  }

  // ── Task batch methods ────────────────────────────────────────────────

  async createTasks(tasks: Task[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const task of tasks) {
      const id = await this.createTask(task);
      ids.push(id);
    }
    return ids;
  }

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.getTask(taskId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async updatePendingTask(id: UUID, task: Partial<Task>): Promise<boolean> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const updateValues: Partial<typeof taskTable.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (task.tags !== undefined) updateValues.tags = task.tags;
        if (task.metadata !== undefined) {
          updateValues.metadata = task.metadata as typeof taskTable.$inferInsert.metadata;
        }
        const updated = await this.db
          .update(taskTable)
          .set(updateValues)
          .where(
            and(
              eq(taskTable.id, id),
              eq(taskTable.agentId, this.agentId),
              sql`${taskTable.tags} @> ARRAY['queue']::text[]`,
              sql`COALESCE(${taskTable.metadata}->>'status', 'pending') = 'pending'`
            )
          )
          .returning();
        return updated.length === 1;
      });
    });
  }

  async updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    for (const { id, task } of updates) {
      await this.updateTask(id, task);
    }
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    for (const taskId of taskIds) {
      await this.deleteTask(taskId);
    }
  }

  // ── Pairing batch methods ─────────────────────────────────────────────

  async getPairingAllowlists(queries: PairingAllowlistQuery[]): Promise<PairingAllowlistsResult> {
    return this.withDatabase(async () => {
      if (queries.length === 0) return [];

      return Promise.all(
        queries.map(async (query) => {
          const { channel, agentId } = query;
          const isPaged = query.limit !== undefined || query.offset !== undefined;
          const pageOptions = isPaged ? normalizePairingPageOptions(query) : null;
          const filteredQuery = this.db
            .select()
            .from(pairingAllowlistTable)
            .where(
              and(
                eq(pairingAllowlistTable.channel, channel),
                eq(pairingAllowlistTable.agentId, agentId)
              )
            );
          const orderedQuery =
            query.order === "newest"
              ? filteredQuery.orderBy(
                  desc(pairingAllowlistTable.createdAt),
                  desc(pairingAllowlistTable.id)
                )
              : query.order === "oldest"
                ? filteredQuery.orderBy(
                    asc(pairingAllowlistTable.createdAt),
                    asc(pairingAllowlistTable.id)
                  )
                : isPaged
                  ? filteredQuery.orderBy(
                      asc(pairingAllowlistTable.createdAt),
                      asc(pairingAllowlistTable.id)
                    )
                  : filteredQuery.orderBy(pairingAllowlistTable.createdAt);
          const results = pageOptions
            ? await orderedQuery.limit(pageOptions.limit + 1).offset(pageOptions.offset)
            : await orderedQuery;
          const hasMore = pageOptions ? results.length > pageOptions.limit : false;
          const rows = pageOptions ? results.slice(0, pageOptions.limit) : results;

          return {
            channel,
            agentId,
            entries: rows.map((row) => ({
              id: row.id as UUID,
              channel: row.channel as PairingChannel,
              senderId: row.senderId,
              createdAt: row.createdAt,
              metadata: (row.metadata as Record<string, string>) || undefined,
              agentId: row.agentId as UUID,
            })),
            ...(pageOptions
              ? {
                  pageInfo: {
                    limit: pageOptions.limit,
                    offset: pageOptions.offset,
                    hasMore,
                    nextOffset: hasMore ? pageOptions.offset + pageOptions.limit : null,
                  },
                }
              : {}),
          };
        })
      );
    });
  }

  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const request of requests) {
      const id = await this.createPairingRequest(request);
      ids.push(id);
    }
    return ids;
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    for (const request of requests) {
      await this.updatePairingRequest(request);
    }
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingRequest(id);
    }
  }

  async createPairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entry of entries) {
      const id = await this.createPairingAllowlistEntry(entry);
      ids.push(id);
    }
    return ids;
  }

  async updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    // The singular updatePairingAllowlistEntry doesn't exist in base.ts,
    // so we implement inline using the same pattern as the singular update.
    return this.withDatabase(async () => {
      for (const entry of entries) {
        if (!entry.id) continue;
        await this.db
          .update(pairingAllowlistTable)
          .set({
            metadata: entry.metadata || {},
          })
          .where(eq(pairingAllowlistTable.id, entry.id));
      }
    });
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingAllowlistEntry(id);
    }
  }

  // ── Connector account storage ────────────────────────────────────────

  async listConnectorAccounts(
    params?: ListConnectorAccountsParams
  ): Promise<ConnectorAccountRecord[]> {
    return this.getConnectorAccountStore().listAccounts(params ?? {});
  }

  async getConnectorAccount(
    params: GetConnectorAccountParams
  ): Promise<ConnectorAccountRecord | null> {
    return this.getConnectorAccountStore().getAccount(params);
  }

  async upsertConnectorAccount(
    params: UpsertConnectorAccountParams
  ): Promise<ConnectorAccountRecord> {
    return this.getConnectorAccountStore().upsertAccount(params);
  }

  async deleteConnectorAccount(params: DeleteConnectorAccountParams): Promise<boolean> {
    return this.getConnectorAccountStore().deleteAccount(params);
  }

  async findConnectorOwnerBinding(
    params: ConnectorOwnerBindingLookup
  ): Promise<ConnectorOwnerBindingRecord | null> {
    return this.getConnectorAccountStore().findOwnerBinding(params);
  }

  async setConnectorAccountCredentialRef(
    params: SetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord> {
    return this.getConnectorAccountStore().setCredentialRef(params);
  }

  async getConnectorAccountCredentialRef(
    params: GetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord | null> {
    return this.getConnectorAccountStore().getCredentialRef(params);
  }

  async listConnectorAccountCredentialRefs(
    params: ListConnectorAccountCredentialRefsParams
  ): Promise<ConnectorAccountCredentialRefRecord[]> {
    return this.getConnectorAccountStore().listCredentialRefs(params);
  }

  async deleteConnectorAccountCredentialRefs(
    params: DeleteConnectorAccountCredentialRefsParams
  ): Promise<number> {
    return this.getConnectorAccountStore().deleteCredentialRefs(params);
  }

  async appendConnectorAccountAuditEvent(
    params: AppendConnectorAccountAuditEventParams
  ): Promise<ConnectorAccountAuditEventRecord> {
    return this.getConnectorAccountStore().appendAuditEvent(params);
  }

  async listConnectorAccountAuditEvents(
    params: ListConnectorAccountAuditEventsParams = {}
  ): Promise<ConnectorAccountAuditEventRecord[]> {
    return this.getConnectorAccountStore().listAuditEvents(params);
  }

  async createOAuthFlowState(params: CreateOAuthFlowStateParams): Promise<OAuthFlowRecord> {
    return this.getConnectorAccountStore().createOAuthFlowState(params);
  }

  async consumeOAuthFlowState(
    params: ConsumeOAuthFlowStateParams
  ): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().consumeOAuthFlowState(params);
  }

  async getOAuthFlowState(params: GetOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().getOAuthFlowState(params);
  }

  async updateOAuthFlowState(params: UpdateOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().updateOAuthFlowState(params);
  }

  async deleteOAuthFlowState(params: DeleteOAuthFlowStateParams): Promise<boolean> {
    return this.getConnectorAccountStore().deleteOAuthFlowState(params);
  }
}

// Import tables at the end to avoid circular dependencies
