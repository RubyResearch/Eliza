/**
 * Commits a reviewed family deletion and its remaining private-file work atomically.
 * Derived database content disappears at revocation; a durable identity-only journal
 * survives interruption before file and backup cleanup. Shared records are retained.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolveStateDir } from "@elizaos/agent/config/paths";
import {
  purgeAdmittedRetiredLocalAgentBackups,
  type RetiredLocalAgentBackup,
  withReviewedRetiredLocalAgentBackups,
} from "@elizaos/agent/services/agent-backup";
import { withAgentBackupAuthority } from "@elizaos/agent/services/agent-backup-authority";
import {
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  ServiceType,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlQuote,
  withTransaction,
} from "../sql.js";
import {
  familyDeletionJobSchema as deletionJob,
  type FamilyBackupCleanupReview,
  type FamilyDeletionJob,
  familyBackupRetentionSchema as retention,
} from "./deletion-contracts.js";
import {
  purgeReviewedFamilyDatabaseRows,
  withReviewedFamilyDeletionDatabase,
} from "./deletion-database-snapshot.js";
import { fenceFamilyWorkspace } from "./workspace-operation-store.js";

export type { FamilyDeletionJob } from "./deletion-contracts.js";

const table = "app_lifeops.life_family_workspace_deletions";

function requireOwner(ownerEntityId: string) {
  if (ownerEntityId !== SELF_ENTITY_ID)
    throw new ElizaError(
      "[FamilyDeletion] Only the owner may delete the workspace",
      { code: "FAMILY_DELETION_ACCESS_DENIED" },
    );
}

async function ensureStore(runtime: IAgentRuntime) {
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS ${table} (
    agent_id TEXT PRIMARY KEY, job_json JSONB NOT NULL
  )`,
  );
}

export async function readFamilyDeletionJob(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyDeletionJob | null> {
  requireOwner(ownerEntityId);
  await ensureStore(runtime);
  const rows = await executeRawSql(
    runtime,
    `SELECT job_json FROM ${table} WHERE agent_id=${sqlQuote(runtime.agentId)}`,
  );
  if (rows.length === 0) return null;
  return deletionJob.parse(rows[0].job_json);
}

/** Confirmation is bound to the complete reviewed snapshot and an explicit backup policy. */
export async function beginFamilyWorkspaceDeletion(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    expectedSha256: string;
    backupRetention: z.infer<typeof retention>;
  },
): Promise<FamilyDeletionJob> {
  requireOwner(input.ownerEntityId);
  const backupRetention = retention.parse(input.backupRetention);
  await ensureStore(runtime);
  try {
    return await withAgentBackupAuthority(
      resolveStateDir(),
      async (authority) => {
        const existing = await readFamilyDeletionJob(
          runtime,
          input.ownerEntityId,
        );
        if (existing) {
          if (
            existing.reviewedSha256 !== input.expectedSha256 ||
            existing.backupRetention !== backupRetention
          )
            throw new ElizaError(
              "[FamilyDeletion] A different reviewed deletion is already pending",
              { code: "FAMILY_DELETION_PREVIEW_STALE" },
            );
          return existing;
        }
        const pending = await authority.pendingRetirement(runtime.agentId);
        if (pending?.operationId.startsWith("family-workspace:")) {
          // A canonical absent journal proves the prior atomic transaction did not commit.
          // Keep its old snapshots retired, then allow a newly reviewed attempt.
          await authority.completeRetirement(
            runtime.agentId,
            pending.operationId,
            pending.generation,
          );
        }
        return withReviewedFamilyDeletionDatabase(
          runtime,
          input,
          async (tx, snapshot) => {
            const files = snapshot.records
              .filter((record) => record.kind === "agreements")
              .map((record) => ({
                fileName: z
                  .string()
                  .min(1)
                  .parse(record.identity.media_file_name),
                sha256: deletionJob.shape.reviewedSha256.parse(
                  record.identity.content_sha256,
                ),
              }));
            if (files.length) {
              const documentIds = snapshot.records
                .filter((record) => record.kind === "agreements")
                .map((record) => z.string().parse(record.identity.document_id));
              const shared = await executeRawSqlTx(
                tx,
                `SELECT 1 FROM app_lifeops.life_household_agreement_artifacts WHERE agent_id<>${sqlQuote(runtime.agentId)} AND (media_file_name IN (${files.map((file) => sqlQuote(file.fileName)).join(",")}) OR document_id IN (${documentIds.map(sqlQuote).join(",")})) LIMIT 1`,
              );
              if (shared.length)
                throw new ElizaError(
                  "[FamilyDeletion] A source is still referenced by another workspace",
                  { code: "FAMILY_DELETION_SHARED_SOURCE" },
                );
            }
            const retained = new Map<string, number>();
            for (const record of snapshot.records) {
              if (record.classification !== "owned")
                retained.set(record.kind, (retained.get(record.kind) ?? 0) + 1);
            }
            const backupOperationId = `family-workspace:${snapshot.sha256}`;
            const backupGeneration = await authority.retire(
              runtime.agentId,
              backupOperationId,
            );
            await fenceFamilyWorkspace(tx, runtime.agentId);
            const databaseRowsRemoved = await purgeReviewedFamilyDatabaseRows(
              tx,
              snapshot,
            );
            const job: FamilyDeletionJob = {
              id: randomUUID(),
              agentId: runtime.agentId,
              reviewedSha256: snapshot.sha256,
              startedAt: new Date().toISOString(),
              state: "purge_pending",
              backupRetention,
              backupGeneration,
              backupOperationId,
              files,
              databaseRowsRemoved,
              retained: [...retained].map(([kind, count]) => ({ kind, count })),
            };
            await executeRawSqlTx(
              tx,
              `INSERT INTO ${table} (agent_id,job_json) VALUES (${sqlQuote(runtime.agentId)},${sqlQuote(JSON.stringify(job))}::jsonb)`,
            );
            return job;
          },
        );
      },
    );
  } catch (cause) {
    // error-policy:J2 Keep SQL payloads out of the public deletion failure while preserving the cause.
    if (cause instanceof ElizaError) throw cause;
    throw new ElizaError(
      "[FamilyDeletion] The deletion transaction did not complete",
      { code: "FAMILY_DELETION_TRANSACTION_FAILED", cause },
    );
  }
}

/** Verify private-byte removal before advancing; a lost acknowledgement remains safely retryable. */
export async function purgeFamilyWorkspaceFiles(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyDeletionJob> {
  requireOwner(ownerEntityId);
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const job = await readFamilyDeletionJob(runtime, ownerEntityId);
    if (!job)
      throw new ElizaError("[FamilyDeletion] No deletion is pending", {
        code: "FAMILY_DELETION_NOT_FOUND",
      });
    const pending = await authority.pendingRetirement(runtime.agentId);
    if (
      pending?.generation !== job.backupGeneration ||
      pending.operationId !== job.backupOperationId
    ) {
      if (
        job.state !== "purge_pending" &&
        (await authority.generation(runtime.agentId)) === job.backupGeneration
      )
        return job;
      throw new ElizaError(
        "[FamilyDeletion] Backup authority does not match the deletion journal",
        { code: "FAMILY_DELETION_BACKUP_MISMATCH" },
      );
    }
    const updated = await purgeFamilyWorkspaceFilesLocked(runtime);
    await authority.completeRetirement(
      runtime.agentId,
      job.backupOperationId,
      job.backupGeneration,
    );
    return updated;
  });
}

async function purgeFamilyWorkspaceFilesLocked(
  runtime: IAgentRuntime,
): Promise<FamilyDeletionJob> {
  const storage = runtime.getService<IFileStorageService>(
    ServiceType.REMOTE_FILES,
  );
  if (!storage)
    throw new ElizaError(
      "[FamilyDeletion] Private file storage is unavailable",
      { code: "FAMILY_DELETION_STORAGE_UNAVAILABLE" },
    );
  await ensureStore(runtime);
  try {
    return await withTransaction(runtime, async (tx) => {
      // The same ordering as admission keeps source references stable through file removal.
      await executeRawSqlTx(
        tx,
        "LOCK TABLE app_lifeops.life_household_agreement_artifacts IN SHARE ROW EXCLUSIVE MODE",
      );
      const rows = await executeRawSqlTx(
        tx,
        `SELECT job_json FROM ${table} WHERE agent_id=${sqlQuote(runtime.agentId)} FOR UPDATE`,
      );
      if (rows.length !== 1)
        throw new ElizaError("[FamilyDeletion] No deletion is pending", {
          code: "FAMILY_DELETION_NOT_FOUND",
        });
      const job = deletionJob.parse(rows[0].job_json);
      if (job.state !== "purge_pending") return job;
      for (const file of job.files) {
        const references = await executeRawSqlTx(
          tx,
          `SELECT 1 FROM app_lifeops.life_household_agreement_artifacts WHERE media_file_name=${sqlQuote(file.fileName)} LIMIT 1`,
        );
        if (references.length)
          throw new ElizaError(
            "[FamilyDeletion] A private file is still referenced",
            { code: "FAMILY_DELETION_SHARED_SOURCE" },
          );
        const bytes = await storage.readPrivate(file.fileName);
        if (bytes !== null) {
          if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
            throw new ElizaError(
              "[FamilyDeletion] Private file content changed; reconcile it before deletion",
              { code: "FAMILY_DELETION_FILE_CHANGED" },
            );
          await storage.deletePrivate(file.fileName);
        }
        if ((await storage.readPrivate(file.fileName)) !== null)
          throw new ElizaError(
            "[FamilyDeletion] Private file removal could not be verified",
            { code: "FAMILY_DELETION_FILE_PURGE_FAILED" },
          );
      }
      const updated: FamilyDeletionJob = { ...job, state: "backup_pending" };
      await executeRawSqlTx(
        tx,
        `UPDATE ${table} SET job_json=${sqlQuote(JSON.stringify(updated))}::jsonb WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      return updated;
    });
  } catch (cause) {
    // error-policy:J2 Preserve the pending journal when storage or acknowledgement fails.
    if (cause instanceof ElizaError) throw cause;
    throw new ElizaError(
      "[FamilyDeletion] Private file cleanup is incomplete; retry to reconcile it",
      { code: "FAMILY_DELETION_FILE_PURGE_FAILED", cause },
    );
  }
}

function buildBackupCleanupReview(
  job: FamilyDeletionJob,
  inventory: { generation: string; archives: RetiredLocalAgentBackup[] },
): FamilyBackupCleanupReview {
  if (
    job.state === "purge_pending" ||
    job.backupGeneration !== inventory.generation
  )
    throw new ElizaError(
      "[FamilyDeletion] Reconcile primary deletion before reviewing backup cleanup",
      {
        code: "FAMILY_DELETION_BACKUP_MISMATCH",
      },
    );
  const days = { immediate: 0, "7-days": 7, "30-days": 30 }[
    job.backupRetention
  ];
  const payload = {
    jobId: job.id,
    generation: inventory.generation,
    notBefore: new Date(
      Date.parse(job.startedAt) + days * 86_400_000,
    ).toISOString(),
    archives: inventory.archives,
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

async function requireDeletionJob(
  runtime: IAgentRuntime,
  ownerEntityId: string,
) {
  const job = await readFamilyDeletionJob(runtime, ownerEntityId);
  if (!job)
    throw new ElizaError("[FamilyDeletion] No deletion is pending", {
      code: "FAMILY_DELETION_NOT_FOUND",
    });
  return job;
}

/** Whole-agent archive removal has its own complete owner review and acknowledgement. */
export async function previewFamilyBackupCleanup(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyBackupCleanupReview> {
  requireOwner(ownerEntityId);
  return withReviewedRetiredLocalAgentBackups(
    runtime.agentId,
    async (inventory) =>
      buildBackupCleanupReview(
        await requireDeletionJob(runtime, ownerEntityId),
        inventory,
      ),
  );
}

/** Persist exact archive identities before physical removal can begin. */
export async function admitFamilyBackupCleanup(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    expectedSha256: string;
    acknowledgeWholeArchiveHistory: true;
  },
): Promise<FamilyDeletionJob> {
  requireOwner(input.ownerEntityId);
  z.literal(true).parse(input.acknowledgeWholeArchiveHistory);
  const admitted = await withReviewedRetiredLocalAgentBackups(
    runtime.agentId,
    async (inventory) => {
      const job = await requireDeletionJob(runtime, input.ownerEntityId);
      if (job.backupCleanup?.sha256 === input.expectedSha256) return job;
      const review = buildBackupCleanupReview(job, inventory);
      if (job.state === "complete" || review.sha256 !== input.expectedSha256)
        throw new ElizaError(
          "[FamilyDeletion] Backup copies changed; review their complete history again",
          {
            code: "FAMILY_DELETION_PREVIEW_STALE",
          },
        );
      const updated: FamilyDeletionJob = {
        ...job,
        backupCleanup: review,
        backupCleanupHistory: job.backupCleanup
          ? [...(job.backupCleanupHistory ?? []), job.backupCleanup]
          : [],
      };
      await withTransaction(runtime, async (tx) => {
        await executeRawSqlTx(
          tx,
          `UPDATE ${table} SET job_json=${sqlQuote(JSON.stringify(updated))}::jsonb WHERE agent_id=${sqlQuote(runtime.agentId)}`,
        );
      });
      return updated;
    },
  );
  const { ensureFamilyBackupCleanupSchedule } = await import(
    "./backup-cleanup-schedule.js"
  );
  await ensureFamilyBackupCleanupSchedule(runtime);
  return admitted;
}

/** Load admitted identities under the backup lock, then durably acknowledge verified removal. */
export async function purgeFamilyBackupCleanup(
  runtime: IAgentRuntime,
  ownerEntityId: string,
  expected?: { jobId: string; sha256: string },
): Promise<FamilyDeletionJob> {
  requireOwner(ownerEntityId);
  const admittedJob = await requireDeletionJob(runtime, ownerEntityId);
  if (
    expected &&
    (admittedJob.id !== expected.jobId ||
      admittedJob.backupCleanup?.sha256 !== expected.sha256)
  )
    throw new ElizaError(
      "[FamilyDeletion] Scheduled cleanup no longer matches the admitted review",
      { code: "FAMILY_DELETION_PREVIEW_STALE" },
    );
  if (admittedJob.state === "complete") return admittedJob;
  const review = admittedJob.backupCleanup;
  if (!review || admittedJob.state !== "backup_pending")
    throw new ElizaError(
      "[FamilyDeletion] Review and acknowledge the whole backup history before cleanup",
      {
        code: "FAMILY_DELETION_BACKUP_REVIEW_REQUIRED",
      },
    );
  await purgeAdmittedRetiredLocalAgentBackups(runtime.agentId, async () => {
    const current = await requireDeletionJob(runtime, ownerEntityId);
    if (
      current.id !== admittedJob.id ||
      current.backupCleanup?.sha256 !== review.sha256
    )
      throw new ElizaError(
        "[FamilyDeletion] Backup admission changed; reload its status",
        {
          code: "FAMILY_DELETION_PREVIEW_STALE",
        },
      );
    return current.backupCleanup;
  });
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const current = await requireDeletionJob(runtime, ownerEntityId);
    if (
      current.id !== admittedJob.id ||
      current.backupCleanup?.sha256 !== review.sha256 ||
      (await authority.generation(runtime.agentId)) !== review.generation
    )
      throw new ElizaError(
        "[FamilyDeletion] Backup acknowledgement no longer matches its journal",
        {
          code: "FAMILY_DELETION_BACKUP_MISMATCH",
        },
      );
    const updated: FamilyDeletionJob = { ...current, state: "complete" };
    await withTransaction(runtime, async (tx) => {
      const states = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_family_workspace_state SET state='deleted',updated_at=${sqlQuote(new Date().toISOString())} WHERE agent_id=${sqlQuote(runtime.agentId)} AND state IN ('revoking','deleted') RETURNING state`,
      );
      if (states.length !== 1)
        throw new ElizaError(
          "[FamilyDeletion] Workspace revocation is unavailable",
          {
            code: "FAMILY_DELETION_BACKUP_MISMATCH",
          },
        );
      await executeRawSqlTx(
        tx,
        `UPDATE ${table} SET job_json=${sqlQuote(JSON.stringify(updated))}::jsonb WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
    });
    return updated;
  });
}
