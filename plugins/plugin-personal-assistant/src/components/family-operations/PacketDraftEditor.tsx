/** Edits an immutable email draft into a new revision before requesting approval of its saved text. */
import { Button, Input, Textarea } from "@elizaos/ui";
import { useState } from "react";
import type { FamilyOperationsAdapter, FamilyPacketView } from "./types.js";

export function PacketDraftEditor({
  packetId,
  draft,
  adapter,
  refresh,
  requestApproval,
}: {
  packetId: string;
  draft: NonNullable<FamilyPacketView["draft"]>;
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
  requestApproval: (draftVersion: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.email?.subject ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    if (!draft.approvalId) return;
    setBusy(true);
    setError(null);
    try {
      await adapter.decidePacketApproval({
        packetId,
        draftVersion: draft.draftVersion,
        approvalId: draft.approvalId,
        bodySha256: draft.bodySha256,
        decision,
      });
    } catch (cause) {
      // error-policy:J4 The persisted result is refreshed before any retry is offered.
      setError(
        cause instanceof Error
          ? cause.message
          : "Decision could not be confirmed. Check delivery status.",
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  const decisionState = draft.approval?.state;
  const canApprove =
    decisionState === "pending" ||
    decisionState === "approved" ||
    decisionState === "retryable";
  const approvalMessage = !draft.approvalId
    ? "Draft has not been submitted for approval."
    : !draft.approval
      ? "Approval status unavailable. Refresh before taking another action."
      : decisionState === "done"
        ? draft.approval.providerAccepted === true
          ? "Accepted by the email provider."
          : "Completed; provider delivery confirmation is unavailable."
        : decisionState === "executing"
          ? "Delivery is in progress. Check status before retrying."
          : decisionState === "reconciliation_required"
            ? "Delivery outcome is unknown. Verify the provider record before retrying."
            : decisionState === "retryable"
              ? "Delivery failed before acceptance. You can retry the reviewed email."
              : decisionState === "approved"
                ? "Approved; delivery has not completed."
                : decisionState === "rejected"
                  ? "Rejected. This approval will not send the email."
                  : decisionState === "expired"
                    ? "Approval expired. Prepare and review a new draft."
                    : "Awaiting your decision on the exact email above.";
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adapter.revisePacketDraft({
        packetId,
        expectedDraftVersion: draft.draftVersion,
        body,
        subject,
      });
      await refresh();
      setEditing(false);
    } catch (cause) {
      // error-policy:J4 Failed or stale saves preserve the owner's unsaved text and expose the failure.
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save this draft. Reload its current version.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <fieldset className="grid gap-3" aria-label="Edit saved email">
        <p>
          Your saved edits will be sent exactly as approved. Saving creates a
          new draft and invalidates approval of the previous version.
        </p>
        <label htmlFor={`draft-subject-${packetId}`}>Email subject</label>
        <Input
          id={`draft-subject-${packetId}`}
          value={subject}
          disabled={busy}
          onChange={(event) => setSubject(event.target.value)}
        />
        <label htmlFor={`draft-body-${packetId}`}>Email text</label>
        <Textarea
          id={`draft-body-${packetId}`}
          value={body}
          disabled={busy}
          rows={12}
          onChange={(event) => setBody(event.target.value)}
        />
        {error ? <p role="alert">{error}</p> : null}
        <Button
          variant="accentDarkHover"
          disabled={busy || !body.trim() || !subject.trim()}
          onClick={() => void save()}
        >
          Save new draft
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setBody(draft.body);
            setSubject(draft.email?.subject ?? "");
            setError(null);
          }}
        >
          Cancel editing
        </Button>
      </fieldset>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <p className="w-full" role="status">
        {approvalMessage}
      </p>
      {draft.approval?.error ? (
        <p className="w-full" role="alert">
          {draft.approval.error}
        </p>
      ) : null}
      {error ? (
        <p className="w-full" role="alert">
          {error}
        </p>
      ) : null}
      {draft.email && canApprove ? (
        <Button
          variant="accentDarkHover"
          disabled={busy}
          onClick={() => void decide("approve")}
        >
          {decisionState === "retryable"
            ? "Retry reviewed email"
            : "Approve and send email"}
        </Button>
      ) : null}
      {draft.email && decisionState === "pending" ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void decide("reject")}
        >
          Reject email
        </Button>
      ) : null}
      {draft.approvalId ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh delivery status
        </Button>
      ) : null}
      {draft.email ? (
        <Button
          variant="outline"
          disabled={
            busy ||
            decisionState === "executing" ||
            decisionState === "reconciliation_required"
          }
          onClick={() => setEditing(true)}
        >
          Edit email draft
        </Button>
      ) : null}
      {!draft.approvalId ? (
        <Button onClick={() => void requestApproval(draft.draftVersion)}>
          Request owner approval
        </Button>
      ) : null}
    </div>
  );
}
