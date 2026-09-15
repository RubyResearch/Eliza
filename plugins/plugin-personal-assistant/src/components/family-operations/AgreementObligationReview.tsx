/**
 * Owns one cited clause's draft reason, pending decision, and confirmed receipt.
 * A confirmed write survives refresh failure without offering to send it again.
 */
import { Button, Input } from "@elizaos/ui";
import { Check, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ParentingAgreementObligation } from "../../lifeops/household/agreement-knowledge.js";
import type { FamilyOperationsAdapter } from "./types.js";

export function AgreementObligationReview({
  obligation,
  adapter,
  onDecided,
}: {
  obligation: ParentingAgreementObligation;
  adapter: Pick<FamilyOperationsAdapter, "decideObligation">;
  onDecided: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] =
    useState<ParentingAgreementObligation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const pending = useRef(false);
  const displayed = confirmed ?? obligation;

  const decide = async (decision: "approve" | "reject") => {
    if (
      pending.current ||
      requiresRefresh ||
      displayed.status !== "proposed" ||
      !reason.trim()
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let saved = false;
    try {
      const receipt = await adapter.decideObligation(
        obligation,
        decision,
        reason,
      );
      if (
        !receipt ||
        receipt.id !== obligation.id ||
        receipt.artifactId !== obligation.artifactId ||
        receipt.status !== (decision === "approve" ? "approved" : "rejected")
      ) {
        setRequiresRefresh(true);
        throw new Error(
          "The decision response did not match this clause. Reload the agreement before continuing.",
        );
      }
      setConfirmed(receipt);
      setReason("");
      saved = true;
      await onDecided();
    } catch (cause) {
      // error-policy:J4 Retain this clause's draft on failed writes and its confirmed receipt on failed refreshes.
      const message =
        cause instanceof Error
          ? cause.message
          : "The decision could not be completed";
      setError(
        saved
          ? `Decision saved, but the agreement could not refresh: ${message}`
          : message,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await onDecided();
      setRequiresRefresh(false);
      setError(null);
    } catch (cause) {
      // error-policy:J4 Readback recovery never resends the already confirmed decision.
      const message =
        cause instanceof Error ? cause.message : "Refresh unavailable";
      setError(
        confirmed
          ? `Decision saved, but the agreement could not refresh: ${message}`
          : `Review could not refresh: ${message}`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <article
      aria-busy={busy}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <strong>{displayed.title}</strong>
        <span>{displayed.status}</span>
      </div>
      <p>{displayed.obligationText}</p>
      <blockquote
        style={{
          margin: "10px 0",
          paddingLeft: 12,
          borderLeft: "3px solid var(--accent)",
          color: "var(--muted)",
        }}
      >
        Pages {displayed.pageStart}–{displayed.pageEnd}:{" "}
        {displayed.citationText}
      </blockquote>
      {displayed.status === "proposed" ? (
        <div style={{ display: "grid", gap: 9 }}>
          <label htmlFor={`decision-reason-${obligation.id}`}>
            <span style={{ display: "block", marginBottom: 6 }}>
              Decision reason
            </span>
            <Input
              id={`decision-reason-${obligation.id}`}
              className="min-h-11"
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              className="min-h-11"
              disabled={busy || requiresRefresh || !reason.trim()}
              onClick={() => void decide("approve")}
            >
              <Check size={16} /> Approve
            </Button>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy || requiresRefresh || !reason.trim()}
              onClick={() => void decide("reject")}
            >
              <X size={16} /> Reject
            </Button>
          </div>
          {busy ? (
            <p role="status">
              {requiresRefresh ? "Refreshing review…" : "Saving decision…"}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {(confirmed || requiresRefresh) && error ? (
        <Button
          className="min-h-11"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {confirmed ? "Refresh saved decision" : "Refresh review"}
        </Button>
      ) : null}
    </article>
  );
}
