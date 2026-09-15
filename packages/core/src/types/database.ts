/**
 * Database-adapter contract and its row/log types: `IDatabaseAdapter`, run/log
 * body shapes, patch ops, and the participant/entity query result types. Defines
 * the persistence boundary the runtime reads and writes through; implemented by
 * `plugin-sql` and the in-memory fallback adapter.
 */
import type { AccessContext } from "./access-context";
import type { Agent } from "./agent";
import type {
	Component,
	Entity,
	Participant,
	Relationship,
	Room,
	World,
} from "./environment";
import type { Memory, MemoryMetadata, MemoryScope } from "./memory";
import type {
	PairingAllowlistEntry,
	PairingAllowlistQuery,
	PairingChannel,
	PairingPageInfo,
	PairingRequest,
	PairingRequestQuery,
} from "./pairing";
import type { JsonValue, Metadata, UUID } from "./primitives";
import type { Task } from "./task";

/**
 * One ranked hit from {@link IDatabaseAdapter.searchMessages}. `ftsRank` is the
 * Postgres `ts_rank_cd` relevance from the full-text match (0 when the row
 * matched only via the trigram/substring branch); `trigramSimilarity` is the
 * `pg_trgm` similarity of the folded document to the folded query in `[0,1]`
 * (0 when the trigram extension is unavailable). Both are real measured signals
 * — never a fabricated default — so callers can rank and threshold honestly.
 */
export interface MessageSearchHit {
	memory: Memory;
	ftsRank: number;
	trigramSimilarity: number;
}

/**
 * Stable newest-first cursor for document-list pagination. New cursors carry
 * the first page's upper ordering bound so later pages exclude ordinary
 * concurrent inserts that sort ahead of the original result set. Older
 * two-field cursors remain readable and use their own position as the bound.
 * Inserts backdated at or below the bound can join later pages, and deleting
 * an unread row removes it; callers needing a database-wide MVCC snapshot must
 * use a transaction rather than a portable cursor.
 */
export interface DocumentListCursor {
	createdAt: number;
	id: UUID;
	snapshotCreatedAt?: number;
	snapshotId?: UUID;
}

/** Visibility scopes understood by the document-list storage query. */
export type DocumentListScope = Extract<
	MemoryScope,
	"global" | "owner-private" | "user-private" | "agent-private"
>;

/** Requester roles used to enforce document visibility inside the adapter. */
export type DocumentListRequesterRole =
	| "OWNER"
	| "ADMIN"
	| "USER"
	| "GUEST"
	| "AGENT"
	| "RUNTIME"
	| "UNRESOLVED";

/** Identity and room membership used by every document authorization query. */
export interface DocumentRequesterContext {
	agentId: UUID;
	requesterEntityId: UUID;
	requesterRoomIds: UUID[];
	requesterRole: DocumentListRequesterRole;
}

/**
 * Fully pushed-down document-list query. `requesterEntityId` is isolation
 * context, never a row predicate; document ownership filters are explicit.
 */
export interface DocumentListQueryParams extends DocumentRequesterContext {
	limit: number;
	offset: number;
	cursor?: DocumentListCursor;
	query?: string;
	scope?: DocumentListScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	timeRangeStart?: number;
	timeRangeEnd?: number;
	tags?: string[];
}

/** Authorized single-document lookup. */
export interface DocumentGetQueryParams extends DocumentRequesterContext {
	documentId: UUID;
}

/** Exact unit used by an authorized document read. */
export type DocumentRangeUnit = "line" | "fragment";

/**
 * Authorized document read. Offsets and caller-requested limits count exact
 * retained line or paragraph-like fragment units, never JavaScript string code
 * units. Omitting `limit` returns the complete remainder of the source.
 */
export interface DocumentRangeReadParams extends DocumentRequesterContext {
	documentId: UUID;
	unit: DocumentRangeUnit;
	offset: number;
	limit?: number;
}

/**
 * Source projection returned by a native adapter. The source
 * fingerprint is an adapter-internal change detector and must be wrapped in an
 * opaque public revision before it leaves DocumentService.
 */
export interface DocumentRangeReadResult {
	text: string;
	start: number;
	end: number;
	total: number;
	documentRevision: number;
	revisionAttemptId?: string;
	sourceFingerprint: string;
}

/**
 * Authorized fragment query. Fragment visibility is derived from the parent
 * document, never from denormalized fragment metadata.
 */
export interface DocumentFragmentQueryParams extends DocumentRequesterContext {
	limit: number;
	offset?: number;
	documentId?: UUID;
	roomId?: UUID;
	worldId?: UUID;
	entityId?: UUID;
	embedding?: number[];
	matchThreshold?: number;
}

/**
 * Authorization-sensitive fields observed before a document mutation. SQL
 * adapters compare them in the same statement that writes or deletes.
 */
export interface DocumentMutationSnapshot {
	/** Exact persisted pin state fences metadata edits independently of content revisions. */
	pinState?: string;
	scope: DocumentListScope;
	roomId: UUID;
	entityId: UUID;
	directGrantEntityIds?: UUID[];
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	revision: number;
	ingestionAttemptId?: UUID;
	ingestionState?: "pending" | "ready" | "failed";
}

/** Compare-and-swap document replacement under canonical mutation policy. */
export interface DocumentCompareAndSwapParams extends DocumentRequesterContext {
	documentId: UUID;
	expected: DocumentMutationSnapshot;
	replacement: Memory;
}

/** Atomic replacement of a document's explicit entity read grants. */
export interface DocumentDirectGrantUpdateParams
	extends DocumentRequesterContext {
	documentId: UUID;
	expected: DocumentMutationSnapshot;
	directGrantEntityIds: UUID[];
}

/**
 * Atomic replacement of a document parent and its complete fragment revision.
 * Replacement fragment IDs must be fresh; adapters reject IDs from the
 * committed generation so secondary indexes and asynchronous replicas can
 * preserve the old revision until the parent commit point advances.
 */
export interface DocumentRevisionReplaceParams
	extends DocumentCompareAndSwapParams {
	fragments: Memory[];
}

/** Compare-and-swap document deletion under canonical mutation policy. */
export interface DocumentDeleteParams extends DocumentRequesterContext {
	documentId: UUID;
	expected: DocumentMutationSnapshot;
}

/**
 * Durable audit row committed in the SAME adapter transaction as an
 * authorization-role write (#23100). A committed role change must never be
 * separable from its audit record, so the audit insert rides the CAS
 * transaction rather than a follow-up `createLogs` call.
 */
export interface RoleWriteAuditRecord {
	/** Originating actor whose authority produced the write. */
	actorEntityId: UUID;
	/** Entity whose world role changed. */
	targetEntityId: UUID;
	/** Role held by the target immediately before the write. */
	previousRole: string;
	/** Role after the write (same as previousRole when nothing changed). */
	newRole: string;
	/** Grant provenance recorded alongside the role. */
	source: string;
	/** Real room the mutation request originated from — audit scope. */
	roomId: UUID;
}

/**
 * Compare-and-swap replacement of a world's whole `metadata` JSON under the
 * exact prior snapshot (#23100 role-write atomicity). Mirrors the document
 * mutation contract: the adapter compares `expectedMetadata` against the
 * stored value in the same transaction that writes `replacementMetadata`,
 * commits the audit row only on success, and reports a typed conflict so a
 * concurrent writer can never be silently overwritten.
 */
export interface WorldMetadataCompareAndSwapParams {
	worldId: UUID;
	/** Exact prior metadata snapshot the caller read and authorized against. */
	expectedMetadata: Metadata;
	/** Whole replacement metadata; role grants are embedded within. */
	replacementMetadata: Metadata;
	/** Committed atomically with the metadata replacement. */
	audit?: RoleWriteAuditRecord;
}

export type WorldMetadataMutationResult =
	| { status: "updated" }
	| { status: "not_found" | "conflict" };

/**
 * Canonical `logs.type` tag for durable role-write audit rows committed by
 * {@link IDatabaseAdapter.compareAndSwapWorldMetadata}. Queried as
 * `getLogs({ type: "role_audit" })`.
 */
export const ROLE_WRITE_AUDIT_LOG_TYPE = "role_audit";

export type DocumentMutationResult =
	| { status: "updated"; document: Memory }
	| { status: "deleted"; document: Memory }
	| { status: "not_found" | "forbidden" | "conflict" };

/** Exact counts and bounded pages returned by a document-list adapter query. */
export interface DocumentListQueryResult {
	documents: Memory[];
	availableDocuments: Memory[];
	totalVisible: number;
	totalAvailable: number;
	totalMatched: number;
	hasMore: boolean;
	availableHasMore: boolean;
	nextCursor?: DocumentListCursor;
	availableNextCursor?: DocumentListCursor;
}

/** Run status enumeration (database). */
export const DbRunStatus = {
	UNSPECIFIED: "UNSPECIFIED",
	STARTED: "STARTED",
	COMPLETED: "COMPLETED",
	TIMEOUT: "TIMEOUT",
	ERROR: "ERROR",
} as const;
export type DbRunStatus = (typeof DbRunStatus)[keyof typeof DbRunStatus];

/**
 * Allowed value types for log body fields
 */
export type LogBodyValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| UUID
	| Error
	| LogBodyValue[]
	| { [key: string]: LogBodyValue };

/**
 * Base log body type with common properties
 */
export interface BaseLogBody {
	runId?: string | UUID;
	parentRunId?: string | UUID;
	status?: string;
	messageId?: UUID;
	roomId?: UUID;
	entityId?: UUID;
	source?: string;
	startTime?: number | bigint;
	endTime?: number | bigint;
	duration?: number | bigint;
	metadata?: Record<string, LogBodyValue>;
}

/**
 * Action log content structure
 */
export interface ActionLogContent {
	actions?: string[];
	text?: string;
	thought?: string;
}

/**
 * Action result structure for logging
 */
export interface ActionLogResult {
	success?: boolean;
	text?: string;
	data?: Record<string, LogBodyValue>;
	error?: string | Error;
}

/**
 * Prompt tracking for action logs
 */
export interface ActionLogPrompt {
	modelType: string;
	prompt: string;
	timestamp: number | bigint;
}

/**
 * Log body for action logs
 */
export interface ActionLogBody extends BaseLogBody {
	base?: BaseLogBody;
	action?: string;
	actionName?: string;
	actionId?: UUID | string;
	message?: string;
	messageId?: UUID;
	state?: Record<string, LogBodyValue>;
	responses?: Array<Record<string, LogBodyValue>>;
	content?: ActionLogContent;
	result?: ActionLogResult;
	isVoidReturn?: boolean;
	prompts?: ActionLogPrompt[];
	promptCount?: number;
	planStep?: string;
	planThought?: string;
}

/**
 * Log body for evaluator logs
 */
export interface EvaluatorLogBody extends BaseLogBody {
	base?: BaseLogBody;
	evaluator?: string;
	message?: string;
	state?: Record<string, LogBodyValue>;
}

/**
 * Action context for model logs
 */
export interface ModelActionContext {
	actionName: string;
	actionId: string;
}

/**
 * Log body for model logs
 */
export interface ModelLogBody extends BaseLogBody {
	base?: BaseLogBody;
	modelType?: string;
	modelKey?: string;
	prompt?: string;
	systemPrompt?: string;
	provider?: string;
	params?: Record<string, LogBodyValue>;
	actionContext?: ModelActionContext;
	timestamp?: number | bigint;
	executionTime?: number | bigint;
	response?: JsonValue;
}

/**
 * Log body for embedding logs
 */
export interface EmbeddingLogBody extends BaseLogBody {
	base?: BaseLogBody;
	memoryId?: UUID;
	duration?: number | bigint;
	error?: string | Error;
}

/**
 * Union type for all possible log body types
 */
export type LogBody =
	| BaseLogBody
	| ActionLogBody
	| EvaluatorLogBody
	| ModelLogBody
	| EmbeddingLogBody;

/**
 * Represents a log entry
 */
export interface Log {
	id?: UUID;
	type: string;
	entityId: UUID;
	roomId?: UUID;
	body: LogBody;
	createdAt: Date;
}

export type RunStatus = "started" | "completed" | "timeout" | "error";

/**
 * JSON Patch operation for atomic component data updates.
 *
 * WHY: Enables race-free partial updates to component JSONB data without
 * read-modify-write cycles. All operations are applied in a single UPDATE
 * statement using dialect-specific JSONB functions.
 *
 * OPERATIONS:
 * - set: Set a value at path (creates path if missing)
 * - push: Append value to array at path (errors if not array)
 * - remove: Delete the key/index at path (idempotent if missing)
 * - increment: Add numeric value to number at path (errors if not number)
 *
 * PATH FORMAT:
 * - Dot-separated: "wallet.balance" or "positions.0.open"
 * - Only alphanumeric, underscore, and numeric array indices allowed
 * - Validated with regex to prevent SQL injection
 */
export interface PatchOp {
	/** Operation type */
	op: "set" | "push" | "remove" | "increment";
	/**
	 * Dot-separated path to the field (e.g., "wallet.balance", "items.0.name")
	 * Validated against /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\d+)*$/
	 */
	path: string;
	/**
	 * Value for the operation
	 * - Required for: set, push, increment
	 * - Ignored for: remove
	 */
	value?: unknown;
}

/** Participant room state for batch get/update (getParticipantUserStates, updateParticipantUserStates). */
export type ParticipantUserState = "FOLLOWED" | "MUTED" | null;

/** Fields that can be updated on a participant (Participant + DB-only roomState/metadata). */
export type ParticipantUpdateFields = Partial<Participant> & {
	roomState?: ParticipantUserState;
	metadata?: Record<string, unknown>;
};

/** Result of getEntitiesForRooms: one entry per requested roomId, same order. */
export type EntitiesForRoomsResult = Array<{
	roomId: UUID;
	entities: Entity[];
}>;

/** Result of getParticipantsForRooms: one entry per requested roomId, same order. */
export type ParticipantsForRoomsResult = Array<{
	roomId: UUID;
	entityIds: UUID[];
}>;

/** Result of getPairingRequests batch: one entry per (channel, agentId) query, same order. */
export type PairingRequestsResult = Array<{
	channel: PairingChannel;
	agentId: UUID;
	requests: PairingRequest[];
	/** Present when the corresponding query requested a bounded page. */
	pageInfo?: PairingPageInfo;
}>;

/** Result of getPairingAllowlists batch: one entry per (channel, agentId) query, same order. */
export type PairingAllowlistsResult = Array<{
	channel: PairingChannel;
	agentId: UUID;
	entries: PairingAllowlistEntry[];
	/** Present when the corresponding query requested a bounded page. */
	pageInfo?: PairingPageInfo;
}>;

export type ConnectorAccountJsonObject = { [key: string]: JsonValue };

export type ConnectorAccountStorageStatus = string;

export type ConnectorAccountAuditOutcome = "success" | "failure";

export interface ConnectorAccountRecord {
	id: UUID;
	agentId: UUID;
	provider: string;
	accountKey: string;
	externalId?: string | null;
	displayName?: string | null;
	username?: string | null;
	email?: string | null;
	ownerBindingId?: string | null;
	ownerIdentityId?: string | null;
	role: string;
	purpose: string[];
	accessGate: string;
	status: ConnectorAccountStorageStatus;
	scopes: string[];
	capabilities: string[];
	profile: ConnectorAccountJsonObject;
	metadata: ConnectorAccountJsonObject;
	connectedAt: number;
	lastSyncAt?: number | null;
	deletedAt?: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ListConnectorAccountsParams {
	agentId?: UUID;
	provider?: string;
	status?: ConnectorAccountStorageStatus;
	limit?: number;
	offset?: number;
}

export interface GetConnectorAccountParams {
	id?: UUID;
	agentId?: UUID;
	provider?: string;
	accountKey?: string;
}

export interface UpsertConnectorAccountParams {
	id?: UUID;
	agentId?: UUID;
	provider: string;
	accountKey: string;
	externalId?: string | null;
	displayName?: string | null;
	username?: string | null;
	email?: string | null;
	ownerBindingId?: string | null;
	ownerIdentityId?: string | null;
	role?: string;
	purpose?: string[];
	accessGate?: string;
	status?: ConnectorAccountStorageStatus;
	scopes?: string[];
	capabilities?: string[];
	profile?: ConnectorAccountJsonObject;
	metadata?: ConnectorAccountJsonObject;
	connectedAt?: number | Date;
	lastSyncAt?: number | Date | null;
	deletedAt?: number | Date | null;
}

export interface DeleteConnectorAccountParams {
	id?: UUID;
	agentId?: UUID;
	provider?: string;
	accountKey?: string;
}

export interface ConnectorAccountCredentialRefRecord {
	id: UUID;
	accountId: UUID;
	agentId: UUID;
	provider: string;
	credentialType: string;
	vaultRef: string;
	metadata: ConnectorAccountJsonObject;
	expiresAt?: number | null;
	lastVerifiedAt?: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface SetConnectorAccountCredentialRefParams {
	accountId: UUID;
	credentialType: string;
	vaultRef: string;
	metadata?: ConnectorAccountJsonObject;
	expiresAt?: number | Date | null;
	lastVerifiedAt?: number | Date | null;
}

export interface GetConnectorAccountCredentialRefParams {
	accountId: UUID;
	credentialType: string;
}

export interface ListConnectorAccountCredentialRefsParams {
	accountId: UUID;
}

export interface DeleteConnectorAccountCredentialRefsParams {
	accountId: UUID;
}

export interface ConnectorAccountAuditEventRecord {
	id: UUID;
	accountId?: UUID | null;
	agentId: UUID;
	provider: string;
	actorId?: string | null;
	action: string;
	outcome: ConnectorAccountAuditOutcome;
	metadata: ConnectorAccountJsonObject;
	createdAt: number;
}

export interface AppendConnectorAccountAuditEventParams {
	accountId?: UUID | null;
	agentId?: UUID;
	provider?: string;
	actorId?: string | null;
	action: string;
	outcome?: ConnectorAccountAuditOutcome;
	metadata?: Record<string, unknown>;
	createdAt?: number | Date;
}

export interface OAuthFlowRecord {
	stateHash: string;
	agentId: UUID;
	provider: string;
	accountId?: UUID | null;
	redirectUri?: string | null;
	codeVerifierRef?: string | null;
	scopes: string[];
	metadata: ConnectorAccountJsonObject;
	createdAt: number;
	expiresAt: number;
	consumedAt?: number | null;
	consumedBy?: string | null;
}

export interface CreateOAuthFlowStateParams {
	state: string;
	agentId?: UUID;
	provider: string;
	accountId?: UUID | null;
	redirectUri?: string | null;
	codeVerifierRef?: string | null;
	scopes?: string[];
	metadata?: ConnectorAccountJsonObject;
	ttlMs?: number;
	expiresAt?: number | Date;
}

export interface ConsumeOAuthFlowStateParams {
	state: string;
	agentId?: UUID;
	provider?: string;
	consumedBy?: string;
	now?: number | Date;
}

export interface GetOAuthFlowStateParams {
	state?: string;
	stateHash?: string;
	flowId?: string;
	agentId?: UUID;
	provider?: string;
	includeConsumed?: boolean;
	includeExpired?: boolean;
	now?: number | Date;
}

export interface UpdateOAuthFlowStateParams {
	state?: string;
	stateHash?: string;
	flowId?: string;
	agentId?: UUID;
	provider?: string;
	accountId?: UUID | null;
	redirectUri?: string | null;
	codeVerifierRef?: string | null;
	scopes?: string[];
	metadata?: ConnectorAccountJsonObject;
	expiresAt?: number | Date;
	consumedAt?: number | Date | null;
	consumedBy?: string | null;
}

export interface DeleteOAuthFlowStateParams {
	state?: string;
	stateHash?: string;
	flowId?: string;
	agentId?: UUID;
	provider?: string;
}

export interface AgentRunCounts {
	actions: number;
	modelCalls: number;
	errors: number;
	evaluators: number;
}

export interface AgentRunSummary {
	runId: string;
	status: RunStatus | DbRunStatus;
	startedAt: number | bigint | null;
	endedAt: number | bigint | null;
	durationMs: number | bigint | null;
	messageId?: string;
	roomId?: string;
	entityId?: string;
	metadata?: Record<string, JsonValue>;
	counts?: AgentRunCounts;
}

export interface AgentRunSummaryResult {
	runs: AgentRunSummary[];
	total: number;
	hasMore: boolean;
}

/**
 * Interface for database operations.
 *
 * **Design: Batch-First CRUD**
 *
 * All create/read-by-ID/update/delete methods accept and return arrays.
 * This is intentional and non-negotiable for adapter implementations.
 *
 * WHY: elizaOS agents process events that frequently touch multiple DB rows
 * in a single tick -- load entity + room, store memory + log, clean up tasks.
 * Under the old single-item API, each was a separate round-trip. At scale
 * (multiple agents, concurrent conversations), this saturated connection pools
 * and made network latency the bottleneck. Batch methods let SQL adapters use
 * `IN (...)` clauses, multi-row inserts, and transactions -- actual DB-level
 * batching instead of application-level loops.
 *
 * Single-item convenience wrappers (e.g. `getAgent(id)`) live on `AgentRuntime`
 * and `IAgentRuntime`, NOT here. They delegate to batch methods internally.
 * This keeps the adapter contract simple: implement batch, get single-item free.
 *
 * **Query methods** (complex filter params, not ID lookups) remain singular because
 * batching `searchMemories` would mean "run N different searches" -- a fundamentally
 * different operation than "look up N items by their IDs."
 *
 * See DATABASE_BATCH_API.md for the full design rationale and migration guide.
 */
export interface IDatabaseAdapter<DB extends object = object> {
	/** Database instance */
	db: DB;

	/**
	 * Initialize database connection
	 *
	 * WHY: Async initialization allows:
	 * - Connection pooling setup
	 * - Schema validation and migrations
	 * - SSL/TLS handshake completion
	 * - Adapter-specific configuration (RLS policies, extensions, etc.)
	 *
	 * @param config Optional adapter-specific configuration
	 */
	initialize(
		config?: Record<string, string | number | boolean | null>,
	): Promise<void>;

	/**
	 * Run plugin schema migrations for all registered plugins
	 * @param plugins Array of plugins with their schemas
	 * @param options Migration options (verbose, force, dryRun, etc.)
	 */
	runPluginMigrations?(
		plugins: Array<{
			name: string;
			schema?: Record<string, JsonValue | object>;
		}>,
		options?: {
			verbose?: boolean;
			force?: boolean;
			dryRun?: boolean;
		},
	): Promise<void>;

	/**
	 * Run database migrations from migration files
	 * @param migrationsPaths Optional array of migration file paths
	 */
	runMigrations?(migrationsPaths?: string[]): Promise<void>;

	/** Check if the database connection is ready */
	isReady(): Promise<boolean>;

	/** Close database connection */
	close(): Promise<void>;

	getConnection(): Promise<DB>;

	/**
	 * Execute a callback with full isolation context (Server RLS + Entity RLS).
	 *
	 * WHY: PostgreSQL Row Level Security requires setting session variables before
	 * queries. This method sets the entity (and optionally server) context and
	 * executes the callback within that context.
	 *
	 * WHY unknown context parameter: Different backends provide different context
	 * types (Drizzle transaction for SQL, nothing for in-memory). Callers that
	 * need the context can cast `ctx` to the appropriate type.
	 *
	 * @param entityId - The entity ID to set as context (null clears context)
	 * @param callback - Function to execute within isolation context
	 * @returns The result of the callback
	 */
	withIsolationContext?<T>(
		entityId: UUID | null,
		callback: (ctx: unknown) => Promise<T>,
	): Promise<T>;

	/** Get all agents */
	getAgents(): Promise<Partial<Agent>[]>;

	// ── Agent CRUD (batch-only) ──────────────────────────────────────────
	// WHY batch-only: agent lifecycle operations (create on boot, update
	// settings, bulk cleanup) benefit from single-query multi-row SQL.
	// Single-item wrappers live on AgentRuntime.
	getAgentsByIds(agentIds: UUID[]): Promise<Agent[]>;
	createAgents(agents: Partial<Agent>[]): Promise<UUID[]>;
	updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean>;
	deleteAgents(agentIds: UUID[]): Promise<boolean>;

	/**
	 * Upsert agents (insert or update by ID)
	 *
	 * WHY: Atomic insert-or-update eliminates the get-check-create race condition
	 * in `ensureAgentExists`. Single SQL statement is safer and faster.
	 *
	 * WHY on adapter interface: PostgreSQL and MySQL can perform this atomically
	 * (ON CONFLICT / ON DUPLICATE KEY), so it belongs on the adapter. InMemory
	 * simulates with has()/set(), which is acceptable.
	 *
	 * WHY void return: Upserts don't create new IDs - the caller already has them.
	 * Returning UUID[] suggests creation, which is misleading for updates.
	 *
	 * IMPLEMENTATION NOTES:
	 * - PostgreSQL: INSERT ... ON CONFLICT (id) DO UPDATE SET ...
	 * - MySQL: INSERT ... ON DUPLICATE KEY UPDATE ...
	 * - InMemory: map.has(id) ? map.set(id, merged) : map.set(id, agent)
	 *
	 * @param agents Agents to upsert (ID is required for each)
	 */
	upsertAgents(agents: Partial<Agent>[]): Promise<void>;

	/**
	 * Count total number of agents in the database
	 *
	 * WHY: Useful for admin dashboards, monitoring, and quota checks.
	 * Simple count query that doesn't fetch full agent records.
	 *
	 * @returns Total count of agents
	 */
	countAgents(): Promise<number>;

	/**
	 * Remove agents that haven't been active recently
	 *
	 * WHY: Cleanup stale agents for multi-tenant systems or dev environments
	 * where agents are created for testing and then abandoned. Prevents
	 * database bloat from accumulating test/demo agents.
	 *
	 * IMPLEMENTATION NOTE: Deletion criteria varies by adapter. SQL adapters
	 * typically use updatedAt < 30 days ago. InMemory adapters may do nothing.
	 */
	cleanupAgents(): Promise<void>;

	ensureEmbeddingDimension(dimension: number): Promise<void>;

	/**
	 * Delete every stored embedding whose vector width does not match the
	 * currently-active embedding dimension, returning the ids of the memories
	 * left without a vector so the runtime can re-embed them at the active width.
	 * The store side of switching embedders (e.g. cloud 1536-dim → on-device
	 * gte-small 384-dim); a no-op returning `[]` once every vector matches. In-
	 * memory adapters, whose vectors are not schema-bound, may return `[]`.
	 */
	clearEmbeddingsOutsideActiveDimension(): Promise<UUID[]>;

	/**
	 * Execute a callback within a database transaction.
	 *
	 * WHY: Enables cross-method atomicity. Each batch method (createEntities,
	 * upsertComponents, etc.) is already internally atomic. transaction() is for
	 * when you need multiple methods to succeed or fail together.
	 *
	 * EXAMPLE: Create entity + its components atomically:
	 * ```
	 * await adapter.transaction(async (tx) => {
	 *   await tx.createEntities([entity]);
	 *   await tx.createComponents(components);
	 * });
	 * ```
	 *
	 * IMPLEMENTATION:
	 * - SQL adapters: Use Drizzle's transaction() with prototype proxy pattern
	 * - InMemory: Executes callback directly (NOT atomic - see warning below)
	 *
	 * TRAP - InMemory non-atomicity: The InMemory adapter does NOT provide true
	 * transaction semantics. If step 2 fails, step 1's changes are NOT rolled back.
	 * This is acceptable for dev/test but NOT for production critical paths.
	 *
	 * @param callback Function that receives a transactional adapter proxy
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), runs callback under RLS for this entity.
	 *        WHY optional: System paths (migrations, boot, admin) run without a user entity; required would break them.
	 * @returns Promise resolving to callback's return value
	 * @throws Error if any operation in the callback fails (SQL: rolls back, InMemory: does NOT)
	 */
	transaction<T>(
		callback: (tx: IDatabaseAdapter<DB>) => Promise<T>,
		options?: { entityContext?: UUID },
	): Promise<T>;

	/** Get entities for multiple rooms (one entry per roomId, same order). */
	getEntitiesForRooms(
		roomIds: UUID[],
		includeComponents?: boolean,
	): Promise<EntitiesForRoomsResult>;

	/** Create new entities */
	createEntities(entities: Entity[]): Promise<UUID[]>;

	/**
	 * Upsert entities (insert or update by ID)
	 *
	 * WHY: Atomic insert-or-update eliminates race conditions in `ensureEntityExists`.
	 * Entities may be created concurrently from multiple sources (client plugins,
	 * RPC handlers, background jobs). Atomic upsert prevents duplicates.
	 *
	 * WHY on adapter interface: All SQL dialects support atomic upserts, so this
	 * belongs on the adapter, not as runtime-level get-then-create orchestration.
	 *
	 * WHY void return: Caller already has the entity IDs. Upserts don't generate
	 * new IDs - they're idempotent operations where the ID is the lookup key.
	 *
	 * IMPLEMENTATION NOTES:
	 * - PostgreSQL: INSERT ... ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ...
	 * - MySQL: INSERT ... ON DUPLICATE KEY UPDATE name = VALUES(name), ...
	 * - InMemory: entities.set(id, merged)
	 * - Conflict resolution: Last write wins (update all fields from input)
	 *
	 * @param entities Entities to upsert (ID, agentId, name required)
	 */
	upsertEntities(entities: Entity[]): Promise<void>;

	/**
	 * Search entities by name substring match
	 *
	 * WHY: Enables autocomplete/search UIs for entity mentions (e.g., "@user"
	 * in Discord, entity picker in admin dashboards). Case-insensitive substring
	 * search across all entity names.
	 *
	 * WHY on adapter interface: SQL adapters use ILIKE/LOWER() with GIN indexes
	 * on the names array. InMemory adapters iterate and filter. This search
	 * pattern is common enough to warrant a dedicated method.
	 *
	 * PERFORMANCE:
	 * - PostgreSQL: Uses GIN index on names array + ILIKE for case-insensitive
	 * - MySQL: Uses JSON_TABLE + LIKE (slower, no ideal index)
	 * - InMemory: O(N) scan with substring match
	 *
	 * @param params.query Substring to search for (case-insensitive)
	 * @param params.agentId Scope search to this agent's entities
	 * @param params.limit Max results (default: 10)
	 * @returns Matching entities, ordered by relevance (exact matches first)
	 */
	searchEntitiesByName(params: {
		query: string;
		agentId: UUID;
		limit?: number;
	}): Promise<Entity[]>;

	/**
	 * Get entities by exact name match
	 *
	 * WHY: Batch lookup for entities by their display names. Used when importing
	 * data from external systems where entities are identified by name, not UUID.
	 *
	 * WHY batch: When syncing a channel with 50 participants, we need to resolve
	 * all their names to entity IDs in one query, not 50 separate queries.
	 *
	 * IMPLEMENTATION NOTE: Matches ANY name in the entity's names array (entities
	 * can have aliases/nicknames). Case-sensitive exact match.
	 *
	 * @param params.names Array of names to look up
	 * @param params.agentId Scope to this agent's entities
	 * @returns Entities with matching names (may return fewer than names.length)
	 */
	getEntitiesByNames(params: {
		names: string[];
		agentId: UUID;
	}): Promise<Entity[]>;

	/**
	 * Query entities by component properties (type and/or data filter)
	 *
	 * WHY: Eliminates multi-hop fetch patterns like "get all user IDs → getEntitiesByIds →
	 * filter for ACCOUNT components → extract wallet data". Collapses 3+ queries into one
	 * database-optimized query with JSONB containment filtering.
	 *
	 * This is the highest-impact API addition, replacing patterns like:
	 * - int_accounts.ts: "get accounts by pubkey" (240 lines → 10 lines)
	 * - int_users.ts: "get users by type" (chained ID resolution)
	 * - int_spartan.ts: master registry becomes unnecessary
	 *
	 * TWO-QUERY APPROACH (critical for correctness):
	 * 1. Query 1: SELECT DISTINCT entity_id FROM components WHERE ... LIMIT N
	 * 2. Query 2: SELECT entities.*, components.* WHERE entity_id IN (...)
	 *
	 * WHY two queries: A single SELECT DISTINCT ... JOIN ... LIMIT can return fewer
	 * than LIMIT entities if entities have multiple components (DISTINCT dedupes AFTER
	 * LIMIT). Two queries ensures LIMIT applies to entity count, not row count.
	 *
	 * JSONB CONTAINMENT (@> operator):
	 * - {"wallet": {"chain": "solana"}} @> {"wallet": {"chain": "solana"}} ✓
	 * - {"tags": ["admin","user"]} @> {"tags": ["admin"]} ✓ (containment, not equality)
	 * - Exploits GIN index on components.data for O(log N) performance
	 *
	 * FILTER VALIDATION:
	 * - If no componentType, no componentDataFilter, no entityIds: MUST throw unless limit set
	 * - Prevents accidental full table scans from queryEntities({})
	 *
	 * @param params.componentType Filter by component type (e.g., "ACCOUNT", "WALLET")
	 * @param params.componentDataFilter JSONB containment filter on component.data
	 * @param params.agentId Scope query to agent's entities
	 * @param params.entityIds Explicit list of entity IDs to filter
	 * @param params.worldId Filter by world context
	 * @param params.limit Non-negative safe-integer maximum (applies to distinct entities, not rows)
	 * @param params.offset Non-negative safe-integer count to skip for pagination
	 * @param params.includeAllComponents If false (default): return only matched component type.
	 *                                     If true: return all components for matched entities.
	 * @returns Entities with their components (filtered by includeAllComponents)
	 */
	queryEntities(params: {
		componentType?: string;
		componentDataFilter?: Record<string, unknown>;
		agentId?: UUID;
		entityIds?: UUID[];
		worldId?: UUID;
		limit?: number;
		offset?: number;
		includeAllComponents?: boolean; // default false
		/** RLS only: when set (Postgres + ENABLE_DATA_ISOLATION), query runs under this entity context. Not a filter (WHY: RLS is connection-level; stores do not take entityContext). */
		entityContext?: UUID;
	}): Promise<Entity[]>;

	/** Get components by natural keys (entityId, type, worldId?, sourceEntityId?). Same order as keys; null where not found. */
	getComponentsByNaturalKeys(
		keys: Array<{
			entityId: UUID;
			type: string;
			worldId?: UUID;
			sourceEntityId?: UUID;
		}>,
	): Promise<(Component | null)[]>;

	/** Get all components for multiple entities. Flat list (components have entityId). */
	getComponentsForEntities(
		entityIds: UUID[],
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]>;

	// ── Entity CRUD (batch-only) ─────────────────────────────────────────
	// WHY batch-only: event handlers routinely resolve multiple entities at
	// once (e.g. all participants in a room). IN-clause reads and
	// transactional updates eliminate per-entity round-trips.
	getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]>;
	updateEntities(entities: Entity[]): Promise<void>;
	deleteEntities(entityIds: UUID[]): Promise<void>;

	// ── Component CRUD (batch-only) ────────────────────────────────────
	// WHY batch-only: components are often loaded/saved in groups (all
	// components for an entity, or all components of a type across a world).
	// getComponent() and getComponents() are query methods (kept singular)
	// because they filter by entityId+type, not by component ID.
	createComponents(components: Component[]): Promise<UUID[]>;
	getComponentsByIds(componentIds: UUID[]): Promise<Component[]>;
	updateComponents(components: Component[]): Promise<void>;
	deleteComponents(componentIds: UUID[]): Promise<void>;

	/**
	 * Upsert components (insert or update by natural key)
	 *
	 * WHY: Completes the upsert pattern established by upsertAgents, upsertEntities,
	 * upsertWorlds, upsertRooms. Components have a composite natural key of
	 * (entityId, type, worldId, sourceEntityId). Atomic upsert eliminates race
	 * conditions when multiple code paths try to ensure a component exists.
	 *
	 * WHY natural key, not ID: The caller knows the component's semantic identity
	 * (which entity, which type, which world context) but may not know if a
	 * component with those properties already exists. The database enforces
	 * uniqueness via the unique_component_natural_key constraint.
	 *
	 * CONFLICT RESOLUTION:
	 * - On conflict: UPDATE data, agentId, roomId (mutable state)
	 * - Do NOT update: id, entityId, type, worldId, sourceEntityId (identity)
	 * - Do NOT update: createdAt (preserve original timestamp)
	 *
	 * IMPLEMENTATION NOTES:
	 * - PostgreSQL: INSERT ... ON CONFLICT (entity_id, type, world_id, source_entity_id)
	 *   DO UPDATE SET data = EXCLUDED.data, ...
	 *   Requires unique_component_natural_key constraint with NULLS NOT DISTINCT
	 * - MySQL: INSERT ... ON DUPLICATE KEY UPDATE data = VALUES(data), ...
	 *   Requires UNIQUE KEY on (entity_id, type, world_id, source_entity_id)
	 * - InMemory: Find by natural key, update if found, insert if not
	 *
	 * TRAP: If input contains duplicate natural keys, dedupe first (last-wins).
	 * PostgreSQL will error: "ON CONFLICT DO UPDATE command cannot affect row a second time"
	 *
	 * @param components Components to upsert (id, entityId, type, data required)
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), upsert runs under RLS for this entity.
	 */
	upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void>;

	/**
	 * Batch patch components (JSON Patch ops per component). Run in a transaction; all commit or all roll back.
	 * @param updates Array of { componentId, ops }
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), patch runs under RLS for this entity.
	 */
	patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void>;

	/**
	 * Get memories matching criteria
	 *
	 * WHY metadata parameter: Eliminates the "fetch 50K rows, filter in JS" antipattern
	 * seen in the legacy knowledge implementation. Database-level JSON filtering is 50-100x faster:
	 * - PostgreSQL: Uses GIN-indexed @> operator on jsonb columns
	 * - MySQL: Uses JSON_CONTAINS() function
	 * - InMemory: Deep equality check (less efficient but correct)
	 *
	 * WHY limit/offset: Standard pagination naming (limit = max results, offset = skip N).
	 *
	 * @param params.metadata Filter by metadata fields (partial object match)
	 * @param params.limit Max results to return
	 * @param params.offset Skip first N results for pagination
	 * @param params.cursor Exclusive keyset cursor in the requested order. When
	 * provided, results start strictly after `(createdAt, id)` and `offset` must
	 * not be used. This keeps multi-query scans stable when earlier rows mutate.
	 * @param params.tableName Memory type/table (required)
	 */
	getMemories(params: {
		entityId?: UUID;
		/** Restrict returned rows by author while `entityId` remains the RLS principal. */
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
		/** Exclude internal rooms before ordering and LIMIT are applied. */
		excludeRoomIds?: UUID[];
		worldId?: UUID;
		metadata?: Record<string, unknown>;
		/**
		 * Case-insensitive keyword predicate over `Memory.content.text`. SQL
		 * adapters push this into the database (`ILIKE`); in-memory adapters apply
		 * the same `includes` semantics. Used by keyword message search so the
		 * filter runs in the store, not by scanning every room in the process.
		 */
		textContains?: string;
		/**
		 * Order by column (currently only 'createdAt' supported for security).
		 * Whitelisted to prevent SQL injection. Default behavior: ORDER BY created_at DESC.
		 */
		orderBy?: "createdAt";
		/**
		 * Order direction. Default: 'desc' (newest first, current hardcoded behavior).
		 */
		orderDirection?: "asc" | "desc";
		/**
		 * When `false`, the adapter may skip fetching the embedding vector for
		 * each memory (list/browse callers that discard embeddings). Defaults to
		 * `true` — embeddings included — to preserve existing behavior. Adapters
		 * that don't support the optimization simply ignore it and return
		 * embeddings as before.
		 */
		includeEmbedding?: boolean;
		/**
		 * Requester authority used to intersect disclosure scope and any supplied
		 * world/authorized-room bounds before ordering and pagination. When omitted,
		 * no access-context filtering is applied (single-tenant behavior).
		 */
		accessContext?: AccessContext;
	}): Promise<Memory[]>;

	/**
	 * Required native document-store contract. Version 4 covers canonical
	 * visibility for list/lookup/search plus atomic revision replacement. Adapter
	 * authors migrating from version 2 must implement all six methods; there is
	 * deliberately no bounded compatibility scan because it cannot preserve
	 * authorization, counts, or pagination guarantees.
	 */
	readonly documentListQueryCapability: 4;
	/** Native source projection with optional caller-requested pagination. */
	readonly documentRangeReadCapability?: 1;
	queryDocuments(
		params: DocumentListQueryParams,
	): Promise<DocumentListQueryResult>;
	getDocument(params: DocumentGetQueryParams): Promise<Memory | null>;
	readDocumentRange?(
		params: DocumentRangeReadParams,
	): Promise<DocumentRangeReadResult | null>;
	queryDocumentFragments(
		params: DocumentFragmentQueryParams,
	): Promise<Memory[]>;
	compareAndSwapDocument(
		params: DocumentCompareAndSwapParams,
	): Promise<DocumentMutationResult>;
	updateDocumentDirectGrants(
		params: DocumentDirectGrantUpdateParams,
	): Promise<DocumentMutationResult>;
	replaceDocumentRevision(
		params: DocumentRevisionReplaceParams,
	): Promise<DocumentMutationResult>;
	deleteDocumentWithSnapshot(
		params: DocumentDeleteParams,
	): Promise<DocumentMutationResult>;

	/**
	 * Atomic compare-and-swap replacement of a world's whole metadata under the
	 * exact prior snapshot, committing the audit row in the same transaction
	 * (#23100 role-write atomicity). Authorization role writes MUST go through
	 * this operation and fail closed when an adapter omits the optional
	 * capability; they never fall back to a blind `updateWorlds` overwrite.
	 */
	compareAndSwapWorldMetadata?(
		params: WorldMetadataCompareAndSwapParams,
	): Promise<WorldMetadataMutationResult>;

	getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]>;

	/**
	 * Full-text + trigram message search across a set of rooms, ranked
	 * corpus-wide (not truncated by recency before ranking). SQL adapters run a
	 * GIN-indexed Postgres FTS query (`websearch_to_tsquery` + `ts_rank_cd`) with
	 * a `pg_trgm` fallback for partial/typo/code/URL tokens; in-memory adapters
	 * apply the same folded-token semantics in JS. Rows come back ranked:
	 * `ftsRank` desc, then `trigramSimilarity` desc, then recency, so multi-word
	 * non-adjacent queries and hits older than any recency window are both found
	 * and correctly ordered (#13534).
	 */
	searchMessages(params: {
		roomIds: UUID[];
		query: string;
		tableName?: string;
		limit?: number;
		offset?: number;
		/**
		 * Inclusive lower bound on `Memory.createdAt` (epoch ms). Applied in the
		 * store together with the match predicate, before ranking and LIMIT/OFFSET,
		 * so a time window never truncates recall ("messages from a year ago").
		 */
		since?: number;
		/** Inclusive upper bound on `Memory.createdAt` (epoch ms). */
		until?: number;
		accessContext?: AccessContext;
	}): Promise<MessageSearchHit[]>;

	getMemoriesByRoomIds(params: {
		tableName: string;
		roomIds: UUID[];
		limit?: number;
		/**
		 * Skip the first N matching results. Applied after room-scoping and the
		 * `textContains` filter so the LIMIT/OFFSET window is taken over the
		 * already-filtered, ordered result set. Used for paginated keyword search.
		 */
		offset?: number;
		/**
		 * Case-insensitive keyword predicate over `Memory.content.text`. SQL
		 * adapters push this into the database (`ILIKE`); in-memory adapters apply
		 * the same `includes` semantics. Lets keyword message search scope to a set
		 * of accessible rooms AND filter by keyword in a single store query, so the
		 * LIMIT is applied after access-scoping rather than across every room.
		 */
		textContains?: string;
		includeEmbedding?: boolean;
		/**
		 * Requester authority used to intersect disclosure scope and any supplied
		 * world/authorized-room bounds before ordering and pagination. When omitted,
		 * no access-context filtering is applied (single-tenant behavior).
		 */
		accessContext?: AccessContext;
	}): Promise<Memory[]>;

	getCachedEmbeddings(params: {
		query_table_name: string;
		query_threshold: number;
		query_input: string;
		query_field_name: string;
		query_field_sub_name: string;
		query_match_count: number;
	}): Promise<{ embedding: number[]; levenshtein_score: number }[]>;

	getLogs(params: {
		entityId?: UUID;
		roomId?: UUID;
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<Log[]>;

	// ── Log CRUD (batch-only) ────────────────────────────────────────────
	// WHY batch-only: a single agent turn can produce multiple log entries
	// (model call, action execution, evaluator run). Batching avoids N
	// inserts for N log entries per turn. Named createLogs (not "logBatch")
	// for consistency with the create{Domain}s convention.
	createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void>;

	/**
	 * Get logs by their IDs
	 *
	 * WHY: Batch lookup for specific log entries. Used when rendering agent
	 * run history or debugging specific interactions (e.g., "show me all logs
	 * from this conversation turn").
	 *
	 * @param logIds Array of log IDs to fetch
	 * @returns Array of logs (only found logs returned, no nulls)
	 */
	getLogsByIds(logIds: UUID[]): Promise<Log[]>;

	/**
	 * Update logs (batch)
	 *
	 * WHY: Agent run summaries update log status/metadata after completion.
	 * Logs aren't truly immutable - their status field changes as runs progress
	 * (pending → running → completed → failed).
	 *
	 * WHY batch: When an agent run completes, it updates status for all logs
	 * in that run (model call log, action logs, evaluator logs).
	 *
	 * @param logs Array of {id, updates} where updates is a partial Log
	 */
	updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void>;

	deleteLogs(logIds: UUID[]): Promise<void>;

	getAgentRunSummaries?(params: {
		limit?: number;
		roomId?: UUID;
		status?: RunStatus | "all";
		from?: number;
		to?: number;
		entityId?: UUID;
	}): Promise<AgentRunSummaryResult>;

	searchMemories(params: {
		embedding: number[];
		match_threshold?: number;
		count?: number;
		limit?: number;
		offset?: number;
		unique?: boolean;
		tableName: string;
		query?: string;
		roomId?: UUID;
		worldId?: UUID;
		entityId?: UUID;
		/**
		 * Requester authority used to intersect disclosure scope and any supplied
		 * world/authorized-room bounds before vector ranking and pagination. When
		 * omitted, no access-context filtering is applied (single-tenant behavior).
		 */
		accessContext?: AccessContext;
	}): Promise<Memory[]>;

	// ── Memory CRUD (batch-only) ─────────────────────────────────────────
	// WHY batch-only: memory ingestion (e.g. bulk import of conversation
	// history, knowledge base seeding) creates many memories at once.
	// Even single-message flows benefit: the runtime's createMemory()
	// wrapper handles secret redaction then delegates here.
	/**
	 * Batch create memories
	 *
	 * WHY UUID[] return: Returns the IDs of created memories, enabling immediate
	 * follow-up operations (e.g., linking to external systems, creating relationships).
	 * Changed from boolean return which was ambiguous (false = failed OR already exists?).
	 *
	 * @returns Array of created memory IDs (in same order as input)
	 */
	createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]>;
	/**
	 * Batch update memories
	 *
	 * WHY void return: Updates should throw on failure (fail-fast principle).
	 * Changed from boolean[] which created ambiguity about whether to continue
	 * processing after a failed update. Now failures are exceptional, not expected.
	 *
	 * WHY batch: SQL adapters use CASE expressions for single UPDATE statement:
	 *   UPDATE memories SET content = CASE
	 *     WHEN id = $1 THEN $2
	 *     WHEN id = $3 THEN $4
	 *     ...
	 *   WHERE id IN ($1, $3, ...)
	 *
	 * @throws Error if any update fails (transaction rolls back)
	 */
	updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void>;
	deleteMemories(memoryIds: UUID[]): Promise<void>;

	/**
	 * Upsert memories (insert or update by ID)
	 *
	 * WHY: Completes the upsert pattern. Unlike createMemories (which uses ON CONFLICT
	 * DO NOTHING to skip duplicates), upsertMemories uses ON CONFLICT DO UPDATE to
	 * overwrite existing memories. Used for bulk data refresh or re-import scenarios.
	 *
	 * CONFLICT RESOLUTION:
	 * - Updates: content, metadata, unique (mutable data)
	 * - Preserves: id, type, entityId, roomId, worldId, agentId, createdAt (identity)
	 *
	 * NO SIMILARITY CHECK: Unlike createMemories, this does NOT run embedding similarity
	 * checks. The caller is asserting "I know this memory's ID, insert or replace."
	 * This is intentional - upsert is for known-identity updates, not duplicate detection.
	 *
	 * EMBEDDING HANDLING: If a memory includes an embedding, the embeddings table row
	 * is also upserted (ON CONFLICT on memory_id). This keeps embeddings in sync.
	 *
	 * @param memories Array of {memory, tableName} to upsert (memory.id required)
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), upsert runs under RLS for this entity.
	 */
	upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void>;

	deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void>;

	/**
	 * Count memories matching criteria.
	 * Use roomIds for room scope (pass [roomId] for a single room).
	 */
	countMemories(params: {
		roomIds?: UUID[];
		unique?: boolean;
		tableName?: string;
		entityId?: UUID;
		agentId?: UUID;
		metadata?: Record<string, unknown>;
	}): Promise<number>;

	getAllWorlds(): Promise<World[]>;

	// ── World CRUD (batch-only) ──────────────────────────────────────────
	// WHY batch-only: world lifecycle is analogous to agents -- created on
	// boot, updated in bulk during sync, cleaned up together.
	getWorldsByIds(worldIds: UUID[]): Promise<World[]>;
	createWorlds(worlds: World[]): Promise<UUID[]>;
	deleteWorlds(worldIds: UUID[]): Promise<void>;
	updateWorlds(worlds: World[]): Promise<void>;

	/**
	 * Upsert worlds (insert or update by ID)
	 *
	 * WHY: Atomic insert-or-update for world initialization. Worlds are created
	 * during agent basic-capabilities or plugin initialization. Concurrent initialization
	 * attempts should be idempotent, not fail with "already exists" errors.
	 *
	 * WHY on adapter interface: SQL dialects support atomic upserts for worlds.
	 * The world table has minimal fields (id, name, type, agentId), making upserts
	 * straightforward across all dialects.
	 *
	 * WHY void return: World IDs are provided by the caller (often deterministic
	 * UUIDs based on world name/type). No need to return IDs.
	 *
	 * IMPLEMENTATION NOTES:
	 * - PostgreSQL: INSERT ... ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ...
	 * - MySQL: INSERT ... ON DUPLICATE KEY UPDATE name = VALUES(name), ...
	 * - InMemory: worlds.set(id, world)
	 *
	 * @param worlds Worlds to upsert (ID required for each)
	 */
	upsertWorlds(worlds: World[]): Promise<void>;

	getRoomsByIds(roomIds: UUID[]): Promise<Room[]>;

	createRooms(rooms: Room[]): Promise<UUID[]>;

	deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void>;

	/**
	 * Get room IDs where entities are participants.
	 * @param entityIds Array of entity UUIDs
	 * @returns Array of room IDs where any of the entities participate
	 */
	getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]>;

	/** Get rooms for multiple worlds. Limit/offset apply globally across all worlds. */
	getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]>;

	// ── Room CRUD (batch-only) ───────────────────────────────────────────
	// WHY batch-only: room cleanup (e.g. deleteRoomsByWorldId) and bulk
	// sync from external platforms naturally produce batches.
	// getRoomsByIds returns Room[] (never null) -- an empty array means
	// "none found", which is the correct semantics for batch reads.
	updateRooms(rooms: Room[]): Promise<void>;
	deleteRooms(roomIds: UUID[]): Promise<void>;

	/**
	 * Upsert rooms (insert or update by ID)
	 *
	 * WHY: Atomic insert-or-update for room management. Rooms are created during
	 * `ensureConnection` or when syncing external platforms (Discord, Telegram).
	 * Concurrent connection attempts should be idempotent.
	 *
	 * WHY on adapter interface: SQL dialects support atomic room upserts. Rooms
	 * have more fields than worlds (name, type, worldId, metadata, etc.) but
	 * upsert is still straightforward.
	 *
	 * WHY void return: Room IDs are provided by caller. For DM rooms, the ID
	 * is often deterministic (hash of participant IDs). No need to return IDs.
	 *
	 * IMPLEMENTATION NOTES:
	 * - PostgreSQL: INSERT ... ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, ...
	 * - MySQL: INSERT ... ON DUPLICATE KEY UPDATE name = VALUES(name), ...
	 * - InMemory: rooms.set(id, room)
	 * - Partial updates: Full replacement (all fields updated)
	 *
	 * @param rooms Rooms to upsert (ID, worldId, agentId required for each)
	 */
	upsertRooms(rooms: Room[]): Promise<void>;

	getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]>;

	/** Get participants for multiple rooms (one entry per roomId, same order). */
	getParticipantsForRooms(roomIds: UUID[]): Promise<ParticipantsForRoomsResult>;

	areRoomParticipants(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<boolean[]>;

	/**
	 * Create room participants (add entities to a room)
	 *
	 * WHY renamed from addRoomParticipants: 'create' prefix aligns with CRUD
	 * naming convention (create = insert, update = modify, delete = remove).
	 *
	 * WHY UUID[] return: Returns participant record IDs (changed from boolean).
	 * Useful for tracking who joined when, managing invites, etc.
	 *
	 * WHY ON CONFLICT DO NOTHING: Idempotent - calling twice with same entities
	 * doesn't fail, just skips duplicates. This is intentional for invite flows.
	 *
	 * @returns Array of created participant record IDs
	 */
	createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]>;

	// ── Participant CRUD (batch-only for mutations) ─────────────────────
	// WHY batch-only: createRoomParticipants accepts an array of entity IDs
	// (adding multiple users to a channel is common). deleteParticipants
	// accepts {entityId, roomId} pairs for flexibility -- you might remove
	// different entities from different rooms in one call.
	deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean>;

	/**
	 * Update participants (batch)
	 *
	 * WHY: Participants have fields beyond roomState (e.g., lastSeenAt, metadata).
	 * This method provides general-purpose participant updates, while
	 * updateParticipantUserState is a specialized convenience for the common
	 * case of updating notification preferences.
	 *
	 * WHY composite key: Participant table's primary key is (entityId, roomId, agentId).
	 * Updates must specify all key fields, not just a single UUID.
	 *
	 * USAGE NOTE: For updating notification state (FOLLOWED/MUTED), prefer
	 * updateParticipantUserState() which has simpler signature.
	 *
	 * @param participants Array of participant updates with composite keys
	 */
	updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: ParticipantUpdateFields;
		}>,
	): Promise<void>;

	getParticipantUserStates(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<ParticipantUserState[]>;

	updateParticipantUserStates(
		updates: Array<{
			roomId: UUID;
			entityId: UUID;
			state: ParticipantUserState;
		}>,
	): Promise<void>;

	/** Get relationships by (source, target) pairs. Same order as pairs; null where not found. */
	getRelationshipsByPairs(
		pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]>;

	/**
	 * Retrieves all relationships for entities. Use entityIds (pass [entityId] for a single entity).
	 */
	getRelationships(params: {
		entityIds?: UUID[];
		tags?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Relationship[]>;

	// ── Relationship CRUD (batch-only) ──────────────────────────────────
	// WHY batch-only: relationship graphs can be synced in bulk (e.g.
	// importing a social graph from an external platform). The singular
	// getRelationship() and getRelationships() are query methods -- they
	// filter by (sourceEntityId, targetEntityId) or (entityId, tags),
	// not by relationship ID.
	createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]>;
	getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]>;
	updateRelationships(relationships: Relationship[]): Promise<void>;
	deleteRelationships(relationshipIds: UUID[]): Promise<void>;

	// ── Cache CRUD (batch-only) ──────────────────────────────────────────
	// WHY batch-only: providers often need multiple cache keys in a single
	// render cycle (e.g. checking rate limits, feature flags, user prefs).
	// getCaches returns a Map so callers can look up individual keys without
	// losing the batch benefit.
	getCaches<T>(keys: string[]): Promise<Map<string, T>>;
	setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean>;
	deleteCaches(keys: string[]): Promise<boolean>;

	// Only task instance methods - definitions are in-memory
	/**
	 * Get tasks matching criteria
	 *
	 * WHY limit/offset added: Previously returned ALL matching tasks, which could
	 * be thousands of records. Task queues grow unbounded over time, causing:
	 * - Memory exhaustion when loading full queue
	 * - Slow queries without limits
	 * - UI freeze when rendering thousands of tasks
	 *
	 * @param params.limit Max results (default: unlimited, use with caution)
	 * @param params.offset Skip first N results for pagination
	 */
	getTasks(params: {
		roomId?: UUID;
		worldId?: UUID;
		tags?: string[];
		entityId?: UUID;
		/** Required. Only tasks with agentId in this array are returned. Single agent = [id]. WHY: multi-tenant safety; schema indexes by agent_id; daemon batches one getTasks(agentIds) for many agents. */
		agentIds: UUID[];
		limit?: number;
		offset?: number;
	}): Promise<Task[]>;
	getTasksByName(name: string): Promise<Task[]>;

	// ── Task CRUD (batch-only) ───────────────────────────────────────────
	// WHY batch-only: task scheduling creates/updates tasks in bursts
	// (e.g. all recurring tasks on agent boot). getTasks() and
	// getTasksByName() are query methods (filter by room, tags, name).
	createTasks(tasks: Task[]): Promise<UUID[]>;
	getTasksByIds(taskIds: UUID[]): Promise<Task[]>;
	/**
	 * Atomically updates a queued task only while its lifecycle status is
	 * pending (or absent for legacy rows). The queue tag and status predicate
	 * are evaluated by storage in the same mutation that applies `task`.
	 */
	updatePendingTask?(id: UUID, task: Partial<Task>): Promise<boolean>;
	updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void>;
	deleteTasks(taskIds: UUID[]): Promise<void>;

	getMemoriesByWorldId(params: {
		worldIds?: UUID[];
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]>;

	// Pairing methods for secure DM access control

	/** Get pairing requests for multiple (channel, agentId) queries. One entry per query, same order. */
	getPairingRequests(
		queries: PairingRequestQuery[],
	): Promise<PairingRequestsResult>;

	// ── Pairing request CRUD (batch-only) ────────────────────────────────
	createPairingRequests(requests: PairingRequest[]): Promise<UUID[]>;
	updatePairingRequests(requests: PairingRequest[]): Promise<void>;
	deletePairingRequests(ids: UUID[]): Promise<void>;

	/** Get pairing allowlists for multiple (channel, agentId) queries. One entry per query, same order. */
	getPairingAllowlists(
		queries: PairingAllowlistQuery[],
	): Promise<PairingAllowlistsResult>;

	// ── Pairing allowlist CRUD (batch-only) ──────────────────────────────
	// WHY batch-only: allowlist management (admin adding/removing multiple
	// users) is naturally a batch operation.
	createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]>;

	/**
	 * Update pairing allowlist entries (batch)
	 *
	 * WHY: Allowlist entries have metadata/config that changes over time
	 * (e.g., expiration dates, permission levels, notes). Batch updates
	 * are needed when admin adjusts settings for multiple users at once.
	 *
	 * @param entries Full PairingAllowlistEntry objects (ID required for each)
	 */
	updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void>;

	deletePairingAllowlistEntries(ids: UUID[]): Promise<void>;

	// ── Connector account storage ────────────────────────────────────────
	listConnectorAccounts(
		params?: ListConnectorAccountsParams,
	): Promise<ConnectorAccountRecord[]>;
	getConnectorAccount(
		params: GetConnectorAccountParams,
	): Promise<ConnectorAccountRecord | null>;
	upsertConnectorAccount(
		params: UpsertConnectorAccountParams,
	): Promise<ConnectorAccountRecord>;
	deleteConnectorAccount(
		params: DeleteConnectorAccountParams,
	): Promise<boolean>;
	findConnectorOwnerBinding?(params: {
		connector: string;
		externalId: string;
		instanceId?: string;
	}): Promise<{
		id: string;
		identityId: string;
		connector: string;
		externalId: string;
		displayHandle: string;
		instanceId: string;
		verifiedAt: number;
	} | null>;
	setConnectorAccountCredentialRef(
		params: SetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord>;
	getConnectorAccountCredentialRef(
		params: GetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord | null>;
	listConnectorAccountCredentialRefs(
		params: ListConnectorAccountCredentialRefsParams,
	): Promise<ConnectorAccountCredentialRefRecord[]>;
	deleteConnectorAccountCredentialRefs(
		params: DeleteConnectorAccountCredentialRefsParams,
	): Promise<number>;
	/**
	 * Append a connector account audit event. Implementations must redact
	 * credential-like metadata values before persistence.
	 */
	appendConnectorAccountAuditEvent(
		params: AppendConnectorAccountAuditEventParams,
	): Promise<ConnectorAccountAuditEventRecord>;
	createOAuthFlowState(
		params: CreateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord>;
	consumeOAuthFlowState(
		params: ConsumeOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null>;
	getOAuthFlowState(
		params: GetOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null>;
	updateOAuthFlowState(
		params: UpdateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null>;
	deleteOAuthFlowState(params: DeleteOAuthFlowStateParams): Promise<boolean>;

	// ── Plugin Schema Registration ──────────────────────────────────────────
	// WHY: Plugins need custom tables (goals, todos) but shouldn't cast runtime.db
	// to Drizzle types. This provides a generic, adapter-agnostic way for plugins
	// to register schemas and access data.

	/**
	 * Register a plugin's schema (tables, columns, indexes)
	 *
	 * WHY: Plugins like goals and todos need custom tables. Without this, they
	 * must cast runtime.db to Drizzle, which only works with SQL adapters.
	 *
	 * IDEMPOTENT: Safe to call multiple times (e.g., on hot reload). The adapter
	 * should check if tables exist and only create/migrate what's needed.
	 *
	 * MIGRATIONS: If a plugin updates its schema (adds columns, indexes), the
	 * adapter should diff against the current schema and apply changes. For SQL
	 * adapters, this uses ALTER TABLE. For in-memory, this records
	 * the schema definition.
	 *
	 * @param schema Complete schema definition for the plugin
	 * @throws Error if schema is invalid or migration fails
	 */
	registerPluginSchema?(
		schema: import("./plugin-store").PluginSchema,
	): Promise<void>;

	/**
	 * Get a plugin store for CRUD operations on plugin tables
	 *
	 * WHY: Provides a generic interface for plugins to access their data without
	 * knowing whether they're running on SQL or in-memory adapters.
	 *
	 * NAMESPACING: The store automatically prefixes table names with the plugin
	 * name to avoid conflicts (e.g., "goals_goals", "goals_goal_tags").
	 *
	 * @param pluginName Name of the plugin (must match registered schema)
	 * @returns Plugin store interface, or null if adapter doesn't support plugins
	 *
	 * @example
	 * ```typescript
	 * // In plugin code:
	 * const store = runtime.getPluginStore('goals');
	 * if (!store) throw new Error('Plugin storage not available');
	 *
	 * const goals = await store.query<Goal>('goals', {
	 *   agentId: runtime.agentId,
	 *   isCompleted: false
	 * });
	 * ```
	 */
	getPluginStore?(
		pluginName: string,
	): import("./plugin-store").IPluginStore | null;
}

/**
 * Result interface for embedding similarity searches
 */
export interface EmbeddingSearchResult {
	embedding: number[];
	levenshtein_score?: number;
}

/** Base shape for memory retrieval options (string IDs before UUID substitution) */
interface MemoryRetrievalOptionsBase {
	roomId?: string;
	agentId?: string;
	start?: number;
	end?: number;
	limit?: number;
	unique?: boolean;
	tableName?: string;
}

/**
 * Options for memory retrieval operations
 */
export interface MemoryRetrievalOptions
	extends Omit<
		MemoryRetrievalOptionsBase,
		"roomId" | "agentId" | "start" | "end"
	> {
	roomId: UUID;
	agentId?: UUID;
	start?: number | bigint;
	end?: number | bigint;
}

/** Base shape for memory search options */
interface MemorySearchOptionsBase {
	roomId?: string;
	agentId?: string;
	metadata?: unknown;
	matchThreshold?: number;
	limit?: number;
	tableName?: string;
}

/**
 * Options for memory search operations
 */
export interface MemorySearchOptions
	extends Omit<
		MemorySearchOptionsBase,
		"roomId" | "agentId" | "metadata" | "matchThreshold"
	> {
	roomId: UUID;
	agentId?: UUID;
	metadata?: Partial<MemoryMetadata>;
	match_threshold?: number;
}

/** Base shape for multi-room memory options */
interface MultiRoomMemoryOptionsBase {
	roomIds?: string[];
	agentId?: string;
	limit?: number;
	tableName?: string;
}

/**
 * Options for multi-room memory retrieval
 */
export interface MultiRoomMemoryOptions
	extends Omit<MultiRoomMemoryOptionsBase, "roomIds" | "agentId"> {
	roomIds: UUID[];
	agentId?: UUID;
}

/**
 * Standard options pattern for memory operations
 * Provides a simpler, more consistent interface
 */
export interface StandardMemoryOptions {
	roomId: UUID;
	limit?: number; // Standard naming (replacing 'count')
	agentId?: UUID; // Common optional parameter
	unique?: boolean; // Common flag for duplication control
	start?: number; // Pagination start
	end?: number; // Pagination end
}

/**
 * Specialized memory search options
 */
export interface MemorySearchParams extends StandardMemoryOptions {
	embedding: number[];
	similarity?: number; // Clearer name than 'match_threshold'
}

/**
 * Base interface for database connection objects.
 * Specific adapters should extend this with their connection type.
 *
 * @example
 * ```typescript
 * // In a PostgreSQL adapter:
 * interface PgConnection extends DbConnection {
 *   pool: Pool;
 *   query: <T>(sql: string, params?: unknown[]) => Promise<T>;
 * }
 * ```
 */
export interface DbConnection {
	/** Whether the connection is currently active */
	isConnected?: boolean;
	/** Close the connection */
	close?: () => Promise<void>;
}

// Allowable vector dimensions
export const VECTOR_DIMS = {
	SMALL: 384,
	MEDIUM: 512,
	LARGE: 768,
	XL: 1024,
	XXL: 1536,
	XXXL: 3072,
} as const;
