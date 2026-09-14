/**
 * Owner review and recovery controls for durable workspace deletion.
 * Confirmation binds to the complete displayed snapshot; uncertain requests
 * require a status refresh and never produce an optimistic completion notice.
 */
import { Button, Input } from "@elizaos/ui";
import { useId, useRef, useState } from "react";
import type {
  FamilyBackupCleanupReview,
  FamilyDeletionJob,
  FamilyDeletionPreview,
} from "../../lifeops/family-workflows/deletion-contracts.js";
import {
  defaultFamilyDeletionAdapter,
  type FamilyDeletionAdapter,
} from "./deletion-adapter.js";

const retentionLabels: Record<FamilyDeletionJob["backupRetention"], string> = {
  immediate: "Immediately",
  "7-days": "After 7 days",
  "30-days": "After 30 days",
};
const policies = [
  { value: "immediate", label: "Immediately" },
  { value: "7-days", label: "After 7 days" },
  { value: "30-days", label: "After 30 days" },
] as const;

export function FamilyDeletionPanel({
  adapter = defaultFamilyDeletionAdapter,
  onChange,
}: {
  adapter?: FamilyDeletionAdapter;
  onChange: () => Promise<void>;
}) {
  const reviewId = useId();
  const backupReviewId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef(false);
  const [preview, setPreview] = useState<FamilyDeletionPreview | null>(null);
  const [job, setJob] = useState<FamilyDeletionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [backupReview, setBackupReview] =
    useState<FamilyBackupCleanupReview | null>(null);
  const [backupReviewed, setBackupReviewed] = useState(false);
  const [retention, setRetention] = useState<
    FamilyDeletionJob["backupRetention"] | null
  >(null);

  const perform = async (operation: () => Promise<void>) => {
    if (activeRequest.current) return;
    activeRequest.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      // error-policy:J1 Preserve the failure and require a fresh review/status before another deletion attempt.
      setPreview(null);
      setReviewed(false);
      setBackupReview(null);
      setBackupReviewed(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion status is unavailable.",
      );
    } finally {
      activeRequest.current = false;
      setBusy(false);
    }
  };
  const refresh = () =>
    perform(async () => {
      setPreview(null);
      setReviewed(false);
      setBackupReview(null);
      setBackupReviewed(false);
      const current = await adapter.status();
      setJob(current);
      if (!current) setPreview(await adapter.preview());
    });
  const begin = () =>
    perform(async () => {
      if (
        !preview ||
        !reviewed ||
        !retention ||
        preview.unavailable.length ||
        preview.records.some((record) => record.unsettled)
      ) {
        throw new Error(
          "Refresh the workspace review and choose a backup retention policy before deleting.",
        );
      }
      setJob(
        await adapter.begin({
          expectedSha256: preview.sha256,
          backupRetention: retention,
        }),
      );
      setPreview(null);
      setReviewed(false);
      await onChange();
    });
  const resume = () =>
    perform(async () => {
      setJob(await adapter.resume());
      await onChange();
    });
  const reviewBackups = () =>
    perform(async () => {
      setBackupReview(null);
      setBackupReviewed(false);
      const current = await adapter.status();
      setJob(current);
      if (current?.state !== "backup_pending")
        throw new Error(
          "Refresh deletion status before reviewing backup cleanup.",
        );
      setBackupReview(await adapter.previewBackups());
    });
  const admitBackups = () =>
    perform(async () => {
      if (!backupReview || !backupReviewed || backupReview.jobId !== job?.id)
        throw new Error(
          "Review every backup and acknowledge removal of its whole archived history.",
        );
      setJob(
        await adapter.admitBackups({
          expectedSha256: backupReview.sha256,
          acknowledgeWholeArchiveHistory: true,
        }),
      );
      setBackupReview(null);
      setBackupReviewed(false);
    });
  const resumeBackups = () =>
    perform(async () => {
      setJob(await adapter.resumeBackups());
      setBackupReview(null);
      setBackupReviewed(false);
    });

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        Review workspace deletion
      </Button>
    );
  return (
    <section
      aria-label="Workspace deletion"
      className="grid gap-3 rounded-lg border border-border p-4 [&_button]:min-h-11"
    >
      <h2 className="text-lg font-semibold">Workspace deletion</h2>
      <p>
        Review the affected records before permanently removing this workspace.
        Export any records you want to keep first.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh deletion status
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Close deletion review
        </Button>
      </div>
      {busy ? <p role="status">Checking workspace deletion…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {job ? (
        <>
          <p role="status">
            {job.state === "purge_pending"
              ? "Access is revoked. Primary-file cleanup is still pending."
              : job.state === "complete"
                ? "Workspace deletion is complete. Referenced provider records remain with their providers."
                : "Primary cleanup is verified. Backup cleanup is pending; deletion is not complete."}
          </p>
          <p>
            {job.databaseRowsRemoved} database records removed. Backup
            retention: {retentionLabels[job.backupRetention]}.
          </p>
          <p>
            Started {new Date(job.startedAt).toLocaleString()}. Operation{" "}
            {job.id}.
          </p>
          {job.retained.length ? (
            <div>
              <h3>Records retained</h3>
              <ul>
                {job.retained.map((record) => (
                  <li key={record.kind}>
                    {record.kind}: {record.count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {job.state === "purge_pending" ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void resume()}
            >
              Retry primary cleanup
            </Button>
          ) : null}
          {job.state === "backup_pending" ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void reviewBackups()}
              >
                Review backup copies
              </Button>
              {job.backupCleanup ? (
                <>
                  <p>
                    Backup cleanup was admitted. Copies are retained until{" "}
                    {new Date(job.backupCleanup.notBefore).toLocaleString()}.
                    Cleanup remains pending until removal is verified.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      Date.now() < Date.parse(job.backupCleanup.notBefore)
                    }
                    onClick={() => void resumeBackups()}
                  >
                    Retry backup cleanup
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {job.backupCleanup ? (
            <details>
              <summary>Admitted backup identities</summary>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(job.backupCleanup, null, 2)}
              </pre>
            </details>
          ) : null}
        </>
      ) : null}
      {backupReview ? (
        <>
          <p>
            These are whole-agent backup copies. Removing them permanently
            removes all history in those copies, including unrelated archived
            history. Unrelated live records and provider records remain
            retained.
          </p>
          <p>
            Eligible for removal after{" "}
            {new Date(backupReview.notBefore).toLocaleString()}.
          </p>
          <details>
            <summary>
              Review all {backupReview.archives.length} backup copies
            </summary>
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(backupReview.archives, null, 2)}
            </pre>
          </details>
          <label
            htmlFor={backupReviewId}
            className="flex min-h-11 items-start gap-2"
          >
            <Input
              id={backupReviewId}
              type="checkbox"
              checked={backupReviewed}
              disabled={busy}
              onChange={(event) =>
                setBackupReviewed(event.currentTarget.checked)
              }
            />
            I reviewed every backup and understand that its entire archived
            history will be permanently removed.
          </label>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !backupReviewed}
            onClick={() => void admitBackups()}
          >
            Confirm reviewed backup cleanup
          </Button>
        </>
      ) : null}
      {preview ? (
        <>
          {preview.unavailable.length ? (
            <p role="alert">
              Review is incomplete. Unavailable stores:{" "}
              {preview.unavailable.join(", ")}.
            </p>
          ) : null}
          {preview.records.some((record) => record.unsettled) ? (
            <p role="alert">
              Work is still in progress. Wait for it to settle, then refresh
              this review.
            </p>
          ) : null}
          <p>
            Owned family content is removed; the revocation record and deletion
            journal remain for recovery. Referenced, mixed, and unclassified
            records remain retained. Provider calendars and messages remain with
            their providers.
          </p>
          <details>
            <summary>
              Review all {preview.records.length} affected records
            </summary>
            <ul className="grid gap-3">
              {preview.records.map((record) => (
                <li key={`${record.kind}:${record.sha256}`}>
                  <strong>{record.kind}</strong> — {record.classification}
                  {record.unsettled ? "; work pending" : ""}
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(record.identity, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </details>
          <fieldset disabled={busy} className="grid gap-2">
            <legend>Remove eligible backups</legend>
            <div className="flex flex-wrap gap-2">
              {policies.map((policy) => (
                <Button
                  key={policy.value}
                  type="button"
                  variant="choice"
                  aria-pressed={retention === policy.value}
                  data-state={retention === policy.value ? "on" : "off"}
                  onClick={() => setRetention(policy.value)}
                >
                  {policy.label}
                </Button>
              ))}
            </div>
          </fieldset>
          <label htmlFor={reviewId} className="flex min-h-11 items-start gap-2">
            <Input
              id={reviewId}
              type="checkbox"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => setReviewed(event.target.checked)}
              className="h-5 w-5 shrink-0"
            />
            I reviewed these records and understand that removal is permanent.
          </label>
          <Button
            type="button"
            variant="destructive"
            disabled={
              busy ||
              !reviewed ||
              !retention ||
              preview.unavailable.length > 0 ||
              preview.records.some((record) => record.unsettled)
            }
            onClick={() => void begin()}
          >
            Delete reviewed workspace
          </Button>
        </>
      ) : null}
    </section>
  );
}
