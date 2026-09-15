/** Captures explicit owner answers privately, preserving failed drafts and retry identities until the canonical source is saved. */
import {
  Button,
  Checkbox,
  NativeSelect,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "@elizaos/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { FamilyInterviewAnswer } from "../../lifeops/family-coordination/interview.js";

type Section = FamilyInterviewAnswer["section"];
const topics: Record<Section, { label: string; question: string }> = {
  custody_calendar: {
    label: "Parenting schedule",
    question:
      "Any pickup, custody, or scheduling information missing from the selected sources?",
  },
  school: {
    label: "School and activities",
    question:
      "Any school or extracurricular update that is not in the calendar or selected messages?",
  },
  travel_consent_health: {
    label: "Travel, consent and health",
    question: "Any travel, consent, or health update you want included?",
  },
  unanswered: {
    label: "Unanswered requests",
    question: "Any additional request that still needs an answer?",
  },
};

const sections = [
  "custody_calendar",
  "school",
  "travel_consent_health",
  "unanswered",
] as const satisfies readonly Section[];

export function FamilyInterviewForm({
  period,
  busy,
  missingSections,
  onDirtyChange,
  save,
}: {
  period: string;
  busy: boolean;
  missingSections: readonly string[];
  onDirtyChange: (id: string, dirty: boolean) => void;
  save: (input: FamilyInterviewAnswer) => Promise<boolean>;
}) {
  const formId = useId();
  const [section, setSection] = useState<Section>(
    () => sections.find((value) => missingSections.includes(value)) ?? "school",
  );
  const [kind, setKind] = useState<
    "" | FamilyInterviewAnswer["answer"]["kind"]
  >("");
  const [text, setText] = useState("");
  const [unanswered, setUnanswered] = useState(false);
  const attempt = useRef<{ key: string; input: FamilyInterviewAnswer } | null>(
    null,
  );
  const dirty = Boolean(kind || text || unanswered);
  useEffect(() => {
    onDirtyChange("interview", dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange("interview", false), [onDirtyChange]);
  const reset = () => {
    setKind("");
    setText("");
    setUnanswered(false);
    attempt.current = null;
  };
  const submit = async () => {
    if (busy || kind === "" || (kind === "update" && !text.trim())) return;
    const answer: FamilyInterviewAnswer["answer"] =
      kind === "update" ? { kind, text, unanswered } : { kind };
    const payload = {
      periodKey: period,
      section,
      answer,
      recipientEntityIds: [],
    };
    const key = JSON.stringify(payload);
    if (!attempt.current || attempt.current.key !== key)
      attempt.current = { key, input: { id: crypto.randomUUID(), ...payload } };
    if (await save(attempt.current.input)) reset();
  };
  return (
    <details className="rounded-xl border border-border p-4 space-y-3">
      <summary>Fill missing information</summary>
      <p>
        An empty section is not confirmation that there is nothing to report.
        Record your own answer below.
      </p>
      {sections.some((value) => missingSections.includes(value)) ? (
        <p>
          Needs information:{" "}
          {sections
            .filter((value) => missingSections.includes(value))
            .map((value) => topics[value].label)
            .join(", ")}
          .
        </p>
      ) : null}
      <form
        aria-label="Owner interview"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="space-y-3">
          <label className="grid gap-2" htmlFor={`${formId}-section`}>
            Topic
            <NativeSelect
              id={`${formId}-section`}
              value={section}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "custody_calendar" ||
                  value === "school" ||
                  value === "travel_consent_health" ||
                  value === "unanswered"
                )
                  setSection(value);
              }}
            >
              {Object.entries(topics).map(([key, topic]) => (
                <option key={key} value={key}>
                  {topic.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <p>{topics[section].question}</p>
          <RadioGroup
            value={kind}
            onValueChange={(value) => {
              if (value === "update" || value === "no_additional_updates")
                setKind(value);
            }}
          >
            <label
              htmlFor={`${formId}-update`}
              className="flex items-center gap-2"
            >
              <RadioGroupItem id={`${formId}-update`} value="update" />I have an
              update
            </label>
            <label
              htmlFor={`${formId}-none`}
              className="flex items-center gap-2"
            >
              <RadioGroupItem
                id={`${formId}-none`}
                value="no_additional_updates"
              />
              I have no additional updates
            </label>
          </RadioGroup>
          {kind === "update" ? (
            <>
              <label className="grid gap-2" htmlFor={`${formId}-answer`}>
                Your update
                <Textarea
                  id={`${formId}-answer`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={4}
                />
              </label>
              <label
                htmlFor={`${formId}-unanswered`}
                className="flex items-center gap-2"
              >
                <Checkbox
                  id={`${formId}-unanswered`}
                  checked={unanswered}
                  onCheckedChange={(checked) => setUnanswered(checked === true)}
                />
                This update needs an answer
              </label>
            </>
          ) : null}
          <p>
            Your answer is saved privately. Choose recipients in its source
            review before including it in an email. “No additional updates” does
            not resolve earlier requests.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="accentDarkHover"
              disabled={kind === "" || (kind === "update" && !text.trim())}
            >
              Save private answer
            </Button>
            {dirty ? (
              <Button type="button" variant="outline" onClick={reset}>
                Discard answer
              </Button>
            ) : null}
          </div>
        </fieldset>
      </form>
    </details>
  );
}
