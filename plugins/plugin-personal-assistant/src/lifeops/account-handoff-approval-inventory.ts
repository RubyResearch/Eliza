/**
 * Identifies live Google approvals whose account binding changes during handoff.
 * Legacy unbound owner approvals require explicit retirement because their default
 * account may change. Explicit other-account and non-Google work is preserved.
 */
import type { ApprovalRequest } from "@elizaos/agent";
import { ElizaError } from "@elizaos/core";

export type AccountHandoffRetirementCandidate = Pick<
  ApprovalRequest,
  "id" | "action" | "payload" | "channel" | "state" | "reason"
> & { expiresAt: string };

export function requiredGoogleHandoffApprovals(
  requests: readonly ApprovalRequest[],
  previousGrantId: string,
): ApprovalRequest[] {
  return requests.filter((request) => {
    if (
      request.state !== "pending" &&
      request.state !== "approved" &&
      request.state !== "retryable" &&
      request.state !== "executing" &&
      request.state !== "reconciliation_required"
    )
      return false;
    const payload = request.payload;
    switch (payload.action) {
      case "send_email":
        return !payload.grantId || payload.grantId === previousGrantId;
      case "schedule_event":
      case "modify_event":
      case "cancel_event":
        if (payload.side === "agent") return false;
        if (payload.grantId) return payload.grantId === previousGrantId;
        if (
          "expectedProvider" in payload &&
          payload.expectedProvider &&
          payload.expectedProvider !== "google"
        )
          return false;
        return true;
      default:
        return false;
    }
  });
}

export function assertGoogleHandoffApprovalSelection(
  requests: readonly ApprovalRequest[],
  previousGrantId: string,
  selectedIds: readonly string[],
): void {
  const selected = new Set(selectedIds);
  const missing = requiredGoogleHandoffApprovals(
    requests,
    previousGrantId,
  ).filter((request) => !selected.has(request.id));
  if (missing.length)
    throw new ElizaError(
      "Review and retire the remaining old-account or unbound Google approvals before switching accounts.",
      {
        code: "ACCOUNT_HANDOFF_APPROVAL_REVIEW_INCOMPLETE",
        context: { approvalIds: missing.map((request) => request.id) },
      },
    );
}
