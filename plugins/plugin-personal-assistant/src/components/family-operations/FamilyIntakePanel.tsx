/**
 * Owner review of selected correspondence before monthly packet generation.
 * Imports keep stable retry identities; proposals remain private until the owner
 * saves explicit fact recipients. Failed mutations retain the editable input.
 */
import { Button, Checkbox, Input, Textarea } from "@elizaos/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  FamilyIntakeFact,
  FamilyIntakeReview,
} from "../../lifeops/family-coordination/intake-review.js";
import type { FamilyIntakeReviewDetails } from "../../lifeops/family-coordination/intake-service.js";
import type { FamilyEmailOptions } from "../../lifeops/family-workflows/runtime.js";
import { FamilyInterviewForm } from "./FamilyInterviewForm.js";
import { FamilyRequestDecision } from "./FamilyRequestDecision.js";
import type { FamilyIntakeAdapter } from "./intake-adapter.js";
import type { Loadable } from "./types.js";

function FactListEditor({
  field,
  factNumber,
  values,
  onChange,
}: {
  field: string;
  factNumber: number;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  // The parent remounts a reviewed revision as a unit. Local row identities keep
  // input focus stable while this form adds, removes, or edits repeated values.
  const [ids, setIds] = useState(() => values.map(() => crypto.randomUUID()));
  return (
    <fieldset className="space-y-2">
      <legend className="capitalize">{field}</legend>
      {ids.map((id, index) => (
        <div key={id} className="flex gap-2">
          <Input
            aria-label={`${field} ${index + 1} for fact ${factNumber}`}
            value={values[index]}
            onChange={(event) =>
              onChange(
                values.map((value, i) =>
                  i === index ? event.target.value : value,
                ),
              )
            }
          />
          <Button
            variant="outline"
            aria-label={`Remove ${field} ${index + 1} from fact ${factNumber}`}
            onClick={() => {
              setIds((current) => current.filter((value) => value !== id));
              onChange(values.filter((_, i) => i !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => {
          setIds((current) => [...current, crypto.randomUUID()]);
          onChange([...values, ""]);
        }}
      >
        Add {field} entry
      </Button>
    </fieldset>
  );
}

function IntakeReview({
  details,
  recipients,
  busy,
  save,
  change,
  onDirtyChange,
  decide,
}: {
  details: FamilyIntakeReviewDetails;
  recipients: FamilyEmailOptions["recipients"];
  busy: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
  save: (facts: FamilyIntakeFact[]) => void;
  decide: (
    decision: NonNullable<FamilyIntakeReview["requestDecision"]>,
  ) => Promise<boolean>;
  change: (operation: "extract" | "withdraw" | "reselect") => void;
}) {
  const { review, title, sourceStatus } = details;
  const formId = useId();
  const [facts, setFacts] = useState(details.factsForReview);
  const [excluded, setExcluded] = useState<Set<string>>(
    () => new Set(details.excludedFactIds),
  );
  const dirty =
    JSON.stringify(facts) !== JSON.stringify(details.factsForReview) ||
    JSON.stringify([...excluded].sort()) !==
      JSON.stringify([...details.excludedFactIds].sort());
  useEffect(() => {
    onDirtyChange(review.id, dirty);
  }, [review.id, dirty, onDirtyChange]);
  useEffect(
    () => () => onDirtyChange(review.id, false),
    [review.id, onDirtyChange],
  );
  const choices = [
    ...new Map(
      recipients.map((recipient) => [recipient.entityId, recipient]),
    ).values(),
  ];
  const unresolvedRecipients = facts.some(
    (fact) =>
      !excluded.has(fact.id) &&
      fact.recipientEntityIds.some(
        (id) => !choices.some((recipient) => recipient.entityId === id),
      ),
  );
  return (
    <article className="rounded-xl border border-border p-4 space-y-4">
      <h3>
        {title ?? "Untitled correspondence"} — {review.status}
      </h3>
      {sourceStatus.state === "unavailable" ? (
        <p role="alert">{sourceStatus.message}</p>
      ) : null}
      <p>Source month: {review.periodKey}</p>
      {details.requestHistory.length > 0 ? (
        <details>
          <summary>Request decision history</summary>
          <ol className="space-y-3">
            {details.requestHistory.map((decision) => (
              <li key={decision.operationId}>
                <p className="whitespace-pre-wrap break-words">
                  Request: {decision.statement}
                </p>
                <p>
                  {decision.state === "resolved" ? "Resolved" : "Reopened"} ·{" "}
                  <time dateTime={decision.recordedAt}>
                    {decision.recordedAt}
                  </time>{" "}
                  · Review {decision.revision}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  {decision.reason}
                </p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {review.requestDecision ? (
        <p className="whitespace-pre-wrap break-words">
          {review.requestDecision.state === "resolved"
            ? "Resolution"
            : "Reopened"}
          : {review.requestDecision.reason}
        </p>
      ) : null}
      {review.status === "selected" ? (
        <Button
          variant="accentDarkHover"
          disabled={busy || sourceStatus.state !== "ready"}
          onClick={() => change("extract")}
        >
          Extract proposals
        </Button>
      ) : null}
      {review.status === "withdrawn" ? (
        <>
          <p>
            This source is excluded from new packets. Drafts bound to this
            review cannot be sent.
          </p>
          <Button
            variant="accentDarkHover"
            disabled={busy}
            onClick={() => change("reselect")}
          >
            Select this source again
          </Button>
        </>
      ) : (
        <>
          {facts.map((fact, index) => (
            <fieldset
              key={fact.id}
              className="space-y-3 border border-border rounded-lg p-3"
              disabled={busy}
            >
              <legend>Fact {index + 1}</legend>
              <label
                htmlFor={`${formId}-${fact.id}-include`}
                className="flex gap-2 items-center"
              >
                <Checkbox
                  id={`${formId}-${fact.id}-include`}
                  checked={!excluded.has(fact.id)}
                  onCheckedChange={(checked) =>
                    setExcluded((current) => {
                      const next = new Set(current);
                      if (checked === true) next.delete(fact.id);
                      else next.add(fact.id);
                      return next;
                    })
                  }
                />
                Include this fact
              </label>
              <label className="grid gap-2" htmlFor={`${formId}-${fact.id}`}>
                Proposed statement
                <Textarea
                  id={`${formId}-${fact.id}`}
                  value={fact.statement}
                  onChange={(event) =>
                    setFacts((current) =>
                      current.map((value) =>
                        value.id === fact.id
                          ? { ...value, statement: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </label>
              {(
                ["dates", "requests", "commitments", "accountability"] as const
              ).map((field) => (
                <FactListEditor
                  key={field}
                  field={field}
                  factNumber={index + 1}
                  values={fact[field]}
                  onChange={(values) =>
                    setFacts((current) =>
                      current.map((entry) =>
                        entry.id !== fact.id
                          ? entry
                          : { ...entry, [field]: values },
                      ),
                    )
                  }
                />
              ))}
              <label
                htmlFor={`${formId}-${fact.id}-urgency`}
                className="grid gap-2"
              >
                Urgency (leave blank if unstated)
                <Input
                  id={`${formId}-${fact.id}-urgency`}
                  value={fact.urgency ?? ""}
                  onChange={(event) =>
                    setFacts((current) =>
                      current.map((entry) =>
                        entry.id !== fact.id
                          ? entry
                          : {
                              ...entry,
                              urgency: event.target.value.trim()
                                ? event.target.value
                                : null,
                            },
                      ),
                    )
                  }
                />
              </label>
              <label
                htmlFor={`${formId}-${fact.id}-unanswered`}
                className="flex gap-2 items-center"
              >
                <Checkbox
                  id={`${formId}-${fact.id}-unanswered`}
                  checked={fact.unanswered}
                  disabled={review.status === "reviewed"}
                  onCheckedChange={(checked) =>
                    setFacts((current) =>
                      current.map((entry) =>
                        entry.id !== fact.id
                          ? entry
                          : { ...entry, unanswered: checked === true },
                      ),
                    )
                  }
                />
                Awaiting an answer
              </label>
              {review.status === "reviewed" && !excluded.has(fact.id) ? (
                <FamilyRequestDecision
                  factId={fact.id}
                  unanswered={fact.unanswered}
                  disabled={busy || dirty}
                  onDirtyChange={onDirtyChange}
                  save={decide}
                />
              ) : null}
              <details>
                <summary>Source quotation</summary>
                <blockquote className="whitespace-pre-wrap break-words">
                  {fact.sourceQuote}
                </blockquote>
              </details>
              <p>
                Allowed recipients for this fact. Leaving all unchecked keeps it
                private.
              </p>
              {choices.map((recipient) => (
                <label
                  key={recipient.entityId}
                  htmlFor={`${formId}-${fact.id}-${recipient.entityId}`}
                  className="flex gap-2 items-center"
                >
                  <Checkbox
                    id={`${formId}-${fact.id}-${recipient.entityId}`}
                    checked={fact.recipientEntityIds.includes(
                      recipient.entityId,
                    )}
                    onCheckedChange={(checked) =>
                      setFacts((current) =>
                        current.map((value) =>
                          value.id !== fact.id
                            ? value
                            : {
                                ...value,
                                recipientEntityIds:
                                  checked === true
                                    ? [
                                        ...value.recipientEntityIds,
                                        recipient.entityId,
                                      ]
                                    : value.recipientEntityIds.filter(
                                        (id) => id !== recipient.entityId,
                                      ),
                              },
                        ),
                      )
                    }
                  />
                  {recipient.name} — {recipient.address}
                </label>
              ))}
            </fieldset>
          ))}
          {review.status === "proposed" && facts.length === 0 ? (
            <p>
              No relevant facts were extracted. This does not mark the month
              complete.
            </p>
          ) : null}
          {unresolvedRecipients ? (
            <p role="alert">
              An existing recipient is unavailable. Reload contacts before
              saving this review.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {dirty ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setFacts(details.factsForReview);
                  setExcluded(new Set(details.excludedFactIds));
                }}
              >
                Discard fact edits
              </Button>
            ) : null}
            {review.status === "proposed" || review.status === "reviewed" ? (
              <Button
                variant="accentDarkHover"
                disabled={
                  busy || unresolvedRecipients || sourceStatus.state !== "ready"
                }
                onClick={() =>
                  save(facts.filter((fact) => !excluded.has(fact.id)))
                }
              >
                Save reviewed facts
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => change("withdraw")}
            >
              Withdraw source
            </Button>
          </div>
        </>
      )}
    </article>
  );
}

export function FamilyIntakePanel({
  period,
  adapter,
  emailOptions,
  onChanged,
  onEditStateChange,
  missingSections = [],
}: {
  period: string;
  missingSections?: readonly string[];
  adapter: FamilyIntakeAdapter;
  emailOptions: Loadable<FamilyEmailOptions>;
  onChanged: () => Promise<void>;
  onEditStateChange?: (state: { busy: boolean; unsaved: boolean }) => void;
}) {
  const formId = useId();
  const [reviews, setReviews] = useState<FamilyIntakeReviewDetails[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [dirtyReviews, setDirtyReviews] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyReviews((current) =>
      current[id] === dirty ? current : { ...current, [id]: dirty },
    );
  }, []);
  const unsaved = Boolean(
    title || text || Object.values(dirtyReviews).some(Boolean),
  );
  useEffect(() => {
    onEditStateChange?.({ busy, unsaved });
  }, [busy, unsaved, onEditStateChange]);
  const importAttempt = useRef<{
    id: string;
    title: string;
    text: string;
    periodKey: string;
  } | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const result = await adapter.list(period);
      if (ticket === generation.current) {
        setReviews(result);
        setError(null);
      }
    } catch (cause) {
      // error-policy:J4 Failed inventory remains visibly unavailable, never empty.
      if (ticket === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load selected correspondence",
        );
    }
  }, [adapter, period]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  const run = async (action: () => Promise<FamilyIntakeReview>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      await onChanged();
      return true;
    } catch (cause) {
      // error-policy:J4 A rejected save retains the source and editable review.
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save correspondence",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const importSource = async () => {
    if (
      !importAttempt.current ||
      importAttempt.current.text !== text ||
      importAttempt.current.title !== title ||
      importAttempt.current.periodKey !== period
    )
      importAttempt.current = {
        id: crypto.randomUUID(),
        title,
        text,
        periodKey: period,
      };
    const result = await adapter.importSource(importAttempt.current);
    setText("");
    setTitle("");
    importAttempt.current = null;
    return result;
  };
  return (
    <section
      aria-label="Selected correspondence"
      className="rounded-xl border border-border p-4 space-y-4"
    >
      <h2>Selected correspondence for {period}</h2>
      <FamilyInterviewForm
        period={period}
        busy={busy}
        missingSections={missingSections}
        onDirtyChange={onDirtyChange}
        save={(input) => run(() => adapter.answerInterview(input))}
      />
      <p>
        Paste an email or message you want considered. It stays private until
        you review the extracted facts and choose their recipients. Nothing is
        sent here.
      </p>
      <label className="grid gap-2" htmlFor={`${formId}-title`}>
        Source title
        <Input
          id={`${formId}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="grid gap-2" htmlFor={`${formId}-text`}>
        Email or message text
        <Textarea
          id={`${formId}-text`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
          rows={6}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="accentDarkHover"
          disabled={busy || !text.trim() || !title.trim()}
          onClick={() => void run(importSource)}
        >
          Add private source
        </Button>
        {title || text ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setTitle("");
              setText("");
              importAttempt.current = null;
            }}
          >
            Clear unsaved source
          </Button>
        ) : null}
      </div>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload sources
          </Button>
        </div>
      ) : null}
      {reviews === null ? (
        <p role="status">
          {error
            ? "Sources are unavailable."
            : "Loading selected correspondence…"}
        </p>
      ) : reviews.length === 0 ? (
        <p>No correspondence selected for this month.</p>
      ) : (
        reviews.map((details) => (
          <IntakeReview
            key={`${details.review.id}:${details.review.revision}`}
            details={details}
            onDirtyChange={onDirtyChange}
            busy={busy}
            decide={(decision) =>
              run(() =>
                adapter.decideRequest(
                  details.review.id,
                  details.review.revision,
                  decision,
                ),
              )
            }
            recipients={
              emailOptions.status === "ready"
                ? emailOptions.data.recipients
                : []
            }
            save={(facts) =>
              void run(() =>
                adapter.review(
                  details.review.id,
                  details.review.revision,
                  facts,
                ),
              )
            }
            change={(operation) =>
              void run(() =>
                adapter.change(
                  details.review.id,
                  operation,
                  details.review.revision,
                ),
              )
            }
          />
        ))
      )}
      {emailOptions.status === "unavailable" ? (
        <p role="alert">
          Recipient choices unavailable: {emailOptions.message}
        </p>
      ) : null}
    </section>
  );
}
