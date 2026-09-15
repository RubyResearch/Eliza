/** Lets owners correct a missed requirement using a literal source citation and a separate approval step. */
import { Button, Input, Textarea } from "@elizaos/ui";
import { useId, useRef, useState } from "react";
import type { FamilyOperationsAdapter } from "./types.js";

export function AgreementProposalEditor({
  artifactId,
  pageCount,
  adapter,
  onSaved,
}: {
  artifactId: string;
  pageCount: number;
  adapter: Pick<FamilyOperationsAdapter, "addAgreementProposal">;
  onSaved: () => Promise<void>;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [citation, setCitation] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const pageStart = Number(start);
  const pageEnd = Number(end);
  const valid =
    title.trim() &&
    requirement.trim() &&
    citation.trim() &&
    Number.isInteger(pageStart) &&
    pageStart > 0 &&
    Number.isInteger(pageEnd) &&
    pageEnd >= pageStart &&
    pageEnd <= pageCount;
  const save = async () => {
    if (pending.current || (!saved && !valid)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let confirmed = saved;
    try {
      if (!confirmed) {
        const result = await adapter.addAgreementProposal(artifactId, {
          title: title.trim(),
          obligationText: requirement.trim(),
          citationText: citation.trim(),
          pageStart,
          pageEnd,
        });
        if (
          !result.obligation?.id ||
          result.obligation.artifactId !== artifactId
        )
          throw new Error(
            "The saved proposal could not be confirmed. Reload the agreement before continuing.",
          );
        confirmed = true;
        setSaved(true);
        setNotice(
          result.created
            ? "Proposal saved. Check it below before approving it."
            : `Existing ${result.obligation.status} proposal restored. Its decision was preserved.`,
        );
      }
      await onSaved();
      setOpen(false);
      setSaved(false);
      setTitle("");
      setRequirement("");
      setCitation("");
      setStart("");
      setEnd("");
    } catch (cause) {
      // error-policy:J4 Keep the draft or confirmed receipt visible for recovery without resubmitting a saved correction.
      const message =
        cause instanceof Error
          ? cause.message
          : "The proposal could not be saved";
      setError(
        confirmed
          ? `Proposal saved, but the review could not refresh. ${message}`
          : message,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="Add a cited requirement" className="grid gap-3 pb-3">
      {!open ? (
        <Button
          variant="outline"
          className="min-h-11 justify-self-start"
          onClick={() => {
            setOpen(true);
            setNotice(null);
            setError(null);
          }}
        >
          Add missing requirement
        </Button>
      ) : (
        <>
          <p>
            Add a requirement the review missed. Quote the original PDF exactly
            and include its page numbers. Saving creates a proposal for separate
            approval.
          </p>
          <label htmlFor={`${fieldId}-title`}>
            Requirement title
            <Input
              id={`${fieldId}-title`}
              className="min-h-11"
              value={title}
              disabled={busy || saved}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label htmlFor={`${fieldId}-requirement`}>
            Requirement
            <Textarea
              id={`${fieldId}-requirement`}
              value={requirement}
              disabled={busy || saved}
              onChange={(event) => setRequirement(event.target.value)}
            />
          </label>
          <label htmlFor={`${fieldId}-citation`}>
            Exact source quote
            <Textarea
              id={`${fieldId}-citation`}
              value={citation}
              disabled={busy || saved}
              onChange={(event) => setCitation(event.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label htmlFor={`${fieldId}-start`}>
              First page
              <Input
                id={`${fieldId}-start`}
                className="min-h-11"
                type="number"
                min={1}
                max={pageCount}
                step={1}
                value={start}
                disabled={busy || saved}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label htmlFor={`${fieldId}-end`}>
              Last page
              <Input
                id={`${fieldId}-end`}
                className="min-h-11"
                type="number"
                min={1}
                max={pageCount}
                step={1}
                value={end}
                disabled={busy || saved}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>
          <Button
            className="min-h-11 justify-self-start"
            disabled={busy || (!saved && !valid)}
            onClick={() => void save()}
          >
            {busy
              ? "Saving review…"
              : saved
                ? "Refresh saved proposal"
                : "Save proposal"}
          </Button>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
