/**
 * Starts owner-requested cited proposal generation and restores its durable result.
 * Preparing a review cannot approve proposals or activate any agreement behavior.
 */
import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreparedAgreementReview } from "../../lifeops/household/agreement-knowledge.js";
import type { FamilyOperationsAdapter, Loadable } from "./types.js";

export function AgreementReviewPanel({
  artifactId,
  adapter,
  onPrepared,
}: {
  artifactId: string;
  adapter: Pick<
    FamilyOperationsAdapter,
    "readAgreementReview" | "prepareAgreementReview"
  >;
  onPrepared: () => Promise<void>;
}) {
  const [state, setState] =
    useState<Loadable<PreparedAgreementReview | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setState(null);
    setBusy(false);
    setError(null);
    try {
      const review = await adapter.readAgreementReview(artifactId);
      if (review && review.artifactId !== artifactId)
        throw new Error(
          "Saved review belongs to another agreement; reload before continuing",
        );
      if (request === generation.current)
        setState({ status: "ready", data: review });
    } catch (cause) {
      // error-policy:J4 Failed reads are distinct from an agreement awaiting preparation.
      if (request === generation.current)
        setState({
          status: "unavailable",
          message:
            cause instanceof Error ? cause.message : "Review could not load",
        });
    }
  }, [adapter, artifactId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  const prepare = async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const review = await adapter.prepareAgreementReview(artifactId);
      if (review.artifactId !== artifactId)
        throw new Error(
          "Prepared review belongs to another agreement; reload before continuing",
        );
      if (request !== generation.current) return;
      await onPrepared();
      if (request === generation.current)
        setState({ status: "ready", data: review });
    } catch (cause) {
      // error-policy:J4 Provider, validation and refresh failures leave a visible retry state.
      if (request === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Review could not be prepared",
        );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  if (!state) return <p role="status">Loading agreement review…</p>;
  if (state.status === "unavailable")
    return (
      <div className="grid gap-3 pb-3">
        <p role="alert">{state.message}</p>
        <Button
          className="min-h-11 justify-self-start"
          onClick={() => void load()}
        >
          Retry loading review
        </Button>
      </div>
    );
  return (
    <section aria-label="Prepare agreement review" className="grid gap-3 pb-3">
      {state.data ? (
        <>
          <p role="status">
            {state.data.outcome === "no_proposals"
              ? "No supported proposals were found. Review the original PDF for anything missing."
              : "Cited proposals are ready for your review below."}
          </p>
          <p>{state.data.explanation}</p>
        </>
      ) : (
        <>
          <p>
            Prepare proposals from the complete saved PDF, then check each
            citation before approving or rejecting it. Nothing is shared or
            scheduled by this step.
          </p>
          <Button
            className="min-h-11 justify-self-start"
            disabled={busy}
            onClick={() => void prepare()}
          >
            {busy ? "Preparing review…" : "Prepare review"}
          </Button>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
