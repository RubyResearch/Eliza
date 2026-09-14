/** Browser-safe deletion review and journal contracts shared by HTTP clients and storage. */
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const familyBackupRetentionSchema = z.enum([
  "immediate",
  "7-days",
  "30-days",
]);
export const familyBackupCleanupReviewSchema = z.strictObject({
  jobId: z.string().uuid(),
  generation: z.string().uuid(),
  notBefore: z.string().datetime(),
  sha256,
  archives: z.array(
    z.strictObject({
      fileName: z.string().min(1),
      archiveSha256: sha256,
      stateSha256: sha256,
      restoreGeneration: z.string().min(1),
      createdAt: z.string().datetime(),
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
});
export type FamilyBackupCleanupReview = z.infer<
  typeof familyBackupCleanupReviewSchema
>;
export const familyDeletionJobSchema = z
  .strictObject({
    id: z.string().uuid(),
    agentId: z.string().min(1),
    reviewedSha256: sha256,
    startedAt: z.string().datetime(),
    state: z.enum(["purge_pending", "backup_pending", "complete"]),
    backupRetention: familyBackupRetentionSchema,
    backupGeneration: z.string().uuid(),
    backupOperationId: z.string().min(1),
    // Older persisted jobs predate archive admission; absence requires a fresh review.
    backupCleanup: familyBackupCleanupReviewSchema.optional(),
    backupCleanupHistory: z.array(familyBackupCleanupReviewSchema).optional(),
    files: z.array(z.strictObject({ fileName: z.string().min(1), sha256 })),
    databaseRowsRemoved: z.number().int().nonnegative(),
    retained: z.array(
      z.strictObject({ kind: z.string(), count: z.number().int().positive() }),
    ),
  })
  .superRefine((job, context) => {
    if (job.state === "complete" && !job.backupCleanup)
      context.addIssue({
        code: "custom",
        path: ["backupCleanup"],
        message: "Completed deletion requires its admitted backup identities",
      });
    if (
      job.backupCleanup &&
      (job.backupCleanup.jobId !== job.id ||
        job.backupCleanup.generation !== job.backupGeneration)
    )
      context.addIssue({
        code: "custom",
        path: ["backupCleanup"],
        message: "Backup admission must belong to this deletion and generation",
      });
  });
export type FamilyDeletionJob = z.infer<typeof familyDeletionJobSchema>;

export const familyDeletionPreviewSchema = z.strictObject({
  agentId: z.string().min(1),
  sha256,
  unavailable: z.array(z.string()),
  records: z.array(
    z.strictObject({
      kind: z.string(),
      classification: z.enum(["owned", "referenced", "mixed", "unclassified"]),
      unsettled: z.boolean(),
      sha256,
      identity: z.record(z.string(), z.json()),
    }),
  ),
});
export type FamilyDeletionPreview = z.infer<typeof familyDeletionPreviewSchema>;
