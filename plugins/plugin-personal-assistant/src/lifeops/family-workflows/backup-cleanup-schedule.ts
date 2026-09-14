/**
 * Reconciles admitted archive cleanup into the shared scheduled-task runner.
 * The deletion journal remains the authority; a stale task cannot approve new
 * archives, shorten retention, or substitute a new deletion operation.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { readFamilyDeletionJob } from "./workspace-deletion.js";

export const FAMILY_BACKUP_CLEANUP_OPERATION = "agent.familyBackupCleanup";

/** Replay-safe admission recovery, also called when the shared runner boots. */
export async function ensureFamilyBackupCleanupSchedule(
  runtime: IAgentRuntime,
  runner?: ScheduledTaskRunnerHandle,
): Promise<void> {
  const job = await readFamilyDeletionJob(runtime, SELF_ENTITY_ID);
  if (job?.state !== "backup_pending" || !job.backupCleanup) return;
  const review = job.backupCleanup;
  const scheduler =
    runner ?? getScheduledTaskRunner(runtime, { agentId: runtime.agentId });
  await scheduler.schedule({
    kind: "output",
    promptInstructions:
      "Remove only the owner-reviewed retired local backup copies after their retention deadline.",
    trigger: { kind: "once", atIso: review.notBefore },
    priority: "low",
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: SELF_ENTITY_ID,
    ownerVisible: true,
    idempotencyKey: `family-backup-cleanup:${job.id}:${review.sha256}`,
    output: { destination: "memory", persistAs: "task_metadata" },
    metadata: {
      systemOperation: FAMILY_BACKUP_CLEANUP_OPERATION,
      deletionJobId: job.id,
      backupReviewSha256: review.sha256,
    },
    executionProfile: "bg-heavy-fgs",
  });
}
