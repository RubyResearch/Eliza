/**
 * Persists managed-agent lifecycle, warm-pool, and backup records through the
 * shared database boundary. Warm-pool capacity and claim operations share one
 * eligibility predicate so scheduling never counts a row it cannot transfer.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  SnapshotPayloadTooLargeError,
} from "@elizaos/shared/agent-backup-limits";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { QUOTA_COUNTED_STATUSES } from "../../lib/constants/agent-sandbox-quota";
import {
  applyBackupDelta,
  type BackupChainNode,
  computeStateHash,
  requireBackupDelta,
  requireBackupStateData,
  selectPrunableBackupIds,
} from "../../lib/services/agent-backup-diff";
import { AGENT_MANAGED_DISCORD_KEY } from "../../lib/services/eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
  elizaTryProvisionAdvisoryLockSql,
} from "../../lib/services/eliza-provision-lock";
import {
  readOrganizationQuotaPolicyInTransaction,
  requireOrganizationResourceLimit,
} from "../../lib/services/organization-quota-policy";
import {
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  PROVISIONING_RECONCILIATION_BATCH_SIZE,
  PROVISIONING_STATUS_OWNER_JOB_TYPES,
  type ProvisioningJobType,
} from "../../lib/services/provisioning-job-types";
import { mergeWarmClaimEnvironmentVars } from "../../lib/services/warm-claim-character-push";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import {
  deleteLegacyObject,
  getObjectText,
  offloadJsonField,
} from "../../lib/storage/object-store";
import { logger } from "../../lib/utils/logger";
import type { Database, DbTransaction } from "../client";
import { decryptAgentBackupStateData, encryptAgentBackupStateData } from "../crypto/agent-backups";
import { ensureAgentSandboxSchema } from "../ensure-agent-sandbox-schema";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import {
  type AgentBackupSnapshotType,
  type AgentBackupStateData,
  type AgentBackupStoredStateData,
  type AgentExecutionTier,
  type AgentSandbox,
  type AgentSandboxBackup,
  type AgentSandboxStatus,
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  type NewAgentSandbox,
  type NewAgentSandboxBackup,
  type StoredAgentSandboxBackup,
  UPGRADE_FAILURE_TARGET_MARKER_PREFIX,
  WARM_POOL_ORG_ID,
  WARM_POOL_USER_ID,
} from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { jobs } from "../schemas/jobs";
import {
  imageRepo,
  imageRepoSql,
  isDigestPinnedImageSql,
  pinnedImageDigestSql,
} from "../utils/docker-image-ref";
import { lockOrganizationPolicy } from "./organization-policy-generation";

export type {
  AgentBackupSnapshotType,
  AgentSandbox,
  AgentSandboxBackup,
  AgentSandboxStatus,
  NewAgentSandbox,
  NewAgentSandboxBackup,
};

const CANONICAL_SHA256_IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Lightweight legacy-list projection. Catalogue-v2 fields are intentionally
 * read through the dedicated catalogue repository so this path never grows
 * into a second authority or accidentally selects inline backup payloads.
 */
export type AgentSandboxBackupMetadata = Pick<
  StoredAgentSandboxBackup,
  | "id"
  | "sandbox_record_id"
  | "snapshot_type"
  | "state_data_storage"
  | "state_data_key"
  | "size_bytes"
  | "backup_kind"
  | "parent_backup_id"
  | "content_hash"
  | "verification_status"
  | "verified_at"
  | "verification_error"
  | "recovery_organization_id"
  | "recovery_agent_id"
  | "recovery_deletion_attempt_id"
  | "recovery_expires_at"
  | "created_at"
>;

/**
 * A user sandbox row freshly claimed from the warm pool. `warm_pool_row_id`
 * is the id of the pool row the claim transaction deleted — the container's
 * boot-time inference key is named `agent-sandbox:<that id>`, so the
 * post-claim re-key needs it to revoke the pool-org credential; it exists
 * nowhere else once the pool row is gone (#17066 review).
 */
export type WarmClaimedAgentSandbox = AgentSandbox & { warm_pool_row_id: string };

/**
 * Identifies the exact container generation observed by a warm-pool
 * reconciler. Heartbeats intentionally do not participate: they update
 * liveness timestamps without changing the container generation.
 */
export type WarmPoolRuntimeGeneration = Pick<
  AgentSandbox,
  | "id"
  | "organization_id"
  | "status"
  | "environment_revision"
  | "sandbox_id"
  | "node_id"
  | "container_name"
  | "bridge_url"
  | "health_url"
  | "docker_image"
  | "image_digest"
  | "pool_ready_at"
>;

/**
 * Exact row authority captured before a stopped restore prepares its backup.
 * Provisioning may begin only if every captured lifecycle discriminator still
 * matches the tenant row when the admission UPDATE executes.
 */
export type ProvisioningAdmissionCapture = Pick<
  AgentSandbox,
  | "id"
  | "organization_id"
  | "status"
  | "lifecycle_job_id"
  | "lifecycle_execution_generation"
  | "execution_tier"
  | "pool_status"
  | "deleted_at"
  | "deletion_attempt_id"
  | "lifecycle_revision"
>;

/**
 * Exact container generation that a stuck-provisioning reconciler actually
 * probed. The final write must compare every field that selects the provider
 * handle, plus the database-owned lifecycle/environment authorities.
 */
export type ProvisioningRecoveryCapture = Pick<
  AgentSandbox,
  | "id"
  | "organization_id"
  | "status"
  | "execution_tier"
  | "sandbox_id"
  | "node_id"
  | "container_name"
  | "bridge_url"
  | "health_url"
  | "headscale_ip"
  | "environment_revision"
  | "lifecycle_revision"
  | "lifecycle_job_id"
  | "lifecycle_execution_generation"
  | "pool_status"
  | "deleted_at"
  | "deletion_attempt_id"
>;

/** Exact row generation whose bridge was probed by disconnected recovery. */
export type DisconnectedRecoveryCapture = ProvisioningRecoveryCapture &
  Pick<AgentSandbox, "previous_image_digest" | "error_message">;

/** Ingress repair committed atomically with a successful reconnect CAS. */
export interface RepairedDisconnectedIngress {
  headscaleIp: string;
  bridgeUrl: string;
  healthUrl: string;
  errorCount?: number;
}

/**
 * Every execution tier intentionally supported by the single-agent runtime
 * lookup. Keep the literals here instead of deriving "not shared" or spreading
 * a container-only list: a future tier must be reviewed before it can route.
 */
const RUNNING_SANDBOX_EXECUTION_TIERS = [
  "shared",
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const satisfies readonly AgentExecutionTier[];

const RESTORE_PROVISIONING_ADMISSIBLE_STATUSES = [
  "stopped",
  "sleeping",
  "disconnected",
  "error",
] as const satisfies readonly AgentSandboxStatus[];

export interface WarmPoolReconciliationCandidate {
  sandbox: AgentSandbox;
  canPromote: boolean;
}

const EMPTY_BACKUP_STATE: AgentSandboxBackup["state_data"] = {
  memories: [],
  config: {},
  workspaceFiles: {},
};
const MAX_RECONSTRUCTED_BACKUP_CHAIN_DEPTH = 100;
/**
 * A reconstructed chain has to fit the same v1 restorable ceiling as any other
 * backup wire payload — it is what gets handed to restore (#17172).
 */
const MAX_RECONSTRUCTED_BACKUP_CHAIN_BYTES = MAX_RESTORABLE_AGENT_BACKUP_BYTES;

/**
 * V2 catalogue operations are always invisible to legacy restore/list paths:
 * their inline state is only a schema placeholder and the real payload lives
 * in authenticated chunk objects. Only the dedicated v2 restore pipeline may
 * consume them, even after provider verification.
 */
function backupVisibleToLegacyReaders(): SQL {
  return or(
    isNull(agentSandboxBackups.catalog_state),
    eq(agentSandboxBackups.catalog_state, "legacy_unmigrated"),
  ) as SQL;
}

/** Successful agent deletes retain one final recovery point for 30 days. */
export const PRE_DELETE_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRE_DELETE_BACKUP_CLEANUP_BATCH_SIZE = 100;

export interface PreDeleteBackupCleanupResult {
  deletedRows: number;
  deletedObjects: number;
  /** Rows retained for a later retry after a transient cleanup failure. */
  failedRows: number;
  /** Malformed rows discarded under the terminal invalid-row policy. */
  invalidRows: number;
}

/**
 * Correlates a sandbox row with the queue operations that legitimately own its
 * `provisioning` state. Drizzle binds every type/status value as a parameter;
 * the repository never assembles executable SQL from job-type strings.
 */
function hasNoProvisioningOwnerJob(ownerJobTypes: readonly ProvisioningJobType[]): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${jobs}
    WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
    AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
    AND    ${inArray(jobs.type, [...ownerJobTypes])}
    AND    (
      ${inArray(jobs.status, ["pending", "in_progress"])}
      OR (
        ${jobs.execution_generation} IS NOT NULL
        AND ${jobs.execution_quiesced_at} IS NULL
      )
    )
  )`;
}

function hasNoProvisioningStatusOwnerJob(): SQL {
  return hasNoProvisioningOwnerJob([...PROVISIONING_STATUS_OWNER_JOB_TYPES]);
}

/**
 * Runtime fields every capacity reader and claimant requires. Keeping this as
 * one SQL fragment prevents a row from counting as capacity on one path while
 * another path refuses to claim it.
 */
function warmPoolRuntimeLocatorConditions(): SQL[] {
  return [
    sql`${agentSandboxes.sandbox_id} IS NOT NULL AND btrim(${agentSandboxes.sandbox_id}) <> ''`,
    sql`${agentSandboxes.node_id} IS NOT NULL AND btrim(${agentSandboxes.node_id}) <> ''`,
    sql`${agentSandboxes.container_name} IS NOT NULL AND btrim(${agentSandboxes.container_name}) <> ''`,
    sql`${agentSandboxes.bridge_url} IS NOT NULL AND btrim(${agentSandboxes.bridge_url}) <> ''`,
    sql`${agentSandboxes.health_url} IS NOT NULL AND btrim(${agentSandboxes.health_url}) <> ''`,
    sql`${agentSandboxes.docker_image} IS NOT NULL AND btrim(${agentSandboxes.docker_image}) <> ''`,
    sql`${agentSandboxes.image_digest} ~ '^sha256:[0-9a-f]{64}$'`,
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    isNull(agentSandboxes.replacement_cleanup_sandbox_id),
  ];
}

function warmPoolRuntimeReadyConditions(): SQL[] {
  return [isNotNull(agentSandboxes.pool_ready_at), ...warmPoolRuntimeLocatorConditions()];
}

export interface WarmPoolImageFilter {
  image?: string;
  digest?: string;
}

function claimableWarmPoolConditions(filter: WarmPoolImageFilter = {}): SQL[] {
  const conditions: SQL[] = [
    eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
    eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
    eq(agentSandboxes.pool_status, "unclaimed"),
    eq(agentSandboxes.status, "running"),
    ...warmPoolRuntimeReadyConditions(),
  ];
  if (filter.image !== undefined) {
    conditions.push(eq(agentSandboxes.docker_image, filter.image));
  }
  if (filter.digest !== undefined) {
    conditions.push(eq(agentSandboxes.image_digest, filter.digest));
  }
  return conditions;
}

function inFlightWarmPoolConditions(filter: WarmPoolImageFilter = {}): SQL[] {
  const conditions: SQL[] = [
    eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
    eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
    eq(agentSandboxes.pool_status, "unclaimed"),
    inArray(agentSandboxes.status, ["pending", "provisioning"]),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    sql`${agentSandboxes.docker_image} IS NOT NULL AND btrim(${agentSandboxes.docker_image}) <> ''`,
  ];
  if (filter.image !== undefined) {
    conditions.push(eq(agentSandboxes.docker_image, filter.image));
  }
  if (filter.digest !== undefined) {
    conditions.push(eq(agentSandboxes.image_digest, filter.digest));
  }
  return conditions;
}

function warmPoolGenerationConditions(expected: WarmPoolRuntimeGeneration): SQL[] {
  return [
    eq(agentSandboxes.id, expected.id),
    eq(agentSandboxes.organization_id, expected.organization_id),
    eq(agentSandboxes.status, expected.status),
    eq(agentSandboxes.environment_revision, expected.environment_revision),
    sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${expected.sandbox_id}`,
    sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${expected.node_id}`,
    sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${expected.container_name}`,
    sql`${agentSandboxes.bridge_url} IS NOT DISTINCT FROM ${expected.bridge_url}`,
    sql`${agentSandboxes.health_url} IS NOT DISTINCT FROM ${expected.health_url}`,
    sql`${agentSandboxes.docker_image} IS NOT DISTINCT FROM ${expected.docker_image}`,
    sql`${agentSandboxes.image_digest} IS NOT DISTINCT FROM ${expected.image_digest}`,
    sql`${agentSandboxes.pool_ready_at} IS NOT DISTINCT FROM ${expected.pool_ready_at}`,
  ];
}

/** Keep generic and restore-fenced provisioning transitions byte-equivalent. */
function provisioningAdmissionUpdatePayload() {
  const permanentProvisionFailure = sql`${agentSandboxes.status} = 'error' AND ${agentSandboxes.error_message} LIKE 'Provisioning permanently failed%'`;
  // Stop retains the retired locator while the agent is off. Once explicit
  // provisioning is admitted, keeping that node would count the new
  // `provisioning` row against its own freed slot before placement can run.
  // Recovery data stays on the row; unresolved and sleeping generations keep
  // their existing handle semantics.
  const retiredPlacement = sql`${agentSandboxes.status} = 'stopped' OR (${permanentProvisionFailure})`;
  return {
    status: "provisioning" as const,
    updated_at: new Date(),
    error_message: null,
    sandbox_id: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.sandbox_id} END`,
    bridge_url: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.bridge_url} END`,
    health_url: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.health_url} END`,
    node_id: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.node_id} END`,
    container_name: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.container_name} END`,
    bridge_port: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.bridge_port} END`,
    web_ui_port: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.web_ui_port} END`,
    headscale_ip: sql`CASE WHEN ${retiredPlacement} THEN NULL ELSE ${agentSandboxes.headscale_ip} END`,
  };
}

export interface ReconciliationBatchResult<T> {
  updated: T[];
  deferred: number;
}

async function getStoredBackupById(
  backupId: string,
  database: Database = dbWrite,
): Promise<StoredAgentSandboxBackup | undefined> {
  const [row] = await database
    .select()
    .from(agentSandboxBackups)
    .where(and(eq(agentSandboxBackups.id, backupId), backupVisibleToLegacyReaders()))
    .limit(1);
  return row;
}

async function backupOrganizationId(sandboxRecordId: string): Promise<string> {
  const [sandbox] = await dbWrite
    .select({ organizationId: agentSandboxes.organization_id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, sandboxRecordId))
    .limit(1);
  if (!sandbox) throw new Error(`Agent sandbox not found: ${sandboxRecordId}`);
  return sandbox.organizationId;
}

export async function hydrateAgentSandboxBackup(
  backup: StoredAgentSandboxBackup,
): Promise<AgentSandboxBackup> {
  let stateData = backup.state_data;
  if (backup.state_data_storage === "r2") {
    if (!backup.state_data_key) {
      throw new Error(`Agent sandbox backup ${backup.id} is missing state_data_key`);
    }

    const raw = await getObjectText(backup.state_data_key);
    if (!raw) {
      throw new Error(`Agent sandbox backup payload not found: ${backup.state_data_key}`);
    }

    stateData = JSON.parse(raw) as AgentBackupStoredStateData;
  }

  const decrypted = await decryptAgentBackupStateData(backup.id, stateData);

  return {
    ...backup,
    state_data: decrypted,
  };
}

/**
 * Reconstruct an already-authorized target→base chain from the exact captured
 * rows. Every intermediate state is checked against its persisted digest, so
 * an altered parent payload cannot be masked by a later incremental delta.
 */
export async function reconstructStoredAgentSandboxBackupChain(
  capturedTargetToBase: readonly StoredAgentSandboxBackup[],
): Promise<{ state: AgentBackupStateData; target: AgentSandboxBackup }> {
  if (capturedTargetToBase.length === 0) throw new Error("Backup chain is empty");
  let chainBytes = 0;
  let state: AgentBackupStateData | undefined;
  let target: AgentSandboxBackup | undefined;
  for (const stored of [...capturedTargetToBase].reverse()) {
    chainBytes += stored.size_bytes ?? Buffer.byteLength(JSON.stringify(stored.state_data), "utf8");
    if (chainBytes > MAX_RECONSTRUCTED_BACKUP_CHAIN_BYTES) {
      throw new SnapshotPayloadTooLargeError(chainBytes, MAX_RECONSTRUCTED_BACKUP_CHAIN_BYTES);
    }
    const hydrated = await hydrateAgentSandboxBackup(stored);
    if (stored.id === capturedTargetToBase[0]?.id) target = hydrated;
    if (hydrated.backup_kind === "full") {
      state = requireBackupStateData(hydrated.state_data, hydrated.id);
    } else {
      if (!state) throw new Error(`Incremental ${hydrated.id} reached before a full backup`);
      state = applyBackupDelta(state, requireBackupDelta(hydrated.state_data, hydrated.id));
    }
    if (!hydrated.content_hash || computeStateHash(state) !== hydrated.content_hash) {
      throw new Error(
        `Backup ${hydrated.id} content digest does not match its reconstructed state`,
      );
    }
  }
  if (!state || !target) throw new Error("Backup chain did not produce a restorable state");
  return { state, target };
}

export async function prepareAgentBackupInsertData(
  data: NewAgentSandboxBackup,
  organizationId?: string,
): Promise<NewAgentSandboxBackup> {
  if (data.state_data_storage === "r2") return data;

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const effectiveOrganizationId =
    organizationId ?? (await backupOrganizationId(data.sandbox_record_id));
  const encryptedStateData = await encryptAgentBackupStateData(
    effectiveOrganizationId,
    id,
    data.state_data,
  );
  const stateData = await offloadJsonField<AgentBackupStoredStateData>({
    namespace: ObjectNamespaces.AgentSandboxBackups,
    organizationId: effectiveOrganizationId,
    objectId: id,
    field: "state_data",
    createdAt,
    value: encryptedStateData,
    inlineValueWhenOffloaded: EMPTY_BACKUP_STATE,
  });

  return {
    ...data,
    id,
    created_at: createdAt,
    state_data: stateData.value ?? EMPTY_BACKUP_STATE,
    state_data_storage: stateData.storage,
    state_data_key: stateData.key,
  };
}

/**
 * Outcome of spending a deletion generation's allocation ownership.
 *
 * Three-valued on purpose. A boolean conflates the benign expected case
 * (`not-owned` — the retry path this feature exists to make safe) with a real
 * accounting bug (`counter-unchanged` — ownership was ours, but the node
 * counter did not move), and an operator reading `released: false` could not
 * tell which they were looking at.
 */
export type DeletionAllocationRelease = "released" | "not-owned" | "counter-unchanged";

export interface DeletionAllocationSpendResult {
  outcome: DeletionAllocationRelease;
  /** Post-trigger row generation when this call consumed ownership. */
  lifecycleRevision: number | null;
}

/** Existing metered rows retain their population slot; terminal recovery requires a new one. */
async function assertProvisionQuota(
  tx: DbTransaction,
  id: string,
  organizationId?: string,
  eligibility?: SQL,
): Promise<void> {
  const [identity] = await tx
    .select({ organizationId: agentSandboxes.organization_id })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, id),
        organizationId ? eq(agentSandboxes.organization_id, organizationId) : undefined,
      ),
    );
  if (!identity) return;
  // Organization deletion takes the organization lock before cascading to agents.
  // Resolve identity without locking, then revalidate it after the same lock order.
  await lockOrganizationPolicy(tx, identity.organizationId);
  const [candidate] = await tx
    .select({
      id: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      status: agentSandboxes.status,
      scope: agentSandboxes.quota_admission_scope,
      poolStatus: agentSandboxes.pool_status,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, id),
        eq(agentSandboxes.organization_id, identity.organizationId),
        eligibility,
      ),
    )
    .for("update");
  if (!candidate || candidate.scope === "trusted_internal" || candidate.poolStatus === "unclaimed")
    return;
  const policy = await readOrganizationQuotaPolicyInTransaction(tx, candidate.organizationId);
  // Historical legacy starts were not quota re-admissions. Preserve that contract;
  // subscription starts require current authority even for unclassified history.
  if (policy.authority.source === "legacy") return;
  const ceiling = requireOrganizationResourceLimit(policy, "sandboxes");
  const [population] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, candidate.organizationId),
        isNull(agentSandboxes.pool_status),
        inArray(agentSandboxes.status, QUOTA_COUNTED_STATUSES),
      ),
    );
  if (!population)
    throw new ElizaError("Sandbox population is unavailable", {
      code: "RESOURCE_POLICY_UNAVAILABLE",
    });
  const required =
    BigInt(population.count) + (QUOTA_COUNTED_STATUSES.includes(candidate.status) ? 0n : 1n);
  if (required > ceiling)
    throw new ElizaError("Organization sandbox quota prevents provisioning", {
      code: "SANDBOX_QUOTA_EXCEEDED",
      context: {
        organizationId: candidate.organizationId,
        required: required.toString(),
        ceiling: ceiling.toString(),
      },
    });
}

export class AgentSandboxesRepository {
  // Reads

  async findById(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, id))
      .limit(1);
    return r;
  }

  async findOrganizationIdById(id: string): Promise<string | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select({ organizationId: agentSandboxes.organization_id })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, id))
      .limit(1);
    return r?.organizationId;
  }

  /** Distinguishes a completed user shutdown from a recoverable billing stop. */
  async wasStoppedByUser(id: string, orgId: string): Promise<boolean> {
    const [latest] = await dbWrite
      .select({ authorization: agentComputeStopIntents.authorization })
      .from(agentComputeStopIntents)
      .where(
        and(
          eq(agentComputeStopIntents.agent_id, id),
          eq(agentComputeStopIntents.organization_id, orgId),
          eq(agentComputeStopIntents.status, "provider_confirmed"),
          isNotNull(agentComputeStopIntents.provider_confirmed_at),
        ),
      )
      .orderBy(
        desc(agentComputeStopIntents.provider_confirmed_at),
        desc(agentComputeStopIntents.id),
      )
      .limit(1);
    return latest?.authorization === "user_request";
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async findByIdAndOrgForWrite(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async listByOrganization(orgId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.organization_id, orgId))
      .orderBy(desc(agentSandboxes.created_at));
  }

  async findBySandboxId(sandboxId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.sandbox_id, sandboxId))
      .limit(1);
    return r;
  }

  /** Primary-authority lookup for destructive teardown identity. */
  async findBySandboxIdForWrite(sandboxId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.sandbox_id, sandboxId))
      .limit(1);
    return r;
  }

  async findLatestByCharacterId(characterId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.character_id, characterId))
      .orderBy(desc(agentSandboxes.updated_at))
      .limit(1);
    return r;
  }

  /** List active (non-terminal) sandboxes on a specific docker node. */
  async listByNodeId(nodeId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const terminalStatuses: AgentSandboxStatus[] = ["stopped", "error"];
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.node_id, nodeId),
          notInArray(agentSandboxes.status, terminalStatuses),
        ),
      );
  }

  /**
   * Running sandboxes the heartbeat cycle should dial. Excludes the `shared`
   * execution tier: those run container-free in the hosted shared runtime
   * (node_id / container_name are NULL by design), so there is nothing to
   * dial over the Headscale tunnel — heartbeating them only ever fails and
   * spams the logs. Only dedicated/custom tiers have a real container.
   *
   * Soft-deleted rows and unclaimed warm-pool rows are excluded like the
   * sibling predicates in this file: neither belongs to a tenant-serving
   * agent, so dialing them wastes cycles and pollutes heartbeat telemetry
   * (#22548).
   */
  async listRunning(): Promise<Array<{ id: string; organization_id: string }>> {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.pool_status),
        ),
      );
  }

  /**
   * Tier x status census of the container-backed tenant fleet, for the
   * fleet-liveness monitor (#22548). Grouping by BOTH keys is the point: the
   * monitor cannot decide whether a row "should be reachable right now" from
   * its status alone, because the tiers carry different serving contracts —
   * `dedicated-lazy` is allowed to sleep, `dedicated-always`/`custom` are not.
   * The caller applies that contract with `isFleetRowExpectedReachable`.
   *
   * The tier filter is an explicit allowlist rather than `<> 'shared'` so a
   * tier added later cannot silently join the paging census: shared rows are
   * container-free by design, and any new tier must state its own serving
   * contract before it can raise a fleet alarm. Soft-deleted rows and
   * unclaimed warm-pool rows are excluded because neither belongs to a
   * tenant-serving agent.
   *
   * Status is deliberately NOT filtered here: the monitor needs the off-state
   * counts (`sleeping`, `stopped`, ...) to report the whole fleet picture
   * alongside the alarm, and a fleet whose every row sits in `error` — the
   * exact shape the heartbeat sweep cannot see, since it iterates only
   * `running` rows — must still appear in the census.
   */
  async summarizeDedicatedFleet(): Promise<
    Array<{ execution_tier: string; status: string; count: number }>
  > {
    await ensureAgentSandboxSchema();
    return dbRead
      .select({
        execution_tier: agentSandboxes.execution_tier,
        status: agentSandboxes.status,
        count: sql<number>`count(*)::int`,
      })
      .from(agentSandboxes)
      .where(
        and(
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.pool_status),
        ),
      )
      .groupBy(agentSandboxes.execution_tier, agentSandboxes.status);
  }

  /**
   * Always-on (paid) agents that should be reconciled back to `running`. A
   * `dedicated-always` agent is contractually meant to stay up, so a transient
   * tailnet drop that flipped it to `disconnected` must self-heal — the recovery
   * cycle re-probes the bridge and either flips it back to `running` (still
   * reachable) or re-provisions it (truly down). Blue/green swaps can also race
   * a stale monitor write that leaves a healthy container behind an `error` row;
   * include only errored rows with a bridge to probe, rollback metadata, and no
   * explicit `error_message`. Generic provisioning/restore failures set an
   * operator-visible error message, can also leave a bridge behind, and must stay
   * failed instead of being silently revived.
   *
   * Scoped to `dedicated-always` because `dedicated-lazy`/`shared` are NOT meant
   * to hold an always-on container. Deleted rows are excluded.
   */
  async listRecoverable(limit = 100): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      bridge_url: string | null;
      lifecycle_revision: number;
      updated_at: Date;
      status: AgentSandboxStatus;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        bridge_url: agentSandboxes.bridge_url,
        lifecycle_revision: agentSandboxes.lifecycle_revision,
        updated_at: agentSandboxes.updated_at,
        status: agentSandboxes.status,
      })
      .from(agentSandboxes)
      .where(
        and(
          sql`(
            ${agentSandboxes.status} = 'disconnected'
            OR (
              ${agentSandboxes.status} = 'error'
              AND ${agentSandboxes.bridge_url} IS NOT NULL
              AND ${agentSandboxes.previous_image_digest} IS NOT NULL
              AND ${agentSandboxes.error_message} IS NULL
            )
          )`,
          eq(agentSandboxes.execution_tier, "dedicated-always"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .limit(limit);
  }

  /**
   * Rows WEDGED in `provisioning` past `cutoff` that still carry a container
   * to re-probe (`sandbox_id` set): a container was created but the readiness
   * probe returned a false-negative (SSH transport blip) so the provision
   * never flipped the row to `running` and no active job is driving it forward.
   * These are the split-brain candidates the daemon-side reconciler re-probes
   * and flips to `running` when the container is actually healthy (#15310 #6).
   *
   * Keyed on `updated_at` staleness (the provision writes bump it), and only
   * rows with no active provisioning owner — an in-flight job is still driving
   * the provision and must not be raced. Excludes warm-pool rows
   * (`pool_status IS NULL`), soft-deleted rows, and rows without a container.
   */
  async listStuckProvisioningWithContainer(
    cutoff: Date,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      updated_at: Date | null;
    }>
  > {
    await ensureAgentSandboxSchema();
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        updated_at: agentSandboxes.updated_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "provisioning"),
          lt(agentSandboxes.updated_at, cutoff),
          sql`${agentSandboxes.sandbox_id} IS NOT NULL`,
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
          hasNoProvisioningStatusOwnerJob(),
        ),
      )
      .limit(limit);
  }

  /**
   * Shared-tier bridge rows old enough to be reap candidates: live (not
   * soft-deleted), `execution_tier = 'shared'`, created before `cutoff`. The
   * shared→dedicated handoff deletes the bridge on success; a timed-out/failed
   * handoff (or a closed browser) leaks the row. Oldest first so a backlog
   * drains deterministically under the per-tick cap. The orphan decision is NOT
   * made here — the caller pairs these against live dedicated twins (#9939).
   */
  async listSharedBridgeReapCandidates(
    cutoff: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      created_at: Date;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.execution_tier, "shared"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          lt(agentSandboxes.created_at, cutoff),
        ),
      )
      .orderBy(asc(agentSandboxes.created_at))
      .limit(limit);
  }

  /**
   * Live (running, non-deleted) dedicated sandboxes in the given orgs — the
   * "twin took over" side of the orphan-shared decision. A shared bridge is an
   * orphan only when one of these shares its (org, user, agent_name) and was
   * created at/after it (the handoff mints the bridge first, then the dedicated
   * twin). Scoped to the candidate orgs to keep the scan bounded (#9939).
   */
  async listLiveDedicatedTwins(organizationIds: string[]): Promise<
    Array<{
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      created_at: Date;
    }>
  > {
    if (organizationIds.length === 0) return [];
    return dbRead
      .select({
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          inArray(agentSandboxes.organization_id, organizationIds),
          eq(agentSandboxes.status, "running"),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      );
  }

  /**
   * Find running, non-deleted agents whose stored `image_digest` differs from
   * `targetDigest` (treating NULL as different). Used by the fleet-upgrade
   * reconciler to enqueue blue/green swaps onto the currently-deployed image.
   * Rollback-safe exhausted upgrades are skipped only for the exact target digest
   * they already failed, so a later target digest re-arms the agent. Capped by
   * `limit` so a single cycle doesn't try to enqueue the whole fleet at once.
   */
  async listRunningWithDigestOtherThan(
    targetDigest: string,
    targetImage: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      image_digest: string | null;
      docker_image: string | null;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        image_digest: agentSandboxes.image_digest,
        docker_image: agentSandboxes.docker_image,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          sql`${agentSandboxes.image_digest} IS DISTINCT FROM ${targetDigest}`,
          // Skip a row ONLY when it carries a rollback-safe upgrade-failure
          // marker for THIS EXACT target digest — i.e. the same doomed upgrade
          // already exhausted its retries, so re-enqueuing it would just fail
          // again against the still-serving old container. Re-arm when:
          //   - error_message IS NULL (clean row), OR
          //   - it has some non-upgrade error_message with no target marker
          //     (defensive: don't let an unrelated message freeze upgrades), OR
          //   - it has a target marker for a DIFFERENT target digest — a NEWER
          //     image was published, which may well succeed where the old target
          //     failed. Without this, a single transient rollback-safe failure
          //     (SSH blip, registry hiccup) would permanently exclude an
          //     always-on agent from ALL future fleet upgrades, including
          //     security patches (#15357 / NubsCarson's #15311 adversarial
          //     review). Genuinely-dead upgrade failures are `status:"error"`
          //     and already excluded by the status filter above.
          sql`(
            ${agentSandboxes.error_message} IS NULL
            OR ${agentSandboxes.error_message} NOT LIKE ${`%${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}%`}
            OR ${agentSandboxes.error_message} NOT LIKE ${`%${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}${targetDigest}]%`}
          )`,
          // Only reconcile agents on the configured default image. Per-agent
          // image overrides are intentional and must not be rolled onto the
          // global fleet tag. Match on the REPO, not the full ref: a fleet
          // agent pinned to an older TAG (`…:sha-abc`) is still the default
          // image and must be selected, otherwise tag-pinned default agents
          // never drift back to the current default (#15101). Explicit digest
          // pins are handled separately below (#18030).
          sql`(${agentSandboxes.docker_image} IS NULL OR ${imageRepoSql(agentSandboxes.docker_image)} = ${imageRepo(targetImage)})`,
          // An explicit canonical `@sha256:<64hex>` docker_image is an operator
          // placement decision, not tag drift (#18030): the reconciler must
          // never converge a digest-pinned row onto the moving default tag —
          // that is exactly the mechanism that downgraded a live agent
          // mid-canary. The #15101 drift-back requirement is hereby scoped to
          // tag pins only. One exception keeps self-healing: when the pinned
          // digest IS the configured target digest, selecting the row merely
          // repairs a stale image_digest column. Malformed pseudo-pins (short
          // hex, double `@`) do not earn pin status and stay drift candidates.
          sql`(
            ${agentSandboxes.docker_image} IS NULL
            OR NOT ${isDigestPinnedImageSql(agentSandboxes.docker_image)}
            OR ${pinnedImageDigestSql(agentSandboxes.docker_image)} = ${targetDigest}
          )`,
          // Skip pool-owned rows (warm pool entries) — they get the new
          // image naturally on next claim, no need to disrupt them.
          sql`${agentSandboxes.pool_status} IS NULL`,
          // A warm-claimed container is not a valid blue/green source until
          // its user-org inference credential has been attested. Keep this
          // predicate before LIMIT so pending rows cannot starve later ready
          // candidates from the bounded reconciler batch.
          sql`(
            ${agentSandboxes.claimed_at} IS NULL
            OR (
              ${agentSandboxes.warm_claim_credential_state} = 'ready'
              AND ${agentSandboxes.warm_claim_source_pool_id} IS NULL
              AND ${agentSandboxes.warm_claim_key_fingerprint} IS NOT NULL
              AND ${agentSandboxes.warm_claim_attested_at} IS NOT NULL
              AND ${agentSandboxes.warm_claim_attested_environment_revision} IS NOT NULL
              AND ${agentSandboxes.warm_claim_attested_environment_revision}
                = ${agentSandboxes.environment_revision}
            )
          )`,
          // Only agents that actually run on a fleet container can be
          // blue/green upgraded. Shared-runtime / web-only agents are "running"
          // through the router origin with no node_id/container_name, so
          // executeUpgrade always returns "no node_id or container_name to
          // upgrade from" — and because the failed upgrade never changes their
          // digest, the reconciler re-selects them every cycle, producing an
          // endless agent_upgrade retry storm. Exclude them here.
          sql`${agentSandboxes.node_id} IS NOT NULL`,
          sql`${agentSandboxes.container_name} IS NOT NULL`,
        ),
      )
      .limit(limit);
  }

  /**
   * Inventory pre-fence warm claims that need one lifecycle-locked restart
   * before they can participate in image rollout. Running, stopped, and error
   * rows are all recoverable even when their old container handles are absent:
   * restart cold-provisions a fresh container, re-attests a newly minted
   * user-org credential, and records its immutable digest. A missing historic
   * source-pool id cannot be reconstructed; the existing stranded-agent-key
   * sweeper owns those already-orphaned legacy credentials.
   */
  async listLegacyWarmClaimRecoveryCandidates(limit: number): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      image_digest: string | null;
    }>
  > {
    return dbWrite
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        image_digest: agentSandboxes.image_digest,
      })
      .from(agentSandboxes)
      .where(
        and(
          inArray(agentSandboxes.status, ["running", "provisioning", "stopped", "error"]),
          isNotNull(agentSandboxes.claimed_at),
          sql`${agentSandboxes.warm_claim_credential_state} IS NULL`,
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .orderBy(asc(agentSandboxes.updated_at), asc(agentSandboxes.id))
      .limit(limit);
  }

  /**
   * Claimed handoffs that durably entered pending/attested state but lost their
   * restart enqueue (for example, the route process died after committing the
   * claim). The age fence avoids racing the live claim-time push; the active-job
   * exclusion and lifecycle-locked enqueue make recovery idempotent after that
   * ownership window expires.
   */
  async listStrandedWarmClaimRecoveryCandidates(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; organization_id: string; user_id: string }>> {
    return dbWrite
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          inArray(agentSandboxes.status, ["running", "provisioning", "stopped", "error"]),
          isNotNull(agentSandboxes.claimed_at),
          sql`${agentSandboxes.warm_claim_credential_state} IN ('pending', 'attested')`,
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
          lt(agentSandboxes.updated_at, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND    ${jobs.type} = 'agent_restart'
            AND    ${jobs.status} IN ('pending', 'in_progress')
          )`,
        ),
      )
      .orderBy(asc(agentSandboxes.updated_at), asc(agentSandboxes.id))
      .limit(limit);
  }

  /**
   * Durable credential cleanup queue for exhausted warm-claim recovery. Rows
   * retain their source id until both target and source owners are revoked;
   * a failed cleanup remains selectable on the next daemon pass.
   */
  async listFailedWarmClaimCredentialCleanupCandidates(
    limit: number,
  ): Promise<Array<{ id: string; organization_id: string }>> {
    return dbWrite
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.warm_claim_credential_state, "failed"),
          sql`${agentSandboxes.warm_claim_cleanup_completed_at} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .orderBy(asc(agentSandboxes.updated_at), asc(agentSandboxes.id))
      .limit(limit);
  }

  /**
   * Find running, non-deleted agents currently on `currentDigest` that also
   * have a persisted `previous_image_digest`. Used by the operator-gated
   * rollback endpoint to enqueue downgrade jobs only for agents that can
   * actually roll back.
   */
  async listRollbackEligibleForDigest(
    currentDigest: string,
    targetImage: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      image_digest: string | null;
      previous_image_digest: string | null;
      docker_image: string | null;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        image_digest: agentSandboxes.image_digest,
        previous_image_digest: agentSandboxes.previous_image_digest,
        docker_image: agentSandboxes.docker_image,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          eq(agentSandboxes.image_digest, currentDigest),
          isNotNull(agentSandboxes.previous_image_digest),
          // Match the default image by REPO, not full ref — same rationale as
          // listRunningWithDigestOtherThan (#15101): a rollback-eligible fleet
          // agent may be pinned to a different tag/digest of the same repo.
          sql`(${agentSandboxes.docker_image} IS NULL OR ${imageRepoSql(agentSandboxes.docker_image)} = ${imageRepo(targetImage)})`,
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.node_id} IS NOT NULL`,
          sql`${agentSandboxes.container_name} IS NOT NULL`,
        ),
      )
      .limit(limit);
  }

  async findRunningSandbox(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    // Use dbWrite (primary) for fresh read-after-write data from the VPS worker.
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, id),
          eq(agentSandboxes.organization_id, orgId),
          eq(agentSandboxes.status, "running"),
          inArray(agentSandboxes.execution_tier, [...RUNNING_SANDBOX_EXECUTION_TIERS]),
        ),
      )
      .limit(1);
    return r;
  }

  async findByManagedDiscordGuildId(guildId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) {
      return [];
    }

    const rows = await sqlRows<AgentSandbox>(
      dbWrite,
      sql`
      SELECT *
      FROM ${agentSandboxes}
      WHERE (${agentSandboxes.agent_config} -> ${AGENT_MANAGED_DISCORD_KEY} ->> 'guildId') = ${trimmedGuildId}
      ORDER BY ${agentSandboxes.updated_at} DESC
    `,
    );

    return rows;
  }

  // Writes

  async create(data: NewAgentSandbox): Promise<AgentSandbox> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite.insert(agentSandboxes).values(data).returning();
    if (!r) throw new Error("Failed to create Agent sandbox record");
    return r;
  }

  async markStuckProvisioningWithoutActiveJobAsError(cutoff: Date): Promise<
    ReconciliationBatchResult<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      updatedAt: Date | null;
    }>
  > {
    await ensureAgentSandboxSchema();
    const candidates = await dbWrite
      .select({
        agentId: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "provisioning"),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          lt(agentSandboxes.updated_at, cutoff),
          hasNoProvisioningStatusOwnerJob(),
        ),
      )
      .orderBy(asc(agentSandboxes.updated_at), asc(agentSandboxes.id))
      .limit(PROVISIONING_RECONCILIATION_BATCH_SIZE);

    const swept: Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      updatedAt: Date | null;
    }> = [];
    let deferred = 0;
    for (const candidate of candidates) {
      const updated = await dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        const [lock] = await sqlRows<{ acquired: boolean }>(
          tx,
          elizaTryProvisionAdvisoryLockSql(candidate.organizationId, candidate.agentId),
        );
        if (!lock?.acquired) return "deferred" as const;
        const [row] = await tx
          .update(agentSandboxes)
          .set({
            status: "error",
            error_message:
              "Agent was stuck in provisioning state with no active provisioning job. " +
              "This usually means a container crashed before the provisioning job could be created, " +
              "or the job was lost. Please try starting the agent again.",
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, candidate.agentId),
              eq(agentSandboxes.organization_id, candidate.organizationId),
              eq(agentSandboxes.status, "provisioning"),
              inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
              lt(agentSandboxes.updated_at, cutoff),
              hasNoProvisioningStatusOwnerJob(),
            ),
          )
          .returning({
            agentId: agentSandboxes.id,
            agentName: agentSandboxes.agent_name,
            organizationId: agentSandboxes.organization_id,
            updatedAt: agentSandboxes.updated_at,
          });
        return row;
      });
      if (updated === "deferred") deferred++;
      else if (updated) swept.push(updated);
    }
    return { updated: swept, deferred };
  }

  /**
   * Recover ORPHANED PENDING sandboxes: a user-owned row that was committed as
   * `pending` but never got an `agent_provision` job enqueued (a throw in the
   * create→enqueue window of the agents/coding-container/eliza-app paths). The
   * provisioning daemon only claims rows that HAVE a job, so such a row is
   * structurally unclaimable and would sit in `pending` forever with a null
   * error_message — a silent failure to the user.
   *
   * We MARK ERROR (never auto re-enqueue): the original env-prep may have
   * failed, so re-provisioning could spin up a half-configured agent. A clear
   * error makes the failure visible and lets the user retry the whole flow.
   *
   * `pool_status IS NULL` skips warm-pool rows, which are legitimately `pending`
   * with no per-agent job until claimed. Keyed on `created_at` (not
   * `updated_at`): the managed-env write bumps `updated_at`, so `created_at` is
   * the honest "how long has this been stuck" signal.
   */
  async markOrphanedPendingWithoutJobAsError(cutoff: Date): Promise<
    ReconciliationBatchResult<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      createdAt: Date | null;
    }>
  > {
    await ensureAgentSandboxSchema();
    const noProvisionJob = () => hasNoProvisioningOwnerJob([JOB_TYPES.AGENT_PROVISION]);
    const candidates = await dbWrite
      .select({
        agentId: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "pending"),
          sql`${agentSandboxes.pool_status} IS NULL`,
          lt(agentSandboxes.created_at, cutoff),
          noProvisionJob(),
        ),
      )
      .orderBy(asc(agentSandboxes.created_at), asc(agentSandboxes.id))
      .limit(PROVISIONING_RECONCILIATION_BATCH_SIZE);

    const swept: Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      createdAt: Date | null;
    }> = [];
    let deferred = 0;
    for (const candidate of candidates) {
      const updated = await dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        const [lock] = await sqlRows<{ acquired: boolean }>(
          tx,
          elizaTryProvisionAdvisoryLockSql(candidate.organizationId, candidate.agentId),
        );
        if (!lock?.acquired) return "deferred" as const;
        const [row] = await tx
          .update(agentSandboxes)
          .set({
            status: "error",
            error_message:
              "Provisioning never started: no agent_provision job was enqueued " +
              "(orphaned pending). Please retry.",
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, candidate.agentId),
              eq(agentSandboxes.organization_id, candidate.organizationId),
              eq(agentSandboxes.status, "pending"),
              sql`${agentSandboxes.pool_status} IS NULL`,
              lt(agentSandboxes.created_at, cutoff),
              noProvisionJob(),
            ),
          )
          .returning({
            agentId: agentSandboxes.id,
            agentName: agentSandboxes.agent_name,
            organizationId: agentSandboxes.organization_id,
            createdAt: agentSandboxes.created_at,
          });
        return row;
      });
      if (updated === "deferred") deferred++;
      else if (updated) swept.push(updated);
    }
    return { updated: swept, deferred };
  }

  /** Failed asynchronous work may only mark its own execution, or its exact unleased generation. */
  async markProvisionFailed(
    expected: AgentSandbox,
    message: string,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const execution =
      expected.lifecycle_job_id !== null && expected.lifecycle_execution_generation !== null;
    const [updated] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "error",
        error_message: message,
        error_count: sql`COALESCE(${agentSandboxes.error_count}, 0) + 1`,
        bridge_url: null,
        health_url: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(agentSandboxes.id, expected.id),
          eq(agentSandboxes.organization_id, expected.organization_id),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          inArray(agentSandboxes.status, ["provisioning", "running"]),
          eq(agentSandboxes.environment_revision, expected.environment_revision),
          isNull(agentSandboxes.deletion_attempt_id),
          isNull(agentSandboxes.deleted_at),
          execution
            ? and(
                eq(agentSandboxes.lifecycle_job_id, expected.lifecycle_job_id!),
                eq(
                  agentSandboxes.lifecycle_execution_generation,
                  expected.lifecycle_execution_generation!,
                ),
              )
            : and(
                isNull(agentSandboxes.lifecycle_job_id),
                isNull(agentSandboxes.lifecycle_execution_generation),
                eq(agentSandboxes.lifecycle_revision, expected.lifecycle_revision),
              ),
        ),
      )
      .returning();
    return updated;
  }

  async update(
    id: string,
    data: Partial<NewAgentSandbox>,
    expectedRunningGeneration?: {
      organizationId: string;
      environmentRevision: number;
      sandboxId: string | null;
      nodeId: string | null;
      containerName: string | null;
      lifecycleRevision: number;
    },
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const updateData =
      data.environment_vars === undefined
        ? { ...data, updated_at: new Date() }
        : {
            ...data,
            environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
            warm_claim_credential_state: sql`
              CASE
                WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                  AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
                THEN 'pending'
                ELSE ${agentSandboxes.warm_claim_credential_state}
              END
            `,
            warm_claim_key_fingerprint: sql`
              CASE
                WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                  AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
                THEN NULL
                ELSE ${agentSandboxes.warm_claim_key_fingerprint}
              END
            `,
            warm_claim_attested_at: sql`
              CASE
                WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                  AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
                THEN NULL
                ELSE ${agentSandboxes.warm_claim_attested_at}
              END
            `,
            warm_claim_attested_environment_revision: sql`
              CASE
                WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                  AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
                THEN NULL
                ELSE ${agentSandboxes.warm_claim_attested_environment_revision}
              END
            `,
            updated_at: new Date(),
          };
    const predicates = [
      eq(agentSandboxes.id, id),
      sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
    ];
    if (data.environment_vars !== undefined) {
      predicates.push(
        sql`COALESCE(${agentSandboxes.warm_claim_credential_state}, '') NOT IN ('pending', 'attested')`,
      );
    }
    if (expectedRunningGeneration) {
      predicates.push(
        eq(agentSandboxes.organization_id, expectedRunningGeneration.organizationId),
        eq(agentSandboxes.status, "running"),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        eq(agentSandboxes.environment_revision, expectedRunningGeneration.environmentRevision),
        sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${expectedRunningGeneration.sandboxId}`,
        sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${expectedRunningGeneration.nodeId}`,
        sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${expectedRunningGeneration.containerName}`,
        // The database-owned lifecycle_revision subsumes the earlier
        // ms-windowed updated_at fence (#17284): the trigger advances it on
        // every write, including raw SQL writers, so no timestamp-precision
        // or same-millisecond ABA window exists (#17249 fence class).
        eq(agentSandboxes.lifecycle_revision, expectedRunningGeneration.lifecycleRevision),
        hasNoProvisioningOwnerJob([...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
      );
      // Enqueue takes this same lock before capturing the lifecycle revision.
      // A probe must either commit first or yield to the accepted operation;
      // otherwise a harmless heartbeat can supersede a queued user shutdown.
      return dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(
          elizaProvisionAdvisoryLockSql(expectedRunningGeneration.organizationId, id),
        );
        const [updated] = await tx
          .update(agentSandboxes)
          .set(updateData)
          .where(and(...predicates))
          .returning();
        return updated;
      });
    }
    const [r] = await dbWrite
      .update(agentSandboxes)
      .set(updateData)
      .where(and(...predicates))
      .returning();
    return r;
  }

  /**
   * Atomically take the provisioning lock. `provisioning` is included so a
   * row left stuck by a crashed worker can be retaken; the job-level stale
   * recovery in ProvisioningJobService is the time-based gate.
   *
   * `running` is admitted ONLY for a never-containerized row
   * (`container_name IS NULL AND sandbox_id IS NULL`). A direct/shared provision
   * inserts the row as `running` BEFORE any container exists
   * (eliza-sandbox.ts buildAgentInsertData), so a half-provisioned row that
   * crashed before a container was created would otherwise be stuck at `running`
   * forever — none of the other admitted states match it, and the lock could
   * never be retaken, permanently blocking re-provision (the tonight outage).
   * The two NULL guards keep this STRICTLY off any genuinely-running dedicated
   * agent: the moment a container is created the provision path stamps
   * `container_name`/`sandbox_id`, so a live agent can NEVER satisfy this branch
   * and can NEVER have its lock taken from under it.
   *
   * Terminal provision failures are different from transport-unresolved
   * `provisioning` retries: the old handle already failed every job attempt and
   * must not be re-probed as the next wake/restart target. Clear only that
   * permanent-failure handle while acquiring the new lock so a retry starts from
   * provider.create with a fresh container record.
   */
  async trySetProvisioning(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      const eligibility = and(
        eq(agentSandboxes.id, id),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        sql`${agentSandboxes.replacement_cleanup_sandbox_id} IS NULL`,
        sql`(
            ${agentSandboxes.status} IN ('pending', 'provisioning', 'stopped', 'sleeping', 'disconnected', 'error')
            OR (
              ${agentSandboxes.status} = 'running'
              AND ${agentSandboxes.container_name} IS NULL
              AND ${agentSandboxes.sandbox_id} IS NULL
            )
          )`,
      );
      await assertProvisionQuota(tx, id, undefined, eligibility);
      const [r] = await tx
        .update(agentSandboxes)
        .set(provisioningAdmissionUpdatePayload())
        .where(eligibility)
        .returning();
      return r;
    });
  }

  /**
   * Atomically admit a non-running restore into provisioning only while the
   * exact tenant lifecycle authority captured by restore selection is current.
   *
   * Unlike `trySetProvisioning`, this path never admits a retry already in
   * `provisioning`, a create-path `pending` row, a never-containerized
   * `running` row, or a row that needs cleanup before another container
   * generation can start. `pending` is deliberately excluded because failed
   * create-to-enqueue compensation may remove that generation. A lost CAS is
   * a hard admission failure: the caller must not report the selected backup
   * as restored by another provisioning winner.
   *
   * The advisory lock orders this admission after any concurrent lifecycle
   * enqueue. The UPDATE then takes a fresh READ COMMITTED snapshot and rejects
   * a committed exclusive job before changing the row.
   */
  async trySetProvisioningFromRestoreCapture(
    capture: ProvisioningAdmissionCapture,
  ): Promise<AgentSandbox | undefined> {
    const isAdmissibleStatus = (
      RESTORE_PROVISIONING_ADMISSIBLE_STATUSES as readonly AgentSandboxStatus[]
    ).includes(capture.status);
    const isCanonicalContainerTier = (
      CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]
    ).includes(capture.execution_tier);
    if (
      !isAdmissibleStatus ||
      !isCanonicalContainerTier ||
      capture.lifecycle_job_id !== null ||
      capture.lifecycle_execution_generation !== null ||
      capture.pool_status !== null ||
      capture.deleted_at !== null ||
      capture.deletion_attempt_id !== null
    ) {
      return undefined;
    }

    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaProvisionAdvisoryLockSql(capture.organization_id, capture.id));
      const eligibility = and(
        eq(agentSandboxes.id, capture.id),
        eq(agentSandboxes.organization_id, capture.organization_id),
        eq(agentSandboxes.status, capture.status),
        inArray(agentSandboxes.status, [...RESTORE_PROVISIONING_ADMISSIBLE_STATUSES]),
        eq(agentSandboxes.execution_tier, capture.execution_tier),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        eq(agentSandboxes.lifecycle_revision, capture.lifecycle_revision),
        isNull(agentSandboxes.lifecycle_job_id),
        isNull(agentSandboxes.lifecycle_execution_generation),
        hasNoProvisioningOwnerJob([...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
        isNull(agentSandboxes.pool_status),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
        isNull(agentSandboxes.replacement_cleanup_sandbox_id),
        isNull(agentSandboxes.replacement_cleanup_node_id),
        isNull(agentSandboxes.replacement_cleanup_container_name),
        isNull(agentSandboxes.replacement_cleanup_attempt_id),
        isNull(agentSandboxes.replacement_cleanup_container_id),
        isNull(agentSandboxes.replacement_cleanup_vpn_node_id),
        isNull(agentSandboxes.replacement_cleanup_vpn_node_name),
        isNull(agentSandboxes.replacement_cleanup_preserved_vpn_node_id),
        isNull(agentSandboxes.replacement_cleanup_vpn_registration_started_at),
        isNull(agentSandboxes.replacement_cleanup_allocation_counted),
        isNull(agentSandboxes.replacement_cleanup_created_at),
        sql`${agentSandboxes.warm_claim_credential_state} IS DISTINCT FROM 'failed'`,
      );
      await assertProvisionQuota(tx, capture.id, capture.organization_id, eligibility);
      const [r] = await tx
        .update(agentSandboxes)
        .set(provisioningAdmissionUpdatePayload())
        .where(eligibility)
        .returning();
      return r;
    });
  }

  /**
   * Atomically restore a still-recoverable agent to `running` after a successful
   * bridge re-probe. The recovery read -> probe -> write window spans seconds,
   * during which the row may move to `deletion_pending` (delete enqueue),
   * `stopped` (shutdown nulls `bridge_url`), or `provisioning` (re-provision).
   * This compare-and-set only flips a row that is STILL in the status the caller
   * probed with a live bridge and not soft-deleted. Errored rows additionally
   * must carry `previous_image_digest` and no explicit `error_message`, so
   * generic provisioning/restore failures are not masked. A stale probe can never
   * resurrect a being-deleted agent or wedge a stopped one at `running` with a
   * dead bridge. The non-blocking lifecycle advisory lock also prevents an
   * enqueue transaction whose job insert is not visible yet from being crossed
   * by this UPDATE. Returns the row when it won, undefined when it lost the race
   * (and the caller must NOT treat it as recovered).
   */
  async markReconnectedFromDisconnected(
    expected: DisconnectedRecoveryCapture,
    repairedIngress?: RepairedDisconnectedIngress,
  ): Promise<AgentSandbox | undefined> {
    const recoverableStatus = expected.status === "disconnected" || expected.status === "error";
    const isCanonicalContainerTier = (
      CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]
    ).includes(expected.execution_tier);
    if (
      !recoverableStatus ||
      !isCanonicalContainerTier ||
      !expected.sandbox_id?.trim() ||
      !expected.node_id?.trim() ||
      !expected.container_name?.trim() ||
      !expected.bridge_url?.trim() ||
      expected.lifecycle_job_id !== null ||
      expected.lifecycle_execution_generation !== null ||
      expected.pool_status !== null ||
      expected.deleted_at !== null ||
      expected.deletion_attempt_id !== null ||
      (expected.status === "error" &&
        (expected.previous_image_digest === null || expected.error_message !== null))
    ) {
      return undefined;
    }

    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      const [lock] = await sqlRows<{ acquired: boolean }>(
        tx,
        elizaTryProvisionAdvisoryLockSql(expected.organization_id, expected.id),
      );
      if (!lock?.acquired) return undefined;
      const eligibility = and(
        eq(agentSandboxes.id, expected.id),
        eq(agentSandboxes.organization_id, expected.organization_id),
        eq(agentSandboxes.status, expected.status),
        inArray(agentSandboxes.status, ["disconnected", "error"]),
        eq(agentSandboxes.execution_tier, expected.execution_tier),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${expected.sandbox_id}`,
        sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${expected.node_id}`,
        sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${expected.container_name}`,
        sql`${agentSandboxes.bridge_url} IS NOT DISTINCT FROM ${expected.bridge_url}`,
        sql`${agentSandboxes.health_url} IS NOT DISTINCT FROM ${expected.health_url}`,
        sql`${agentSandboxes.headscale_ip} IS NOT DISTINCT FROM ${expected.headscale_ip}`,
        eq(agentSandboxes.environment_revision, expected.environment_revision),
        eq(agentSandboxes.lifecycle_revision, expected.lifecycle_revision),
        isNull(agentSandboxes.lifecycle_job_id),
        isNull(agentSandboxes.lifecycle_execution_generation),
        hasNoProvisioningOwnerJob([...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
        isNull(agentSandboxes.pool_status),
        sql`${agentSandboxes.previous_image_digest} IS NOT DISTINCT FROM ${expected.previous_image_digest}`,
        sql`${agentSandboxes.error_message} IS NOT DISTINCT FROM ${expected.error_message}`,
        sql`${expected.status} != 'error' OR (${agentSandboxes.previous_image_digest} IS NOT NULL AND ${agentSandboxes.error_message} IS NULL)`,
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
      );
      await assertProvisionQuota(tx, expected.id, expected.organization_id, eligibility);
      const [r] = await tx
        .update(agentSandboxes)
        .set({
          status: "running",
          error_message: null,
          last_heartbeat_at: new Date(),
          updated_at: new Date(),
          ...(repairedIngress
            ? {
                headscale_ip: repairedIngress.headscaleIp,
                bridge_url: repairedIngress.bridgeUrl,
                health_url: repairedIngress.healthUrl,
                ...(repairedIngress.errorCount === undefined
                  ? {}
                  : { error_count: repairedIngress.errorCount }),
              }
            : {}),
        })
        .where(eligibility)
        .returning();
      return r;
    });
  }

  /**
   * Guarded CAS that flips a WEDGED `provisioning` row to `running` after the
   * daemon reconciler re-probed its container and found it healthy (#15310 #6).
   * Only fires when the row is STILL `provisioning` with a live container
   * (`sandbox_id` plus durable `node_id` set) and no active provisioning owner
   * racing it — so a concurrent job flip, delete, or stop during the
   * multi-second re-probe is never clobbered. Returns undefined when the CAS
   * matched nothing.
   */
  async markRunningFromProvisioning(
    expected: ProvisioningRecoveryCapture,
  ): Promise<AgentSandbox | undefined> {
    const isCanonicalContainerTier = (
      CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]
    ).includes(expected.execution_tier);
    if (
      expected.status !== "provisioning" ||
      !isCanonicalContainerTier ||
      !expected.sandbox_id?.trim() ||
      !expected.node_id?.trim() ||
      !expected.container_name?.trim() ||
      expected.lifecycle_job_id !== null ||
      expected.lifecycle_execution_generation !== null ||
      expected.pool_status !== null ||
      expected.deleted_at !== null ||
      expected.deletion_attempt_id !== null
    ) {
      return undefined;
    }

    await ensureAgentSandboxSchema();

    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      const [lock] = await sqlRows<{ acquired: boolean }>(
        tx,
        elizaTryProvisionAdvisoryLockSql(expected.organization_id, expected.id),
      );
      if (!lock?.acquired) return undefined;
      const [updated] = await tx
        .update(agentSandboxes)
        .set({
          status: "running",
          error_message: null,
          last_heartbeat_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, expected.id),
            eq(agentSandboxes.organization_id, expected.organization_id),
            eq(agentSandboxes.status, expected.status),
            eq(agentSandboxes.execution_tier, expected.execution_tier),
            inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
            sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${expected.sandbox_id}`,
            sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${expected.node_id}`,
            sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${expected.container_name}`,
            sql`${agentSandboxes.bridge_url} IS NOT DISTINCT FROM ${expected.bridge_url}`,
            sql`${agentSandboxes.health_url} IS NOT DISTINCT FROM ${expected.health_url}`,
            sql`${agentSandboxes.headscale_ip} IS NOT DISTINCT FROM ${expected.headscale_ip}`,
            eq(agentSandboxes.environment_revision, expected.environment_revision),
            eq(agentSandboxes.lifecycle_revision, expected.lifecycle_revision),
            isNull(agentSandboxes.lifecycle_job_id),
            isNull(agentSandboxes.lifecycle_execution_generation),
            isNull(agentSandboxes.pool_status),
            isNull(agentSandboxes.deleted_at),
            isNull(agentSandboxes.deletion_attempt_id),
            hasNoProvisioningStatusOwnerJob(),
          ),
        )
        .returning();
      return updated;
    });
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    await ensureAgentSandboxSchema();
    const r = await dbWrite
      .delete(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .returning({ id: agentSandboxes.id });
    return r.length > 0;
  }

  // ── Warm pool ─────────────────────────────────────────────────────────

  /** Count entries that the claim transaction can transfer immediately. */
  async countUnclaimedPool(filter: WarmPoolImageFilter = {}): Promise<number> {
    await ensureAgentSandboxSchema();
    const [row] = await dbWrite
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(and(...claimableWarmPoolConditions(filter)));
    if (!row) {
      throw new ElizaError("Warm-pool capacity query returned no aggregate row", {
        code: "WARM_POOL_CAPACITY_READ_FAILED",
        context: { image: filter.image, digest: filter.digest },
      });
    }
    return row.count;
  }

  /**
   * Count claimable and in-flight entries for one desired image. Image-scoped
   * sizing prevents stale-image or otherwise unclaimable rows from suppressing
   * replacement capacity.
   */
  async countAllPoolEntries(
    filter: WarmPoolImageFilter = {},
  ): Promise<{ ready: number; provisioning: number }> {
    await ensureAgentSandboxSchema();
    const claimable = and(...claimableWarmPoolConditions(filter));
    const inFlight = and(...inFlightWarmPoolConditions(filter));
    if (!claimable || !inFlight) {
      throw new ElizaError("Warm-pool inventory predicate was empty", {
        code: "WARM_POOL_PREDICATE_INVALID",
        severity: "fatal",
      });
    }
    const [inventory] = await dbWrite
      .select({
        ready: sql<number>`count(*) FILTER (WHERE ${claimable})::int`,
        provisioning: sql<number>`count(*) FILTER (WHERE ${inFlight})::int`,
      })
      .from(agentSandboxes);
    if (!inventory) {
      throw new ElizaError("Warm-pool inventory query returned no aggregate row", {
        code: "WARM_POOL_CAPACITY_READ_FAILED",
        context: { image: filter.image, digest: filter.digest },
      });
    }
    return inventory;
  }

  /**
   * Count ready (claimable) unclaimed pool entries for a specific image.
   * Used ONLY on the claim-null path to distinguish an EMPTY pool (starvation
   * — the C4 steady state when replenish is broken) from a user-row that was
   * merely ineligible for a claim (already running / already has a DB). A
   * `warm_pool.empty_on_claim` observability event fires only when this returns
   * 0, so a re-provision falling through doesn't pollute the starvation signal.
   * This delegates to the same authoritative predicate as every other capacity
   * reader and the claim transaction.
   */
  async countReadyPoolEntriesForImage(image: string): Promise<number> {
    return this.countUnclaimedPool({ image });
  }

  /**
   * Count user-facing provisions created in the given window.
   * Used by the forecast to predict next-period demand.
   * Excludes pool sentinel org rows.
   */
  /**
   * Count an org's NON-TERMINAL (`pending`/`provisioning`/`running`, non-pool)
   * agent sandboxes — the org's live dedicated-container footprint on the fleet.
   * Used by the create path's per-org quota (#11023). Best-effort read; the
   * authoritative check runs under the advisory lock inside createAgent.
   */
  async countNonTerminalByOrganization(organizationId: string): Promise<number> {
    await ensureAgentSandboxSchema();
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.pool_status} is null`,
          sql`${agentSandboxes.status} in ('pending', 'provisioning', 'running')`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Count retained user-owned agent rows for an organization. Used by org-vacate
   * guards where deleting the org would cascade agent state without going
   * through the provisioning teardown path.
   */
  async countRetainedByOrganization(organizationId: string): Promise<number> {
    await ensureAgentSandboxSchema();
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.pool_status} is null`,
          sql`${agentSandboxes.deleted_at} is null`,
        ),
      );
    return row?.count ?? 0;
  }

  async countUserProvisionsSince(sinceMs: number): Promise<number> {
    await ensureAgentSandboxSchema();
    const since = new Date(Date.now() - sinceMs);
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          gte(agentSandboxes.created_at, since),
          sql`${agentSandboxes.organization_id} <> ${WARM_POOL_ORG_ID}`,
          sql`${agentSandboxes.pool_status} is null`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * User provisions per UTC hour over the last `windowHours`, oldest first.
   * Excludes pool sentinel org rows. Used by the forecast.
   */
  async countUserProvisionsByHour(windowHours: number): Promise<number[]> {
    await ensureAgentSandboxSchema();
    if (windowHours <= 0) return [];
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await sqlRows<{ bucket: string; count: number }>(
      dbRead,
      sql`
        SELECT
          to_char(date_trunc('hour', ${agentSandboxes.created_at}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00') as bucket,
          count(*)::int as count
        FROM ${agentSandboxes}
        WHERE ${agentSandboxes.created_at} >= ${since}
          AND ${agentSandboxes.organization_id} <> ${WARM_POOL_ORG_ID}
          AND ${agentSandboxes.pool_status} IS NULL
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    );
    const byBucket = new Map(rows.map((r) => [r.bucket, r.count]));

    const buckets: number[] = [];
    const nowMs = Date.now();
    const startHourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
    for (let i = windowHours - 1; i >= 0; i--) {
      const ms = startHourMs - i * 3_600_000;
      const key = new Date(ms).toISOString().slice(0, 13) + ":00:00";
      buckets.push(byBucket.get(key) ?? 0);
    }
    return buckets;
  }

  /** Claimable rows, ordered by the same FIFO stamp used by the claim path. */
  async listClaimablePool(filter: WarmPoolImageFilter = {}): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbWrite
      .select()
      .from(agentSandboxes)
      .where(and(...claimableWarmPoolConditions(filter)))
      .orderBy(agentSandboxes.pool_ready_at);
  }

  /**
   * Running pool rows that cannot be claimed. A row with complete runtime
   * locators but no readiness stamp can be promoted after a live probe; all
   * other shapes require fenced teardown. The stable creation-time grace
   * prevents a rolling-deploy overlap from reconciling an old worker's
   * still-active restore tail; heartbeat writes cannot postpone genuinely
   * stranded generations because they do not change `created_at`.
   */
  async listWarmPoolReconciliationCandidates(
    minimumGenerationAgeMs: number,
  ): Promise<WarmPoolReconciliationCandidate[]> {
    await ensureAgentSandboxSchema();
    if (!Number.isFinite(minimumGenerationAgeMs) || minimumGenerationAgeMs <= 0) {
      throw new ElizaError("Warm-pool reconciliation age must be positive", {
        code: "WARM_POOL_RECONCILIATION_AGE_INVALID",
        context: { minimumGenerationAgeMs },
        severity: "fatal",
      });
    }
    const createdBefore = new Date(Date.now() - minimumGenerationAgeMs);
    const runtimeReady = and(...warmPoolRuntimeLocatorConditions());
    if (!runtimeReady) {
      throw new ElizaError("Warm-pool runtime predicate was empty", {
        code: "WARM_POOL_PREDICATE_INVALID",
        severity: "fatal",
      });
    }
    return dbWrite
      .select({
        sandbox: agentSandboxes,
        canPromote: sql<boolean>`${agentSandboxes.pool_ready_at} IS NULL AND ${runtimeReady}`,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          eq(agentSandboxes.status, "running"),
          lt(agentSandboxes.created_at, createdBefore),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
          sql`NOT (${and(...warmPoolRuntimeReadyConditions())})`,
        ),
      )
      .orderBy(agentSandboxes.created_at);
  }

  /** All live pool rows used for health reporting and image rollout. */
  async listAllRunningPoolEntries(): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          eq(agentSandboxes.status, "running"),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
        ),
      )
      .orderBy(agentSandboxes.pool_ready_at);
  }

  /**
   * Every retained warm-pool generation that image rollout may classify.
   * Unlike the ready-only status reader, this includes provisioning/error
   * generations and prior failed rollout reservations so a mutable-tag change
   * cannot leave invisible old-digest capacity behind forever.
   */
  async listPoolEntriesForRollout(): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
        ),
      )
      .orderBy(agentSandboxes.pool_ready_at, agentSandboxes.created_at);
  }

  /**
   * Pool rows whose provision never reached the final atomic ready transition.
   * Running rows are reconciled separately without an `updated_at` cutoff
   * because successful heartbeats continually refresh that timestamp.
   */
  async findStuckPoolProvisioning(staleThresholdMs: number): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const cutoff = new Date(Date.now() - staleThresholdMs);
    return dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          inArray(agentSandboxes.status, ["pending", "provisioning", "error", "deletion_failed"]),
          lt(agentSandboxes.updated_at, cutoff),
        ),
      );
  }

  /**
   * Atomically claim a warm pool entry on behalf of a user's pending
   * sandbox row. Uses `FOR UPDATE SKIP LOCKED` so concurrent claims pick
   * different pool rows and never block each other.
   *
   * On success, the user's row inherits all docker infrastructure fields
   * from the pool row, status flips to 'running', and the pool row is
   * deleted in the same transaction.
   *
   * Returns the updated user row — augmented with `warm_pool_row_id`, the id
   * of the pool row deleted by this claim — or null when the pool is empty.
   * The pool row id is otherwise lost with the deletion, but the container's
   * BOOT credentials are named for it (`agent-sandbox:<poolRowId>` inference
   * key), so the post-claim re-key needs it to revoke the pool-org key
   * (#17066 review): the claimed row's own id can never reach that key name.
   */
  async claimWarmContainer(params: {
    userAgentId: string;
    organizationId: string;
    image: string;
    agentName: string;
    agentConfig?: Record<string, unknown>;
    characterId?: string | null;
    expectedLifecycleRevision?: number;
  }): Promise<WarmClaimedAgentSandbox | null> {
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, params.userAgentId));
      await lockOrganizationPolicy(tx, params.organizationId);
      const claimablePool = and(...claimableWarmPoolConditions({ image: params.image }));
      if (!claimablePool) {
        throw new ElizaError("Warm-pool claim predicate was empty", {
          code: "WARM_POOL_PREDICATE_INVALID",
          severity: "fatal",
        });
      }
      // The raw SELECT is retained because SKIP LOCKED is the concurrency
      // primitive: competing claims must choose different rows without waiting.
      // Its eligibility expression is exactly the one used by every capacity
      // reader, so no counted row can be refused here for a hidden requirement.
      const poolRows = await sqlRows<AgentSandbox>(
        tx,
        sql`
          SELECT *
          FROM ${agentSandboxes}
          WHERE ${claimablePool}
          ORDER BY ${agentSandboxes.pool_ready_at} ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
      );
      const pool = poolRows[0];
      if (!pool) {
        const skipped = await sqlRows<{
          count: number;
          missing_bridge: number;
          missing_node: number;
          missing_readiness: number;
        }>(
          tx,
          sql`
            SELECT
              COUNT(*)::int AS count,
              COUNT(*) FILTER (
                WHERE ${agentSandboxes.bridge_url} IS NULL
                   OR btrim(${agentSandboxes.bridge_url}) = ''
              )::int AS missing_bridge,
              COUNT(*) FILTER (
                WHERE ${agentSandboxes.node_id} IS NULL
                   OR btrim(${agentSandboxes.node_id}) = ''
              )::int AS missing_node,
              COUNT(*) FILTER (
                WHERE ${agentSandboxes.pool_ready_at} IS NULL
              )::int AS missing_readiness
            FROM ${agentSandboxes}
            WHERE ${agentSandboxes.organization_id} = ${WARM_POOL_ORG_ID}
              AND ${agentSandboxes.user_id} = ${WARM_POOL_USER_ID}
              AND ${agentSandboxes.pool_status} = 'unclaimed'
              AND ${agentSandboxes.status} = 'running'
              AND ${agentSandboxes.docker_image} = ${params.image}
              AND ${agentSandboxes.deleted_at} IS NULL
              AND NOT (${claimablePool})
          `,
        );
        const skippedRow = skipped[0];
        if (skippedRow && skippedRow.count > 0) {
          logger.warn(
            "[agent-sandbox] Warm-pool claim skipped unclaimable entries; falling through to cold path",
            {
              event: "warm_pool.unclaimable_entries_skipped",
              image: params.image,
              userAgentId: params.userAgentId,
              organizationId: params.organizationId,
              skippedCount: skippedRow.count,
              missingBridgeCount: skippedRow.missing_bridge,
              missingNodeCount: skippedRow.missing_node,
              missingReadinessCount: skippedRow.missing_readiness,
            },
          );
        }
        return null;
      }

      const [userRow] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, params.userAgentId),
            eq(agentSandboxes.organization_id, params.organizationId),
            inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
            isNull(agentSandboxes.pool_status),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("update")
        .limit(1);
      if (!userRow) return null;
      if (!CONTAINER_BACKED_EXECUTION_TIERS.some((tier) => tier === userRow.execution_tier)) {
        return null;
      }

      // Pool claim is for fresh provisions only. If the user's row already
      // has a database, fall through to the existing provision flow which
      // will reuse it. Likewise if it's already running or retains any durable
      // claim-fence state: a failed cleanup must complete and an explicit retry
      // must reset that state before another pool container can be attached.
      if (userRow.database_status === "ready" || userRow.database_uri) return null;
      if (userRow.status === "running") return null;
      if (
        userRow.deletion_attempt_id !== null ||
        userRow.status === "deletion_pending" ||
        userRow.status === "deletion_failed"
      ) {
        return null;
      }
      if (userRow.claimed_at !== null || userRow.warm_claim_credential_state !== null) {
        return null;
      }

      if (
        params.expectedLifecycleRevision !== undefined &&
        userRow.lifecycle_revision !== params.expectedLifecycleRevision
      ) {
        return null;
      }

      await assertProvisionQuota(tx, params.userAgentId, params.organizationId);
      const claimedAt = new Date();
      const [updated] = await tx
        .update(agentSandboxes)
        .set({
          status: "provisioning",
          // Container-boot-coupled env transfer: the pool container is ALREADY
          // RUNNING with the pool row's ELIZA_API_TOKEN (its inbound API auth
          // boundary), and the pool row is deleted in this same transaction.
          // Without carrying that token onto the user's row, every
          // authenticated call to the claimed container (character push,
          // bridge proxy, web UI gate) fails 401 against a token the container
          // never saw. User-provided env keys are preserved; only the keys the
          // container was booted with are overridden.
          environment_vars: mergeWarmClaimEnvironmentVars(
            userRow.environment_vars as Record<string, string> | null,
            pool.environment_vars as Record<string, string> | null,
          ),
          environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
          node_id: pool.node_id,
          container_name: pool.container_name,
          bridge_port: pool.bridge_port,
          web_ui_port: pool.web_ui_port,
          headscale_ip: pool.headscale_ip,
          docker_image: pool.docker_image,
          // The digest is the authoritative pair with docker_image. Dropping
          // it makes the freshly claimed row look stale to the reconciler and
          // impossible to use as an exact-source canary.
          image_digest: pool.image_digest,
          bridge_url: pool.bridge_url,
          health_url: pool.health_url,
          sandbox_id: pool.sandbox_id,
          // Database transfer — pool row's database is now the user's.
          database_uri: pool.database_uri,
          database_status: pool.database_status,
          agent_name: params.agentName,
          agent_config: params.agentConfig ?? userRow.agent_config,
          character_id: params.characterId ?? userRow.character_id,
          claimed_at: claimedAt,
          warm_claim_credential_state: "pending",
          warm_claim_source_pool_id: pool.id,
          warm_claim_key_fingerprint: null,
          warm_claim_attested_at: null,
          warm_claim_attested_environment_revision: null,
          warm_claim_cleanup_completed_at: null,
          updated_at: claimedAt,
          error_message: null,
        })
        .where(
          and(
            eq(agentSandboxes.id, params.userAgentId),
            eq(agentSandboxes.organization_id, params.organizationId),
            inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
            isNull(agentSandboxes.pool_status),
            isNull(agentSandboxes.deleted_at),
            ...(params.expectedLifecycleRevision === undefined
              ? []
              : [eq(agentSandboxes.lifecycle_revision, params.expectedLifecycleRevision)]),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
            sql`${agentSandboxes.status} NOT IN ('deletion_pending', 'deletion_failed')`,
          ),
        )
        .returning();

      if (!updated) return null;
      await tx.delete(agentSandboxes).where(eq(agentSandboxes.id, pool.id));

      // Carry the deleted pool row's id out of the transaction: the container's
      // boot-time inference key is named `agent-sandbox:<pool.id>`, and this is
      // the last moment that id exists anywhere — the post-claim re-key uses it
      // to revoke the pool-org credential (#17066 review).
      return { ...updated, warm_pool_row_id: pool.id };
    });
  }

  /** Insert a pool entry pre-bound to the sentinel pool org. */
  async createPoolEntry(
    data: Omit<
      NewAgentSandbox,
      | "organization_id"
      | "user_id"
      | "pool_status"
      | "execution_tier"
      | "billing_status"
      | "last_billed_at"
      | "hourly_rate"
      | "shutdown_warning_sent_at"
      | "scheduled_shutdown_at"
    >,
  ): Promise<AgentSandbox> {
    await ensureAgentSandboxSchema();
    const [row] = await dbWrite
      .insert(agentSandboxes)
      .values({
        ...data,
        organization_id: WARM_POOL_ORG_ID,
        user_id: WARM_POOL_USER_ID,
        pool_status: "unclaimed",
        // Pool placeholders own a real prewarmed container. Never inherit the
        // schema's container-free Shared default at this creation seam.
        execution_tier: "dedicated-always",
        // The sentinel org owns capacity, not a customer subscription. Keep
        // pool generations outside elapsed charging until a claim transfers
        // infrastructure onto an already-container-backed user row.
        billing_status: "exempt",
        last_billed_at: null,
        hourly_rate: "0.0000",
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
      })
      .returning();
    if (!row) throw new Error("Failed to create warm pool entry");
    return row;
  }

  /** Hard-delete a pool entry by id. Caller is responsible for stopping the container. */
  async deletePoolEntry(id: string): Promise<boolean> {
    await ensureAgentSandboxSchema();
    const r = await dbWrite
      .delete(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, id),
          eq(agentSandboxes.organization_id, WARM_POOL_ORG_ID),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
        ),
      )
      .returning({ id: agentSandboxes.id });
    return r.length > 0;
  }

  /**
   * Commit the final `provisioning` → claimable transition in one write after
   * the container, runtime bootstrap, and restore path have all succeeded.
   */
  async commitPoolEntryReady(
    expected: WarmPoolRuntimeGeneration,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    if (expected.organization_id !== WARM_POOL_ORG_ID || expected.pool_ready_at !== null) {
      return undefined;
    }
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaProvisionAdvisoryLockSql(WARM_POOL_ORG_ID, expected.id));
      const now = new Date();
      const [ready] = await tx
        .update(agentSandboxes)
        .set({
          status: "running",
          pool_ready_at: now,
          last_heartbeat_at: now,
          error_message: null,
          updated_at: now,
        })
        .where(
          and(
            ...warmPoolGenerationConditions(expected),
            eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
            eq(agentSandboxes.pool_status, "unclaimed"),
            eq(agentSandboxes.status, "provisioning"),
            isNull(agentSandboxes.pool_ready_at),
            ...warmPoolRuntimeLocatorConditions(),
          ),
        )
        .returning();
      return ready;
    });
  }

  /**
   * Recover a pre-fix row whose container reached `running` before its readiness
   * stamp was committed. The generation CAS prevents a stale health probe from
   * promoting a replacement container.
   */
  async promoteStrandedPoolEntryReady(
    expected: WarmPoolRuntimeGeneration,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    if (expected.organization_id !== WARM_POOL_ORG_ID || expected.pool_ready_at !== null) {
      return undefined;
    }
    const now = new Date();
    const [ready] = await dbWrite
      .update(agentSandboxes)
      .set({
        pool_ready_at: now,
        last_heartbeat_at: now,
        error_message: null,
        updated_at: now,
      })
      .where(
        and(
          ...warmPoolGenerationConditions(expected),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          eq(agentSandboxes.status, "running"),
          isNull(agentSandboxes.pool_ready_at),
          ...warmPoolRuntimeLocatorConditions(),
        ),
      )
      .returning();
    return ready;
  }

  /**
   * Fence an unclaimable generation before remote teardown. A concurrent ready
   * commit or locator change makes the CAS lose, so reconciliation never
   * destroys a row based on a stale probe.
   */
  async reserveUnclaimablePoolEntryForReap(
    expected: WarmPoolRuntimeGeneration,
    reason: string,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    if (expected.organization_id !== WARM_POOL_ORG_ID) return undefined;
    const [reserved] = await dbWrite
      .update(agentSandboxes)
      .set({
        // `deletion_failed` is deliberately outside trySetProvisioning's
        // admitted states. deleteAgent can take ownership from it, while a
        // provision retry cannot revive the fenced generation first.
        status: "deletion_failed",
        error_message: reason,
        updated_at: new Date(),
      })
      .where(
        and(
          ...warmPoolGenerationConditions(expected),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          eq(agentSandboxes.status, "running"),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
          sql`NOT (${and(...warmPoolRuntimeReadyConditions())})`,
        ),
      )
      .returning();
    return reserved;
  }

  /**
   * Fence one exact stale image generation before rollout tears down its
   * remote container. The generation CAS closes both races that matter:
   * a concurrent claim deletes the pool row first and this returns undefined,
   * while a successful reservation moves the row out of `running` before the
   * claim query can transfer it. A prior failed teardown may reserve again on
   * the next sweep because `deletion_failed` remains a retained pool row.
   */
  async reserveStalePoolEntryForRollout(
    expected: WarmPoolRuntimeGeneration,
    targetDigest: string,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    if (!CANONICAL_SHA256_IMAGE_DIGEST_RE.test(targetDigest)) {
      throw new ElizaError("Warm-pool rollout target digest must be canonical sha256", {
        code: "WARM_POOL_ROLLOUT_DIGEST_INVALID",
        context: { targetDigest },
        severity: "fatal",
      });
    }
    if (expected.organization_id !== WARM_POOL_ORG_ID || expected.image_digest === targetDigest) {
      return undefined;
    }
    const [reserved] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "deletion_failed",
        error_message: `Warm-pool image rollout reserved stale generation for ${targetDigest}`,
        updated_at: new Date(),
      })
      .where(
        and(
          ...warmPoolGenerationConditions(expected),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          sql`${agentSandboxes.image_digest} IS DISTINCT FROM ${targetDigest}`,
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
        ),
      )
      .returning();
    return reserved;
  }

  /**
   * Fence a stale non-running provision before its remote resources are
   * destroyed. The cutoff and generation are rechecked in the write, closing
   * the finder → teardown race with a legitimate provision retry.
   */
  async reserveStuckPoolEntryForReap(
    expected: WarmPoolRuntimeGeneration,
    staleThresholdMs: number,
  ): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    if (expected.organization_id !== WARM_POOL_ORG_ID) return undefined;
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const [reserved] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "deletion_failed",
        error_message: "Warm-pool provision exceeded its reconciliation deadline",
        updated_at: new Date(),
      })
      .where(
        and(
          ...warmPoolGenerationConditions(expected),
          eq(agentSandboxes.user_id, WARM_POOL_USER_ID),
          eq(agentSandboxes.pool_status, "unclaimed"),
          inArray(agentSandboxes.status, ["pending", "provisioning", "error", "deletion_failed"]),
          lt(agentSandboxes.updated_at, cutoff),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.deletion_attempt_id),
        ),
      )
      .returning();
    return reserved;
  }

  // Backups

  /**
   * Revalidate an unlocked retry candidate inside the lifecycle transaction.
   * The row must still be this agent's attached, full pre-delete capture and
   * must have been created for the current deletion intent.
   */
  async validateAttachedPreDeleteBackupForDeletion(
    tx: DbTransaction,
    params: {
      backupId: string;
      sandboxRecordId: string;
      deletionStartedAt: Date;
    },
  ): Promise<boolean> {
    const [backup] = await tx
      .select({ id: agentSandboxBackups.id })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.sandbox_record_id, params.sandboxRecordId),
          eq(agentSandboxBackups.snapshot_type, "pre-delete"),
          eq(agentSandboxBackups.backup_kind, "full"),
          isNull(agentSandboxBackups.parent_backup_id),
          gte(agentSandboxBackups.created_at, params.deletionStartedAt),
          isNull(agentSandboxBackups.recovery_organization_id),
          isNull(agentSandboxBackups.recovery_agent_id),
          isNull(agentSandboxBackups.recovery_deletion_attempt_id),
          isNull(agentSandboxBackups.recovery_expires_at),
          backupVisibleToLegacyReaders(),
        ),
      )
      .limit(1);
    return backup !== undefined;
  }

  /**
   * Mark the exact legacy pre-delete snapshot as the user-visible recovery
   * point while the sandbox row is locked. Other legacy rows retain their
   * historical cascade behavior; v2 catalogue rows block sandbox deletion
   * until the lifecycle coordinator hands them to exact-object GC.
   */
  async retainPreDeleteBackupForDeletedAgent(
    tx: DbTransaction,
    params: {
      backupId: string;
      sandboxRecordId: string;
      organizationId: string;
      deletionAttemptId: string;
      deletionStartedAt: Date;
      expiresAt: Date;
    },
  ): Promise<boolean> {
    const [retained] = await tx
      .update(agentSandboxBackups)
      .set({
        sandbox_record_id: null,
        recovery_organization_id: params.organizationId,
        recovery_agent_id: params.sandboxRecordId,
        recovery_deletion_attempt_id: params.deletionAttemptId,
        recovery_expires_at: params.expiresAt,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.sandbox_record_id, params.sandboxRecordId),
          eq(agentSandboxBackups.snapshot_type, "pre-delete"),
          eq(agentSandboxBackups.backup_kind, "full"),
          isNull(agentSandboxBackups.parent_backup_id),
          gte(agentSandboxBackups.created_at, params.deletionStartedAt),
          isNull(agentSandboxBackups.recovery_organization_id),
          isNull(agentSandboxBackups.recovery_agent_id),
          isNull(agentSandboxBackups.recovery_deletion_attempt_id),
          isNull(agentSandboxBackups.recovery_expires_at),
          backupVisibleToLegacyReaders(),
        ),
      )
      .returning({ id: agentSandboxBackups.id });
    return retained !== undefined;
  }

  /** Return the newest unexpired recovery point visible to this organization. */
  async getPreDeleteRecoveryBackup(
    organizationId: string,
    deletedAgentId: string,
    now = new Date(),
  ): Promise<AgentSandboxBackup | undefined> {
    const [row] = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          isNull(agentSandboxBackups.sandbox_record_id),
          eq(agentSandboxBackups.snapshot_type, "pre-delete"),
          eq(agentSandboxBackups.recovery_organization_id, organizationId),
          eq(agentSandboxBackups.recovery_agent_id, deletedAgentId),
          gt(agentSandboxBackups.recovery_expires_at, now),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(1);
    return row ? await hydrateAgentSandboxBackup(row) : undefined;
  }

  /**
   * Delete a bounded batch of expired detached recovery rows. Offloaded bytes
   * are removed first; a storage failure leaves the row for a later retry.
   */
  async cleanupExpiredPreDeleteRecoveryBackups(
    now = new Date(),
    limit = PRE_DELETE_BACKUP_CLEANUP_BATCH_SIZE,
  ): Promise<PreDeleteBackupCleanupResult> {
    const boundedLimit = Math.max(1, Math.min(limit, PRE_DELETE_BACKUP_CLEANUP_BATCH_SIZE));
    const candidates = await dbRead
      .select({
        id: agentSandboxBackups.id,
        stateDataStorage: agentSandboxBackups.state_data_storage,
        stateDataKey: agentSandboxBackups.state_data_key,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          isNull(agentSandboxBackups.sandbox_record_id),
          eq(agentSandboxBackups.snapshot_type, "pre-delete"),
          isNotNull(agentSandboxBackups.recovery_organization_id),
          isNotNull(agentSandboxBackups.recovery_agent_id),
          isNotNull(agentSandboxBackups.recovery_deletion_attempt_id),
          lte(agentSandboxBackups.recovery_expires_at, now),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(agentSandboxBackups.recovery_expires_at)
      .limit(boundedLimit);

    let deletedRows = 0;
    let deletedObjects = 0;
    let failedRows = 0;
    let invalidRows = 0;
    for (const candidate of candidates) {
      if (candidate.stateDataStorage === "r2") {
        if (!candidate.stateDataKey) {
          // This row can never become retryable: no object key exists to recover.
          // Remove the expired metadata row so it cannot poison every oldest-first
          // batch forever, but account and alert on the invariant violation.
          invalidRows += 1;
          logger.error(
            "Expired recovery backup is missing its object-storage key; discarding invalid row",
            { backupId: logger.redact.id(candidate.id) },
          );
        } else {
          try {
            await deleteLegacyObject(candidate.stateDataKey);
            deletedObjects += 1;
          } catch (error) {
            // error-policy:J1 the bounded cleanup boundary retains this row for
            // retry, records the failure, and continues with later candidates.
            failedRows += 1;
            logger.error(
              "Failed to delete expired recovery backup object; retaining row for retry",
              {
                backupId: logger.redact.id(candidate.id),
                errorType: error instanceof Error ? error.name : typeof error,
              },
            );
            continue;
          }
        }
      }

      try {
        const removed = await dbWrite
          .delete(agentSandboxBackups)
          .where(
            and(
              eq(agentSandboxBackups.id, candidate.id),
              isNull(agentSandboxBackups.sandbox_record_id),
              lte(agentSandboxBackups.recovery_expires_at, now),
            ),
          )
          .returning({ id: agentSandboxBackups.id });
        deletedRows += removed.length;
      } catch (error) {
        // error-policy:J1 the bounded cleanup boundary reports this candidate
        // as failed and continues without fabricating a successful deletion.
        failedRows += 1;
        logger.error("Failed to delete expired recovery backup row; continuing batch", {
          backupId: logger.redact.id(candidate.id),
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    return { deletedRows, deletedObjects, failedRows, invalidRows };
  }

  async createBackup(data: NewAgentSandboxBackup): Promise<AgentSandboxBackup> {
    const insertData = await prepareAgentBackupInsertData(data);
    const [r] = await dbWrite.insert(agentSandboxBackups).values(insertData).returning();
    if (!r) throw new Error("Failed to create backup");
    return await hydrateAgentSandboxBackup(r);
  }

  async listBackups(sandboxRecordId: string, limit = 10): Promise<AgentSandboxBackup[]> {
    const rows = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
      .limit(limit);
    return await Promise.all(rows.map(hydrateAgentSandboxBackup));
  }

  async listBackupMetadata(
    sandboxRecordId: string,
    limit = 10,
  ): Promise<AgentSandboxBackupMetadata[]> {
    return await dbRead
      .select({
        id: agentSandboxBackups.id,
        sandbox_record_id: agentSandboxBackups.sandbox_record_id,
        snapshot_type: agentSandboxBackups.snapshot_type,
        state_data_storage: agentSandboxBackups.state_data_storage,
        state_data_key: agentSandboxBackups.state_data_key,
        size_bytes: agentSandboxBackups.size_bytes,
        backup_kind: agentSandboxBackups.backup_kind,
        parent_backup_id: agentSandboxBackups.parent_backup_id,
        content_hash: agentSandboxBackups.content_hash,
        verification_status: agentSandboxBackups.verification_status,
        verified_at: agentSandboxBackups.verified_at,
        verification_error: agentSandboxBackups.verification_error,
        recovery_organization_id: agentSandboxBackups.recovery_organization_id,
        recovery_agent_id: agentSandboxBackups.recovery_agent_id,
        recovery_deletion_attempt_id: agentSandboxBackups.recovery_deletion_attempt_id,
        recovery_expires_at: agentSandboxBackups.recovery_expires_at,
        created_at: agentSandboxBackups.created_at,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
      .limit(limit);
  }

  async getLatestBackup(sandboxRecordId: string): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
      .limit(1);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  /**
   * The newest backup of a given `snapshot_type` for a sandbox. Used by
   * `executeDowngrade` to find the `pre-upgrade` restore point captured right
   * before the most recent fleet upgrade.
   */
  async getLatestBackupByType(
    sandboxRecordId: string,
    snapshotType: AgentBackupSnapshotType,
  ): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          eq(agentSandboxBackups.snapshot_type, snapshotType),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(1);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  async getBackupById(backupId: string): Promise<AgentSandboxBackup | undefined> {
    const r = await getStoredBackupById(backupId);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  /**
   * The stored (still-encrypted, possibly R2-offloaded) backup row, un-hydrated.
   * The wake restore-integrity gate feeds these to `verifyBackupRestorability`,
   * which does its own budgeted download + decrypt — hydrating here would
   * decrypt the payload eagerly and bypass the verifier's byte budget.
   */
  async getStoredBackupById(backupId: string): Promise<StoredAgentSandboxBackup | undefined> {
    return getStoredBackupById(backupId);
  }

  /** Newest stored (still-encrypted) backup row for a sandbox, un-hydrated. */
  async getLatestStoredBackup(
    sandboxRecordId: string,
  ): Promise<StoredAgentSandboxBackup | undefined> {
    // The head is used to bind destructive fresh-boot consent. Reading it from
    // a replica could bind consent to B1 while primary already contains B2.
    const [row] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          backupVisibleToLegacyReaders(),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
      .limit(1);
    return row;
  }

  /**
   * Stamp a verification outcome on a backup row. Field semantics match the
   * continuous verifier cycle (`agent-backup-verifier.ts`): `verified_at`
   * records the attempt time; `verification_error` is `null` on success and
   * `"<kind>: <message>"` on failure, so wake-gate stamps and cycle stamps are
   * indistinguishable to readers.
   */
  async stampBackupVerification(
    backupId: string,
    outcome: { status: "verified" | "failed"; verifiedAt: Date; error: string | null },
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxBackups)
      .set({
        verification_status: outcome.status,
        verified_at: outcome.verifiedAt,
        verification_error: outcome.error,
      })
      .where(and(eq(agentSandboxBackups.id, backupId), backupVisibleToLegacyReaders()));
  }

  /**
   * Chain-safe prune: keep the newest `keep` restore points plus every
   * ancestor any retained incremental still needs, then delete the rest. This
   * can never strand an incremental backup without the full backup it builds
   * on. See `selectPrunableBackupIds`.
   */
  async pruneBackups(sandboxRecordId: string, keep: number): Promise<number> {
    const all = await dbRead
      .select({
        id: agentSandboxBackups.id,
        backupKind: agentSandboxBackups.backup_kind,
        parentBackupId: agentSandboxBackups.parent_backup_id,
        createdAt: agentSandboxBackups.created_at,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          backupVisibleToLegacyReaders(),
          eq(agentSandboxBackups.state_data_storage, "inline"),
        ),
      );
    if (all.length <= keep) return 0;
    const nodes: BackupChainNode[] = all.map((b) => ({
      id: b.id,
      backupKind: b.backupKind,
      parentBackupId: b.parentBackupId,
      createdAtMs: b.createdAt.getTime(),
    }));
    const ids = selectPrunableBackupIds(nodes, keep);
    if (ids.length === 0) return 0;
    const r = await dbWrite
      .delete(agentSandboxBackups)
      .where(inArray(agentSandboxBackups.id, ids))
      .returning({ id: agentSandboxBackups.id });
    return r.length;
  }

  /**
   * Reconstruct the full agent state for a backup. For `full` backups this is
   * the stored state verbatim; for `incremental` backups it replays the parent
   * chain (oldest full → … → target) applying each delta. All consumers that
   * need state to restore (provision auto-restore, `restore()`) MUST go through
   * here so incrementals are transparently materialized.
   */
  async getReconstructedBackupState(backupId: string): Promise<AgentBackupStateData | undefined> {
    const targetStored = await getStoredBackupById(backupId);
    if (!targetStored) return undefined;
    const chain: AgentSandboxBackup[] = [];
    const seen = new Set<string>();
    let chainBytes = 0;
    let cursor: StoredAgentSandboxBackup | undefined = targetStored;
    while (cursor) {
      if (seen.has(cursor.id)) throw new Error(`Backup chain cycle at ${cursor.id}`);
      seen.add(cursor.id);
      if (cursor.sandbox_record_id !== targetStored.sandbox_record_id) {
        throw new Error(`Backup chain row ${cursor.id} crosses sandbox boundary`);
      }
      chainBytes +=
        cursor.size_bytes ?? Buffer.byteLength(JSON.stringify(cursor.state_data), "utf8");
      if (chainBytes > MAX_RECONSTRUCTED_BACKUP_CHAIN_BYTES) {
        // Typed so the restore sites can tell "too large to apply" from "gone":
        // the chain is intact and decryptable, so this must fail the provision
        // closed rather than degrade to an empty boot, and it must never prune.
        throw new SnapshotPayloadTooLargeError(chainBytes, MAX_RECONSTRUCTED_BACKUP_CHAIN_BYTES);
      }
      chain.push(await hydrateAgentSandboxBackup(cursor));
      if (cursor.backup_kind === "full") break;
      if (!cursor.parent_backup_id) {
        throw new Error(`Incremental backup ${cursor.id} has no parent`);
      }
      if (chain.length > MAX_RECONSTRUCTED_BACKUP_CHAIN_DEPTH) {
        throw new Error(
          `Backup chain for ${backupId} exceeds ${MAX_RECONSTRUCTED_BACKUP_CHAIN_DEPTH} rows`,
        );
      }
      const parentBackupId = cursor.parent_backup_id;
      cursor = await getStoredBackupById(parentBackupId);
      if (!cursor) throw new Error(`Backup chain references missing backup ${parentBackupId}`);
    }
    chain.reverse();
    let state: AgentBackupStateData | undefined;
    for (const row of chain) {
      if (row.backup_kind === "full") {
        state = requireBackupStateData(row.state_data, row.id);
      } else {
        if (!state) throw new Error(`Incremental ${row.id} reached before a full backup`);
        state = applyBackupDelta(state, requireBackupDelta(row.state_data, row.id));
      }
    }
    return state;
  }

  /**
   * Spend recorded allocation ownership and give the node its slot back, in one
   * transaction (#17185).
   *
   * The flag flip and the decrement commit together so they can never disagree:
   * whoever wins the row lock consumes the ownership, and every later caller
   * matches no row and decrements nothing. Callers differ only in `claimWhere`,
   * which is the fence deciding WHO is entitled to spend it.
   *
   * `allocated_count > 0` is a guard rather than `GREATEST(... , 0)` clamping,
   * so an unexpected underflow leaves the counter untouched and visible instead
   * of being silently absorbed.
   *
   * @returns the release outcome and, when ownership was consumed, the
   * post-trigger lifecycle revision. `counter-unchanged` also warns: ownership
   * was ours to spend, but the node counter did not move — either it was
   * already 0 or the `docker_nodes` row is gone, and in both cases there is no
   * slot left to give back, so committing the flip is correct.
   */
  private async spendDeletionAllocation(
    nodeId: string,
    claimWhere: SQL,
  ): Promise<DeletionAllocationSpendResult> {
    // Memoized per database URL, so this is a settled-promise await after the
    // first call in an isolate rather than DDL on every teardown. It stays on
    // this path because the deletion writers can reach the column before the
    // migration has run — `deploy-eliza-provisioning-worker.yml` has no
    // `migrate-db` gate.
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      const [claimed] = await tx
        .update(agentSandboxes)
        .set({ deletion_allocation_counted: false, updated_at: new Date() })
        .where(and(claimWhere, eq(agentSandboxes.deletion_allocation_counted, true)))
        .returning({
          id: agentSandboxes.id,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        });
      if (!claimed) return { outcome: "not-owned", lifecycleRevision: null };

      const decremented = await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`${dockerNodes.allocated_count} - 1`,
          updated_at: new Date(),
        })
        .where(and(eq(dockerNodes.node_id, nodeId), gt(dockerNodes.allocated_count, 0)))
        .returning({ nodeId: dockerNodes.node_id });
      if (decremented.length === 0) {
        // Committing the flip is still correct. Either the counter was already
        // 0, or the `docker_nodes` row is gone — and when the row goes its
        // `allocated_count` goes with it, so there is no counter left to leak
        // into. A transiently-absent node self-heals anyway: `syncAllocatedCounts`
        // recomputes from surviving rows, and the error direction only ever
        // under-packs a node, never over-packs one.
        logger.warn(
          `[agent-sandboxes] Deletion allocation ownership consumed for node ${nodeId} but allocated_count was not decremented — counter already at 0 or node row missing`,
        );
        return {
          outcome: "counter-unchanged",
          lifecycleRevision: claimed.lifecycleRevision,
        };
      }
      return { outcome: "released", lifecycleRevision: claimed.lifecycleRevision };
    });
  }

  /**
   * Release the slot held by ONE deletion generation, at most once.
   *
   * Fenced on the whole locator, not just the row id: a superseded generation,
   * another organization, or a row that has since moved nodes must not release
   * the current node's capacity. This is what makes a re-claimed delete job
   * (crash-retry, or a post-stop credential/row-delete/job-status failure) a
   * no-op instead of a second decrement freeing a live sibling's slot.
   */
  async tryReleaseDeletionAllocation(
    agentId: string,
    orgId: string,
    deletionAttemptId: string,
    nodeId: string,
  ): Promise<DeletionAllocationRelease> {
    const result = await this.spendDeletionAllocation(
      nodeId,
      and(
        eq(agentSandboxes.id, agentId),
        eq(agentSandboxes.organization_id, orgId),
        eq(agentSandboxes.deletion_attempt_id, deletionAttemptId),
        eq(agentSandboxes.node_id, nodeId),
      ) as SQL,
    );
    return result.outcome;
  }

  /**
   * Release allocation ownership for the exact prepared lifecycle generation
   * and return the post-trigger revision needed by the row-delete CAS.
   */
  async tryReleaseDeletionAllocationForCommit(
    agentId: string,
    orgId: string,
    deletionAttemptId: string,
    nodeId: string,
    expectedLifecycleRevision: number,
  ): Promise<DeletionAllocationSpendResult> {
    return this.spendDeletionAllocation(
      nodeId,
      and(
        eq(agentSandboxes.id, agentId),
        eq(agentSandboxes.organization_id, orgId),
        eq(agentSandboxes.deletion_attempt_id, deletionAttemptId),
        eq(agentSandboxes.node_id, nodeId),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
      ) as SQL,
    );
  }

  /**
   * Release a held slot once the orphan reconciler has PROVEN the container is
   * gone.
   *
   * The delete path deliberately keeps ownership when it cannot prove absence —
   * a bounded timeout abandons a container that may still be running, and a
   * `deletion_failed` row's container is by definition still out there. Without
   * this the slot would stay counted forever once `reEnqueueFailedDeletions`
   * hits its circuit breaker, permanently shrinking the node and inflating the
   * autoscaler's view of demand (the #15378 regression).
   *
   * Unfenced by generation on purpose: the reaper observed the container's
   * absence directly, which supersedes whichever deletion attempt was in
   * flight. The node is still matched, so a row since re-placed elsewhere
   * cannot have the wrong node's capacity released.
   *
   * The missing `organization_id` predicate is deliberate and not a weaker
   * fence: `agent_sandboxes.id` is the primary key, so scoping by org selects
   * the same row or none. `tryReleaseDeletionAllocation` carries it because its
   * caller holds an org-scoped request context and passing it through keeps the
   * tenant boundary explicit at that entry point; the reaper has no such
   * context, having started from a container name on a node.
   */
  async releaseDeletionAllocationOnReap(
    agentId: string,
    nodeId: string,
  ): Promise<DeletionAllocationRelease> {
    const result = await this.spendDeletionAllocation(
      nodeId,
      and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.node_id, nodeId)) as SQL,
    );
    // The reaper has proved this workload absent on the named node. A retained
    // bridge/health locator would make the recovery delete try to capture from
    // that dead generation again, permanently stranding the tombstone. Clear
    // only the network locators, fenced to the same node and terminal delete
    // states; the remaining container/node identity stays available for audit.
    await dbWrite
      .update(agentSandboxes)
      .set({ bridge_url: null, health_url: null, updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, agentId),
          eq(agentSandboxes.node_id, nodeId),
          inArray(agentSandboxes.status, ["deletion_pending", "deletion_failed"]),
        ),
      );
    return result.outcome;
  }
}

export const agentSandboxesRepository = new AgentSandboxesRepository();
