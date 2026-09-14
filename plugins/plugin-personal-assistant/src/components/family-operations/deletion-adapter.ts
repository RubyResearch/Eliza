/** Validates owner deletion API replies before exposing review or retry state to the UI. */
import { client } from "@elizaos/ui/api";
import { z } from "zod";
import {
  type FamilyBackupCleanupReview,
  type FamilyDeletionJob,
  type FamilyDeletionPreview,
  familyBackupCleanupReviewSchema,
  familyDeletionJobSchema,
  familyDeletionPreviewSchema,
} from "../../lifeops/family-workflows/deletion-contracts.js";

export interface FamilyDeletionAdapter {
  preview(): Promise<FamilyDeletionPreview>;
  status(): Promise<FamilyDeletionJob | null>;
  begin(input: {
    expectedSha256: string;
    backupRetention: FamilyDeletionJob["backupRetention"];
  }): Promise<FamilyDeletionJob>;
  resume(): Promise<FamilyDeletionJob>;
  previewBackups(): Promise<FamilyBackupCleanupReview>;
  admitBackups(input: {
    expectedSha256: string;
    acknowledgeWholeArchiveHistory: true;
  }): Promise<FamilyDeletionJob>;
  resumeBackups(): Promise<FamilyDeletionJob>;
}
const prefix = "/api/lifeops/family-workflows/deletion";
const statusSchema = z.strictObject({
  job: familyDeletionJobSchema.nullable(),
});
const jobSchema = z.strictObject({ job: familyDeletionJobSchema });
const failureSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: object,
): Promise<T> {
  const response = await client.rawRequest(
    path,
    {
      method: body ? "POST" : "GET",
      cache: "no-store",
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
    { allowNonOk: true, skipResume: true, timeoutMs: 10 * 60_000 },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    const failure = failureSchema.safeParse(payload);
    throw new Error(
      failure.success
        ? failure.data.error
        : "Deletion could not be verified. Refresh its status before retrying.",
    );
  }
  return schema.parse(payload);
}
export const defaultFamilyDeletionAdapter: FamilyDeletionAdapter = {
  preview: () => request(`${prefix}/preview`, familyDeletionPreviewSchema),
  async status() {
    return (await request(prefix, statusSchema)).job;
  },
  async begin(input) {
    return (await request(prefix, jobSchema, input)).job;
  },
  async resume() {
    return (await request(`${prefix}/resume`, jobSchema, {})).job;
  },
  previewBackups: () =>
    request(`${prefix}/backups/preview`, familyBackupCleanupReviewSchema),
  async admitBackups(input) {
    return (await request(`${prefix}/backups`, jobSchema, input)).job;
  },
  async resumeBackups() {
    return (await request(`${prefix}/backups/resume`, jobSchema, {})).job;
  },
};
