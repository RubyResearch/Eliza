/** Records an explicit owner resolution or reopening reason without losing failed drafts or changing retry identity. */
import { Button, Textarea } from "@elizaos/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { FamilyIntakeReview } from "../../lifeops/family-coordination/intake-review.js";

type Decision = NonNullable<FamilyIntakeReview["requestDecision"]>;

export function FamilyRequestDecision({
  factId,
  unanswered,
  disabled,
  onDirtyChange,
  save,
}: {
  factId: string;
  unanswered: boolean;
  disabled: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
  save: (decision: Decision) => Promise<boolean>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const attempt = useRef<Decision | null>(null);
  const state = unanswered ? "resolved" : "open";
  useEffect(() => {
    onDirtyChange(`request:${factId}`, Boolean(reason));
  }, [factId, reason, onDirtyChange]);
  useEffect(
    () => () => onDirtyChange(`request:${factId}`, false),
    [factId, onDirtyChange],
  );
  const submit = async () => {
    if (disabled || !reason.trim()) return;
    if (
      !attempt.current ||
      attempt.current.reason !== reason ||
      attempt.current.state !== state
    )
      attempt.current = {
        operationId: crypto.randomUUID(),
        factId,
        state,
        reason,
      };
    if (await save(attempt.current)) {
      setReason("");
      attempt.current = null;
    }
  };
  return (
    <details className="space-y-3">
      <summary>{unanswered ? "Resolve request" : "Reopen request"}</summary>
      <label htmlFor={id} className="grid gap-2">
        {unanswered
          ? "What resolved this request?"
          : "Why does this need an answer again?"}
        <Textarea
          id={id}
          value={reason}
          disabled={disabled}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <p>
        Your reason is recorded privately with this source review. Nothing is
        sent here.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="accentDarkHover"
          disabled={disabled || !reason.trim()}
          onClick={() => void submit()}
        >
          {unanswered ? "Mark resolved" : "Reopen request"}
        </Button>
        {reason ? (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setReason("");
              attempt.current = null;
            }}
          >
            Discard reason
          </Button>
        ) : null}
      </div>
    </details>
  );
}
