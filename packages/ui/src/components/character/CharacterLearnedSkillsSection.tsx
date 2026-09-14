/**
 * Lists and curates the skills the agent has learned or refined from its own
 * trajectories — the agent-authored curated skills (source !== "human") read
 * from `/api/skills/curated` and grouped by status (proposed / active /
 * disabled). Backs the promoted top-level Skills view and the skills section of
 * the character hub; distinct from developer-managed Agent Skills.
 * Pass `showTitle={false}` when a host ViewHeader already renders the title.
 */
import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import { dispatchChatPrefill } from "../../events";
import { useFetchData } from "../../hooks";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";

type TranslateFn = TranslationContextValue["t"];

type CuratedStatus = "active" | "proposed" | "disabled";
type CuratedSource = "human" | "agent-generated" | "agent-refined";

interface CuratedSkill {
  name: string;
  description: string;
  source: CuratedSource;
  derivedFromTrajectory?: string;
  createdAt: string;
  refinedCount: number;
  lastEvalScore?: number;
  status: CuratedStatus;
}

interface ListResponse {
  skills: CuratedSkill[];
}

function formatScore(score: number | undefined): string {
  if (score === undefined) return "—";
  return `${Math.round(score * 100)}%`;
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function CharacterLearnedSkillsSection({
  showTitle = true,
}: {
  /** Hide the in-body "Skills" heading when the host view already renders a
   *  ViewHeader with the same title (the promoted top-level view). */
  showTitle?: boolean;
} = {}) {
  const { t } = useTranslation();
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(
    null,
  );
  const [busyName, setBusyName] = useState<string | null>(null);

  const fetchState = useFetchData<CuratedSkill[]>(async (signal) => {
    const res = (await client.fetch("/api/skills/curated", {
      signal,
    })) as ListResponse;
    return res.skills.filter((s) => s.source !== "human");
  }, []);

  const skills = fetchState.status === "success" ? fetchState.data : [];
  const loading = fetchState.status === "loading";
  const fetchErrorMessage =
    fetchState.status === "error" ? fetchState.error.message : null;
  const errorMessage = actionErrorMessage ?? fetchErrorMessage;
  const refresh = fetchState.refetch;

  const grouped = useMemo(() => {
    const proposed = skills.filter((s) => s.status === "proposed");
    const active = skills.filter((s) => s.status === "active");
    const disabled = skills.filter((s) => s.status === "disabled");
    return { proposed, active, disabled };
  }, [skills]);

  const performAction = useCallback(
    async (
      name: string,
      method: "POST" | "DELETE",
      action: "promote" | "disable" | "delete",
    ) => {
      setBusyName(name);
      setActionErrorMessage(null);
      try {
        const path =
          action === "delete"
            ? `/api/skills/curated/${encodeURIComponent(name)}`
            : `/api/skills/curated/${encodeURIComponent(name)}/${action}`;
        await client.fetch(path, { method });
        refresh();
      } catch (err) {
        setActionErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  const isEmpty =
    !loading &&
    grouped.proposed.length === 0 &&
    grouped.active.length === 0 &&
    grouped.disabled.length === 0;

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      data-testid="character-learned-skills-panel"
    >
      <div className="min-w-0">
        {showTitle ? (
          <h2 className="text-lg font-semibold text-txt">
            {t("learnedskills.title", { defaultValue: "Skills" })}
          </h2>
        ) : null}
        <div className="mt-1 text-2xs text-muted">
          {loading
            ? t("learnedskills.loading", { defaultValue: "Loading" })
            : t("learnedskills.summary", {
                proposed: grouped.proposed.length,
                active: grouped.active.length,
                disabled: grouped.disabled.length,
                defaultValue:
                  "{{proposed}} proposed · {{active}} active · {{disabled}} disabled",
              })}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {errorMessage ? (
          <div className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs-tight leading-5 text-danger">
            {errorMessage}
          </div>
        ) : null}

        {grouped.proposed.length > 0 ? (
          <SkillSection
            title={t("learnedskills.pendingProposals", {
              defaultValue: "Pending proposals",
            })}
            skills={grouped.proposed}
            busyName={busyName}
            onPromote={(name) => performAction(name, "POST", "promote")}
            onDelete={(name) => performAction(name, "DELETE", "delete")}
            t={t}
          />
        ) : null}
        {grouped.active.length > 0 ? (
          <SkillSection
            title={t("learnedskills.activeSkills", {
              defaultValue: "Active learned skills",
            })}
            skills={grouped.active}
            busyName={busyName}
            onDisable={(name) => performAction(name, "POST", "disable")}
            onDelete={(name) => performAction(name, "DELETE", "delete")}
            t={t}
          />
        ) : null}
        {grouped.disabled.length > 0 ? (
          <SkillSection
            title={t("learnedskills.disabled", { defaultValue: "Disabled" })}
            skills={grouped.disabled}
            busyName={busyName}
            onDelete={(name) => performAction(name, "DELETE", "delete")}
            t={t}
          />
        ) : null}

        {isEmpty ? (
          <div className="flex max-w-lg flex-col items-start gap-3 py-6 md:mx-auto md:min-h-[50vh] md:items-center md:justify-center md:text-center">
            <div>
              <h2 className="text-base font-semibold text-txt">
                {t("learnedskills.emptyTitle", {
                  defaultValue: "No learned skills yet",
                })}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                {t("learnedskills.empty", {
                  defaultValue:
                    "Ask Eliza to practice a capability. Skills that are ready for review will appear here.",
                })}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              data-chat-open="true"
              onClick={() =>
                dispatchChatPrefill({
                  text: "Help me learn a new skill. Ask what capability I want to practice.",
                })
              }
            >
              {t("learnedskills.startLearning", {
                defaultValue: "Learn a skill",
              })}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function slugifySkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function SkillActionButton({
  skill,
  action,
  label,
  variant,
  disabled,
  onActivate,
}: {
  skill: string;
  action: "promote" | "disable" | "delete";
  label: string;
  variant: "default" | "outline" | "ghost";
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `learned-skill-${action}-${slugifySkillName(skill)}`,
    role: "button",
    label: `${label} ${skill}`,
    group: "learned-skills",
    description: `${label} the ${skill} learned skill`,
    onActivate,
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onActivate}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

interface SkillSectionProps {
  title: string;
  skills: CuratedSkill[];
  busyName: string | null;
  onPromote?: (name: string) => void;
  onDisable?: (name: string) => void;
  onDelete: (name: string) => void;
  t: TranslateFn;
}

function SkillSection({
  title,
  skills,
  busyName,
  onPromote,
  onDisable,
  onDelete,
  t,
}: SkillSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-muted">{title}</div>
      <ul className="flex flex-col">
        {skills.map((skill) => (
          <li key={skill.name} className="py-3">
            <div className="flex items-start justify-between gap-3 text-xs-tight">
              <div className="flex flex-col gap-1">
                <div className="font-mono text-sm font-semibold text-txt">
                  {skill.name}
                </div>
                <div className="text-xs-tight text-muted">
                  {skill.description}
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-1 text-2xs text-muted">
                  <span>{skill.source}</span>
                  <span>
                    {t("learnedskills.refinements", {
                      count: skill.refinedCount,
                      defaultValue: "{{count}} refinements",
                    })}
                  </span>
                  <span>
                    {t("learnedskills.score", {
                      score: formatScore(skill.lastEvalScore),
                      defaultValue: "{{score}} score",
                    })}
                  </span>
                  <span>{formatDate(skill.createdAt)}</span>
                </div>
                {skill.derivedFromTrajectory ? (
                  <div className="text-2xs text-muted">
                    {t("learnedskills.derivedFrom", {
                      defaultValue: "Derived from trajectory:",
                    })}{" "}
                    <a
                      href={`/trajectories/${skill.derivedFromTrajectory}`}
                      className="underline"
                    >
                      {skill.derivedFromTrajectory.slice(0, 8)}…
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {onPromote ? (
                  <SkillActionButton
                    skill={skill.name}
                    action="promote"
                    label={t("learnedskills.promote", {
                      defaultValue: "Promote",
                    })}
                    variant="default"
                    disabled={busyName === skill.name}
                    onActivate={() => onPromote(skill.name)}
                  />
                ) : null}
                {onDisable ? (
                  <SkillActionButton
                    skill={skill.name}
                    action="disable"
                    label={t("learnedskills.disable", {
                      defaultValue: "Disable",
                    })}
                    variant="outline"
                    disabled={busyName === skill.name}
                    onActivate={() => onDisable(skill.name)}
                  />
                ) : null}
                <SkillActionButton
                  skill={skill.name}
                  action="delete"
                  label={t("learnedskills.delete", {
                    defaultValue: "Delete",
                  })}
                  variant="ghost"
                  disabled={busyName === skill.name}
                  onActivate={() => onDelete(skill.name)}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
