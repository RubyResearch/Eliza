/** Synthetic durable deletion state for browser review and lost-acknowledgement recovery; no provider or real file is touched. */

import type { FamilyDeletionAdapter } from "../../src/components/family-operations/deletion-adapter.js";
import { familyDeletionJobSchema } from "../../src/lifeops/family-workflows/deletion-contracts.js";

export function createFamilyDeletionFixture(): FamilyDeletionAdapter {
  const currentDigest = () =>
    (sessionStorage.getItem("deletion-revision") === "2" ? "b" : "a").repeat(
      64,
    );
  const status = () => {
    const value = sessionStorage.getItem("deletion-job");
    return value === null
      ? null
      : familyDeletionJobSchema.parse(JSON.parse(value));
  };
  const previewBackups = () => {
    const job = status();
    if (!job) throw new Error("No deletion operation exists");
    const days = { immediate: 0, "7-days": 7, "30-days": 30 }[
      job.backupRetention
    ];
    return {
      jobId: job.id,
      generation: job.backupGeneration,
      notBefore: new Date(
        Date.parse(job.startedAt) + days * 86_400_000,
      ).toISOString(),
      sha256: "e".repeat(64),
      archives: [
        {
          fileName: "synthetic.agent-backup.json",
          archiveSha256: "f".repeat(64),
          stateSha256: "a".repeat(64),
          restoreGeneration: "initial",
          createdAt: "2026-09-01T12:00:00.000Z",
          sizeBytes: 100,
        },
      ],
    };
  };
  return {
    previewBackups: async () => previewBackups(),
    async admitBackups(input) {
      const job = status();
      const review = previewBackups();
      if (
        !job ||
        input.expectedSha256 !== review.sha256 ||
        input.acknowledgeWholeArchiveHistory !== true
      )
        throw new Error("Review every synthetic backup first");
      const updated = { ...job, backupCleanup: review };
      sessionStorage.setItem("deletion-job", JSON.stringify(updated));
      return updated;
    },
    async resumeBackups() {
      const job = status();
      if (!job?.backupCleanup)
        throw new Error("No backup cleanup was admitted");
      if (Date.now() < Date.parse(job.backupCleanup.notBefore))
        throw new Error("Backups are still retained");
      sessionStorage.setItem(
        "deletion-job",
        JSON.stringify({ ...job, state: "complete" }),
      );
      throw new Error(
        "Backup cleanup acknowledgement lost. Refresh deletion status.",
      );
    },
    status: async () => status(),
    preview: async () => ({
      agentId: "fixture-owner-agent",
      sha256: currentDigest(),
      unavailable: [],
      records: [
        {
          kind: "agreement",
          classification: "owned",
          unsettled: false,
          sha256: currentDigest(),
          identity: {
            title: "Synthetic parenting plan",
            id: "fixture-agreement",
          },
        },
        {
          kind: "providerCalendar",
          classification: "referenced",
          unsettled: false,
          sha256: "c".repeat(64),
          identity: { id: "fixture-calendar-retained" },
        },
      ],
    }),
    async begin(input) {
      if (sessionStorage.getItem("deletion-revision") !== "2") {
        sessionStorage.setItem("deletion-revision", "2");
        throw new Error(
          "Workspace changed. Review the updated records before deleting.",
        );
      }
      if (input.expectedSha256 !== currentDigest())
        throw new Error("Stale deletion review");
      const job = familyDeletionJobSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        agentId: "fixture-owner-agent",
        reviewedSha256: input.expectedSha256,
        startedAt: "2026-09-13T12:00:00.000Z",
        state: "purge_pending",
        backupRetention: input.backupRetention,
        backupGeneration: "22222222-2222-4222-8222-222222222222",
        backupOperationId: "fixture-delete",
        files: [],
        databaseRowsRemoved: 4,
        retained: [{ kind: "providerCalendar", count: 1 }],
      });
      sessionStorage.setItem("deletion-job", JSON.stringify(job));
      return job;
    },
    async resume() {
      const job = status();
      if (!job) throw new Error("No deletion operation exists");
      sessionStorage.setItem(
        "deletion-job",
        JSON.stringify({ ...job, state: "backup_pending" }),
      );
      throw new Error(
        "Cleanup response was interrupted. Refresh deletion status.",
      );
    },
  };
}
