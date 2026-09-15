/**
 * Per-role model configuration for Settings → Models & Providers: three
 * groups (Small model, Large model, Coding sub-agent) driven by the validated
 * catalog + effective config from `useModelConfiguration`. Chat groups arm an
 * explicit restart confirmation before saving — their writes restart the
 * agent server-side — while the coding group saves restart-free and says so.
 *
 * `ModelConfigurationPanel` (mounted by ProviderSwitcher) binds the hook;
 * `ModelConfigurationPanelView` is the pure renderer, exported for stories
 * and tests. All controls use the agent-addressable settings rows so the
 * whole panel is drivable from chat.
 */
import { CheckCircle2, Loader2 } from "lucide-react";
import { useAppSelector } from "../../state";
import { Skeleton } from "../ui/skeleton";
import {
  SettingsActionButton,
  SettingsInputRow,
  SettingsSegmentedRow,
  SettingsSelectRow,
  SettingsSwitchRow,
} from "./settings-agent-rows";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import {
  type ConfiguredValue,
  type ModelConfigChatGroup,
  type ModelConfigCodingGroup,
  type ModelConfigurationState,
  type ModelGroupSaveState,
  useModelConfiguration,
} from "./useModelConfiguration";

type Translator = (key: string, vars?: Record<string, unknown>) => string;

function sourceNote(
  configured: ConfiguredValue | null,
  currentModel: string,
  t: Translator,
): string | null {
  if (!configured || configured.model !== currentModel) return null;
  if (configured.source === "process.env") {
    return t("modelconfig.sourceEnvironment", {
      defaultValue: "Set by environment",
    });
  }
  if (configured.source === "default") {
    return t("modelconfig.sourceDefault", {
      defaultValue: "Built-in default",
    });
  }
  return null;
}

function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const parts = notes.filter((note): note is string => Boolean(note));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function modelOptionLabel(entry: {
  display: string;
  costHint?: string;
  apiSupported?: boolean;
}) {
  const suffixes = [
    ...(entry.costHint ? [entry.costHint] : []),
    ...(entry.apiSupported === false ? ["not API-callable"] : []),
  ];
  if (suffixes.length === 0) return entry.display;
  return (
    <span>
      {entry.display}{" "}
      <span className="text-muted">— {suffixes.join(", ")}</span>
    </span>
  );
}

function SaveErrorNotice({
  save,
  t,
}: {
  save: ModelGroupSaveState;
  t: Translator;
}) {
  if (save.phase !== "error") return null;
  return (
    <div role="alert" className="py-1.5 text-xs leading-relaxed text-warn">
      <span>{save.message}</span>
      {save.supported !== undefined && save.supported.length > 0 ? (
        <span className="block text-muted">
          {t("modelconfig.supportedValues", {
            defaultValue: "Supported: {{values}}",
            values: save.supported.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

function SaveStatus({
  save,
  restartCopy,
  t,
}: {
  save: ModelGroupSaveState;
  restartCopy: boolean;
  t: Translator;
}) {
  if (save.phase === "saving") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs text-muted"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("modelconfig.saving", { defaultValue: "Saving…" })}
      </span>
    );
  }
  if (save.phase === "restarting") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs text-muted"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("modelconfig.restarting", { defaultValue: "Restarting agent…" })}
      </span>
    );
  }
  if (save.phase === "saved") {
    return (
      <span
        role="status"
        className="inline-flex flex-col items-end gap-0.5 text-xs text-ok"
      >
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {restartCopy
            ? t("modelconfig.savedRestarted", { defaultValue: "Saved" })
            : t("modelconfig.savedNoRestart", {
                defaultValue: "Saved. Applies to the next coding task.",
              })}
        </span>
        {save.conflictKeys !== undefined && save.conflictKeys.length > 0 ? (
          <span className="text-muted">
            {t("modelconfig.conflictingServiceEnv", {
              defaultValue:
                "Service env also sets {{keys}} — a full service restart may override this value.",
              keys: save.conflictKeys.join(", "),
            })}
          </span>
        ) : null}
      </span>
    );
  }
  return null;
}

interface LoadingRowShape {
  id: string;
  description?: boolean;
  controlWidth: string;
}

function ModelConfigurationLoadingGroup({
  title,
  description,
  rows,
  statusLabel,
}: {
  title: string;
  description: string;
  rows: LoadingRowShape[];
  statusLabel?: string;
}) {
  return (
    <SettingsGroup
      title={title}
      description={description}
      bare
      {...(statusLabel
        ? {
            role: "status",
            "aria-label": statusLabel,
            "data-testid": "model-config-loading",
          }
        : { "aria-hidden": true })}
    >
      {statusLabel ? <span className="sr-only">{statusLabel}</span> : null}
      <div className="flex flex-col" aria-hidden>
        {rows.map((row) => (
          <SettingsRow
            // The loading geometry mirrors the final settings rows so the
            // async catalog/config swap does not push the visible page around.
            key={row.id}
            label={<Skeleton className="h-4 w-24" />}
            description={
              row.description ? <Skeleton className="mt-1 h-3 w-40" /> : null
            }
            control={<Skeleton className={`h-9 ${row.controlWidth}`} />}
          />
        ))}
      </div>
    </SettingsGroup>
  );
}

function ChatModelGroup({
  group,
  title,
  description,
  t,
}: {
  group: ModelConfigChatGroup;
  title: string;
  description: string;
  t: Translator;
}) {
  const { target, save } = group;
  const note = sourceNote(group.configured, group.model, t);
  const busy = save.phase === "saving" || save.phase === "restarting";

  return (
    <SettingsGroup title={title} description={description} bare>
      {group.providerLocked ? (
        // The provider follows the active intelligence selection above; a free
        // dropdown here would let models be picked from a provider the runtime
        // isn't routing chat through (dead keys, confusing pairings).
        <SettingsRow
          label={t("modelconfig.provider", { defaultValue: "Provider" })}
          description={t("modelconfig.providerFollowsActive", {
            defaultValue: "Follows your active provider.",
          })}
          control={
            <span className="text-sm text-txt">
              {group.providerOptions.find((o) => o.value === group.provider)
                ?.label ?? group.provider}
            </span>
          }
        />
      ) : (
        <SettingsSelectRow
          agentId={`models-${target}-provider`}
          label={t("modelconfig.provider", { defaultValue: "Provider" })}
          value={group.provider}
          onValueChange={group.setProvider}
          options={group.providerOptions}
          placeholder={t("modelconfig.chooseProvider", {
            defaultValue: "Choose a provider",
          })}
          disabled={busy}
          triggerClassName="w-full"
        />
      )}
      <SettingsSelectRow
        agentId={`models-${target}-model`}
        label={t("modelconfig.model", { defaultValue: "Model" })}
        description={joinNotes(note, group.selectedEntry?.costHint)}
        value={group.model}
        onValueChange={group.setModel}
        options={group.modelOptions.map((entry) => ({
          value: entry.id,
          label: modelOptionLabel(entry),
        }))}
        placeholder={t("modelconfig.chooseModel", {
          defaultValue: "Choose a model",
        })}
        disabled={busy || group.modelOptions.length === 0}
        triggerClassName="w-full"
      />
      {group.effortOptions.length > 0 ? (
        <SettingsSelectRow
          agentId={`models-${target}-effort`}
          label={t("modelconfig.effort", {
            defaultValue: "Reasoning effort",
          })}
          description={
            group.sharedEffortKnob
              ? t("modelconfig.sharedEffortNote", {
                  defaultValue:
                    "One shared knob (OPENAI_REASONING_EFFORT) — also applies to the other chat model on this provider family.",
                })
              : undefined
          }
          value={group.effort}
          onValueChange={group.setEffort}
          options={group.effortOptions.map((effort) => ({
            value: effort,
            label: effort,
          }))}
          placeholder={t("modelconfig.chooseEffort", {
            defaultValue: "Choose an effort",
          })}
          disabled={busy}
          triggerClassName="w-full"
        />
      ) : null}
      <SaveErrorNotice save={save} t={t} />
      {save.phase === "confirm" ? (
        <SettingsRow
          label={t("modelconfig.restartConfirmTitle", {
            defaultValue: "Restart to apply?",
          })}
          description={t("modelconfig.restartConfirmBody", {
            defaultValue:
              "Saving this change restarts the agent. Anything in progress is interrupted.",
          })}
          control={
            <span className="flex items-center gap-2">
              <SettingsActionButton
                agentId={`models-${target}-cancel`}
                type="button"
                variant="outline"
                className="h-9 px-3 text-xs font-medium"
                onClick={group.cancelSave}
              >
                {t("modelconfig.cancel", { defaultValue: "Cancel" })}
              </SettingsActionButton>
              <SettingsActionButton
                agentId={`models-${target}-confirm-restart`}
                type="button"
                variant="default"
                className="h-9 px-3 text-xs font-medium"
                onClick={group.confirmSave}
              >
                {t("modelconfig.confirmRestart", {
                  defaultValue: "Restart & apply",
                })}
              </SettingsActionButton>
            </span>
          }
        />
      ) : (
        <SettingsRow
          label={t("modelconfig.applyChanges", {
            defaultValue: "Apply changes",
          })}
          description={t("modelconfig.chatSaveNote", {
            defaultValue: "Saving restarts the agent.",
          })}
          control={
            <span className="flex items-center gap-2">
              <SaveStatus save={save} restartCopy t={t} />
              {!busy && save.phase !== "saved" ? (
                <SettingsActionButton
                  agentId={`models-${target}-save`}
                  type="button"
                  variant="outline"
                  className="h-9 px-3 text-xs font-medium"
                  disabled={!group.model}
                  onClick={group.requestSave}
                >
                  {t("modelconfig.save", { defaultValue: "Save" })}
                </SettingsActionButton>
              ) : null}
            </span>
          }
        />
      )}
    </SettingsGroup>
  );
}

function CodingModelGroup({
  group,
  t,
}: {
  group: ModelConfigCodingGroup;
  t: Translator;
}) {
  const { save } = group;
  const note = sourceNote(group.configured, group.model, t);
  const busy = save.phase === "saving";

  return (
    <SettingsGroup
      title={t("modelconfig.codingGroupTitle", {
        defaultValue: "Coding sub-agent",
      })}
      description={t("modelconfig.codingGroupDescription", {
        defaultValue:
          "The model coding tasks are delegated to. Applies to the next coding task — no restart.",
      })}
      bare
    >
      <SettingsSegmentedRow
        agentId="models-coding-backend"
        label={t("modelconfig.codingBackend", { defaultValue: "Backend" })}
        value={group.backend}
        onValueChange={(value) => {
          const option = group.backendOptions.find(
            (candidate) => candidate.value === value,
          );
          if (option) group.setBackend(option.value);
        }}
        options={group.backendOptions.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        disabled={busy}
      />
      {group.freeFormModel ? (
        <SettingsInputRow
          agentId="models-coding-model"
          label={t("modelconfig.model", { defaultValue: "Model" })}
          description={joinNotes(
            note,
            t("modelconfig.freeFormModelNote", {
              defaultValue:
                "Free-form model id — the in-house backend has no fixed catalog.",
            }),
          )}
          value={group.model}
          onValueChange={group.setModel}
          placeholder={t("modelconfig.freeFormModelPlaceholder", {
            defaultValue: "Model id",
          })}
          disabled={busy}
        />
      ) : (
        <SettingsSelectRow
          agentId="models-coding-model"
          label={t("modelconfig.model", { defaultValue: "Model" })}
          description={joinNotes(note, group.selectedEntry?.costHint)}
          value={group.model}
          onValueChange={group.setModel}
          options={group.modelOptions.map((entry) => ({
            value: entry.id,
            label: modelOptionLabel(entry),
          }))}
          placeholder={t("modelconfig.chooseModel", {
            defaultValue: "Choose a model",
          })}
          disabled={busy || group.modelOptions.length === 0}
          triggerClassName="w-full"
        />
      )}
      {group.effortOptions.length > 0 ? (
        <SettingsSelectRow
          agentId="models-coding-effort"
          label={t("modelconfig.effort", {
            defaultValue: "Reasoning effort",
          })}
          description={group.selectedEntry?.costHint}
          value={group.effort}
          onValueChange={group.setEffort}
          options={group.effortOptions.map((effort) => ({
            value: effort,
            label: effort,
          }))}
          placeholder={t("modelconfig.chooseEffort", {
            defaultValue: "Choose an effort",
          })}
          disabled={busy}
          triggerClassName="w-full"
        />
      ) : null}
      <SettingsSwitchRow
        agentId="models-coding-default"
        label={t("modelconfig.defaultBackend", {
          defaultValue: "Default coding backend",
        })}
        description={t("modelconfig.defaultBackendNote", {
          defaultValue: "Use this backend for new coding tasks.",
        })}
        checked={group.makeDefault}
        onCheckedChange={group.setMakeDefault}
        disabled={busy}
      />
      <SaveErrorNotice save={save} t={t} />
      <SettingsRow
        label={t("modelconfig.applyChanges", {
          defaultValue: "Apply changes",
        })}
        description={t("modelconfig.codingSaveNote", {
          defaultValue: "Applies to the next coding task. No restart needed.",
        })}
        control={
          <span className="flex items-center gap-2">
            <SaveStatus save={save} restartCopy={false} t={t} />
            {!busy && save.phase !== "saved" ? (
              <SettingsActionButton
                agentId="models-coding-save"
                type="button"
                variant="outline"
                className="h-9 px-3 text-xs font-medium"
                disabled={!group.model.trim()}
                onClick={group.saveNow}
              >
                {t("modelconfig.save", { defaultValue: "Save" })}
              </SettingsActionButton>
            ) : null}
          </span>
        }
      />
    </SettingsGroup>
  );
}

export function ModelConfigurationPanelView({
  state,
  t,
  showChatModels = true,
  showCodingModels = true,
}: {
  state: ModelConfigurationState;
  t: Translator;
  showChatModels?: boolean;
  showCodingModels?: boolean;
}) {
  if (state.phase === "loading") {
    return (
      <>
        <ModelConfigurationLoadingGroup
          title={t("modelconfig.smallGroupTitle", {
            defaultValue: "Small model",
          })}
          description={t("modelconfig.smallGroupDescription", {
            defaultValue:
              "Fast, cheap model for routing and lightweight replies.",
          })}
          statusLabel={t("modelconfig.loading", {
            defaultValue: "Loading model catalog…",
          })}
          rows={[
            { id: "small-provider", description: true, controlWidth: "w-20" },
            { id: "small-model", controlWidth: "w-40" },
            { id: "small-apply", description: true, controlWidth: "w-16" },
          ]}
        />
        <ModelConfigurationLoadingGroup
          title={t("modelconfig.largeGroupTitle", {
            defaultValue: "Large model",
          })}
          description={t("modelconfig.largeGroupDescription", {
            defaultValue: "Primary reasoning model for substantive replies.",
          })}
          rows={[
            { id: "large-provider", description: true, controlWidth: "w-20" },
            { id: "large-model", description: true, controlWidth: "w-40" },
            { id: "large-effort", description: true, controlWidth: "w-24" },
            { id: "large-apply", description: true, controlWidth: "w-16" },
          ]}
        />
        {showCodingModels ? (
          <ModelConfigurationLoadingGroup
            title={t("modelconfig.codingGroupTitle", {
              defaultValue: "Coding sub-agent",
            })}
            description={t("modelconfig.codingGroupDescription", {
              defaultValue:
                "The model coding tasks are delegated to. Applies to the next coding task — no restart.",
            })}
            rows={[
              { id: "coding-backend", controlWidth: "w-48" },
              { id: "coding-model", description: true, controlWidth: "w-40" },
              { id: "coding-effort", description: true, controlWidth: "w-24" },
              { id: "coding-default", description: true, controlWidth: "w-10" },
              { id: "coding-apply", description: true, controlWidth: "w-16" },
            ]}
          />
        ) : null}
      </>
    );
  }
  if (state.phase === "error") {
    return (
      <SettingsGroup
        title={t("modelconfig.panelTitle", { defaultValue: "Models" })}
        bare
      >
        <div role="alert" className="flex flex-col gap-2 py-2">
          <span className="text-xs leading-relaxed text-warn">
            {t("modelconfig.loadError", {
              defaultValue: "Couldn't load the model catalog: {{message}}",
              message: state.message,
            })}
          </span>
          <SettingsActionButton
            agentId="models-retry"
            type="button"
            variant="outline"
            className="h-9 w-fit px-3 text-xs font-medium"
            onClick={state.retry}
          >
            {t("modelconfig.retry", { defaultValue: "Retry" })}
          </SettingsActionButton>
        </div>
      </SettingsGroup>
    );
  }
  if (state.phase === "empty") {
    return (
      <SettingsGroup
        title={t("modelconfig.panelTitle", { defaultValue: "Models" })}
        bare
      >
        <div className="flex flex-col gap-2 py-2">
          <span className="text-xs leading-relaxed text-muted">
            {t("modelconfig.emptyCatalog", {
              defaultValue:
                "No configurable models were reported by the runtime.",
            })}
          </span>
          <SettingsActionButton
            agentId="models-retry"
            type="button"
            variant="outline"
            className="h-9 w-fit px-3 text-xs font-medium"
            onClick={state.retry}
          >
            {t("modelconfig.retry", { defaultValue: "Retry" })}
          </SettingsActionButton>
        </div>
      </SettingsGroup>
    );
  }
  return (
    <>
      {showChatModels ? (
        <>
          <ChatModelGroup
            group={state.small}
            title={t("modelconfig.smallGroupTitle", {
              defaultValue: "Small model",
            })}
            description={t("modelconfig.smallGroupDescription", {
              defaultValue:
                "Fast, cheap model for routing and lightweight replies.",
            })}
            t={t}
          />
          <ChatModelGroup
            group={state.large}
            title={t("modelconfig.largeGroupTitle", {
              defaultValue: "Large model",
            })}
            description={t("modelconfig.largeGroupDescription", {
              defaultValue: "Primary reasoning model for substantive replies.",
            })}
            t={t}
          />
        </>
      ) : null}
      {showCodingModels ? (
        <CodingModelGroup group={state.coding} t={t} />
      ) : null}
    </>
  );
}

export function ModelConfigurationPanel({
  activeChatProvider,
  showChatModels = true,
  showCodingModels = true,
}: {
  /** Catalog chat provider implied by the active intelligence selection;
   * pins the small/large provider so models track what actually routes chat. */
  activeChatProvider?: string;
  /** Subscription chat does not use the API-key small/large model controls. */
  showChatModels?: boolean;
  showCodingModels?: boolean;
}) {
  const t = useAppSelector((s) => s.t);
  const state = useModelConfiguration({ activeChatProvider });
  return (
    <ModelConfigurationPanelView
      state={state}
      t={t}
      showChatModels={showChatModels}
      showCodingModels={showCodingModels}
    />
  );
}
