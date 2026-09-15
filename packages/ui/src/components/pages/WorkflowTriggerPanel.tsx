/** Presents native elizaOS workflow triggers as a compact visual start surface. */
import {
  CalendarClock,
  Clock3,
  Plus,
  Radio,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import type { WorkflowDefinition } from "../../api/client-types-chat";
import type {
  CreateTriggerRequest,
  TriggerSummary,
  TriggerType,
} from "../../api/client-types-core";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Spinner } from "../ui/spinner";

const WORKFLOW_RUN_EVENT = "workflow_run_event";
type EventMode = "message" | "workflow" | "step";

const EVENT_OPTIONS: ReadonlyArray<{
  value: EventMode;
  label: string;
}> = [
  { value: "message", label: "Message" },
  { value: "workflow", label: "Workflow" },
  { value: "step", label: "Step" },
];

const TYPE_META: Record<TriggerType, { label: string; icon: typeof Clock3 }> = {
  once: { label: "Once", icon: CalendarClock },
  interval: { label: "Repeat", icon: Repeat2 },
  cron: { label: "Cron", icon: Clock3 },
  event: { label: "Event", icon: Radio },
};

function triggerSummary(trigger: TriggerSummary): string {
  if (trigger.triggerType === "once" && trigger.scheduledAtIso) {
    return new Date(trigger.scheduledAtIso).toLocaleString();
  }
  if (trigger.triggerType === "interval" && trigger.intervalMs) {
    const minutes = trigger.intervalMs / 60_000;
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.round(minutes)}m`;
  }
  if (trigger.triggerType === "cron") return trigger.cronExpression ?? "—";
  if (trigger.triggerType === "event") return trigger.displayName;
  return trigger.eventKind ?? "—";
}

export function WorkflowTriggerPanel({
  workflowId,
  workflowName,
  onNeedsSave,
}: {
  workflowId: string;
  workflowName: string;
  onNeedsSave: () => Promise<string | null>;
}) {
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [type, setType] = useState<TriggerType | null>(null);
  const [value, setValue] = useState("");
  const [eventMode, setEventMode] = useState<EventMode>("message");
  const [sources, setSources] = useState<WorkflowDefinition[]>([]);
  const [sourceWorkflowId, setSourceWorkflowId] = useState("");
  const [sourceStepId, setSourceStepId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (targetWorkflowId?: string) => {
      const id = targetWorkflowId ?? workflowId;
      if (!id) return;
      const result = await client.getTriggers();
      setTriggers(
        result.triggers.filter(
          (trigger) => trigger.kind === "workflow" && trigger.workflowId === id,
        ),
      );
    },
    [workflowId],
  );

  useEffect(() => {
    void refresh().catch((cause) => {
      // error-policy:J4 the trigger strip remains usable for manual runs while
      // an unavailable trigger service is shown as an explicit error state.
      setError(cause instanceof Error ? cause.message : "Triggers unavailable");
    });
  }, [refresh]);

  const loadEventSources = useCallback(async () => {
    const definitions = (await client.listWorkflowDefinitions()).filter(
      (definition) => definition.id !== workflowId,
    );
    setSources(definitions);
    setSourceWorkflowId((current) =>
      definitions.some((definition) => definition.id === current)
        ? current
        : (definitions[0]?.id ?? ""),
    );
  }, [workflowId]);

  const sourceWorkflow = sources.find(
    (definition) => definition.id === sourceWorkflowId,
  );
  const sourceStep = sourceWorkflow?.steps?.find(
    (step) => step.id === sourceStepId,
  );

  useEffect(() => {
    const steps = sourceWorkflow?.steps ?? [];
    setSourceStepId((current) =>
      steps.some((step) => step.id === current)
        ? current
        : (steps[0]?.id ?? ""),
    );
  }, [sourceWorkflow]);

  const create = useCallback(async () => {
    if (!type) return;
    setBusy(true);
    setError(null);
    try {
      const id = await onNeedsSave();
      if (!id) return;
      const request: CreateTriggerRequest = {
        kind: "workflow",
        workflowId: id,
        workflowName,
        displayName: `${TYPE_META[type].label}: ${workflowName}`,
        instructions: `Run workflow ${workflowName}`,
        triggerType: type,
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "workflow.studio",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (type === "once")
        request.scheduledAtIso = new Date(value).toISOString();
      if (type === "interval") request.intervalMs = Number(value) * 60_000;
      if (type === "cron") request.cronExpression = value;
      if (type === "event") {
        if (eventMode === "message") {
          request.eventKind = "MESSAGE_RECEIVED";
          request.displayName = "Message";
        } else {
          request.eventKind = WORKFLOW_RUN_EVENT;
          request.eventFilter = {
            event: {
              type: eventMode === "workflow" ? "RunFinished" : "NodeFinished",
              workflowId: sourceWorkflowId,
              ...(eventMode === "step" ? { nodeId: sourceStepId } : {}),
            },
          };
          request.displayName =
            eventMode === "workflow"
              ? `After ${sourceWorkflow?.name ?? sourceWorkflowId}`
              : `After ${sourceStep?.label ?? sourceStepId}`;
        }
      }
      await client.createTrigger(request);
      setType(null);
      setValue("");
      await refresh(id);
    } catch (cause) {
      // error-policy:J4 create failures remain visible beside the attempted trigger.
      setError(
        cause instanceof Error ? cause.message : "Unable to add trigger",
      );
    } finally {
      setBusy(false);
    }
  }, [
    eventMode,
    onNeedsSave,
    refresh,
    sourceStepId,
    sourceStep?.label,
    sourceWorkflowId,
    sourceWorkflow?.name,
    type,
    value,
    workflowName,
  ]);

  const eventReady =
    eventMode === "message" ||
    (Boolean(sourceWorkflowId) &&
      (eventMode === "workflow" || Boolean(sourceStepId)));
  const canCreate = type === "event" ? eventReady : Boolean(value);

  return (
    <section aria-label="Workflow triggers" className="bg-card/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        <span
          className="size-2 shrink-0 rounded-full bg-status-success"
          title="Manual"
        >
          <span className="sr-only">Manual</span>
        </span>
        {triggers.map((trigger) => {
          const meta = TYPE_META[trigger.triggerType];
          const Icon = meta.icon;
          return (
            <span
              key={trigger.id}
              className="group flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-xs"
              title={`${meta.label} · ${triggerSummary(trigger)}`}
            >
              <Icon className="size-3.5 text-primary" />
              <span>{triggerSummary(trigger)}</span>
              <Button
                type="button"
                variant="dangerGhost"
                size="disclosure"
                className="ml-0.5"
                aria-label={`Delete ${meta.label} trigger`}
                onClick={() =>
                  void client
                    .deleteTrigger(trigger.id)
                    .then(() => refresh())
                    .catch((cause) => {
                      // error-policy:J4 deletion failures preserve the trigger and surface the error.
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Unable to delete trigger",
                      );
                    })
                }
              >
                <Trash2 className="size-3" />
              </Button>
            </span>
          );
        })}
        <Button
          type="button"
          variant="ghostMuted"
          size="icon-sm"
          shape="circle"
          className="shrink-0"
          aria-label="Add workflow trigger"
          onClick={() => setType((current) => current ?? "once")}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {type ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="workflow-trigger-form"
        >
          {(Object.keys(TYPE_META) as TriggerType[]).map((option) => {
            const Icon = TYPE_META[option].icon;
            return (
              <Button
                key={option}
                type="button"
                variant="selection"
                size="icon-sm"
                data-state={type === option ? "on" : "off"}
                aria-label={TYPE_META[option].label}
                aria-pressed={type === option}
                title={TYPE_META[option].label}
                onClick={() => {
                  setType(option);
                  setValue("");
                  if (option === "event") {
                    setEventMode("message");
                    void loadEventSources().catch((cause) => {
                      // error-policy:J4 source loading failures leave message events available.
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Workflows unavailable",
                      );
                    });
                  }
                }}
              >
                <Icon className="size-4" />
              </Button>
            );
          })}
          {type === "event" ? (
            <>
              <NativeSelect
                presentation="compact"
                aria-label="Event source"
                value={eventMode}
                onChange={(event) =>
                  setEventMode(event.target.value as EventMode)
                }
                className="min-w-28"
              >
                {EVENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
              {eventMode !== "message" ? (
                <NativeSelect
                  presentation="compact"
                  aria-label="Source workflow"
                  value={sourceWorkflowId}
                  onChange={(event) => setSourceWorkflowId(event.target.value)}
                  className="min-w-32 flex-1"
                >
                  {sources.length === 0 ? (
                    <option value="">No source</option>
                  ) : null}
                  {sources.map((definition) => (
                    <option key={definition.id} value={definition.id}>
                      {definition.name}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
              {eventMode === "step" ? (
                <NativeSelect
                  presentation="compact"
                  aria-label="Source step"
                  value={sourceStepId}
                  onChange={(event) => setSourceStepId(event.target.value)}
                  className="min-w-28 flex-1"
                >
                  {(sourceWorkflow?.steps ?? []).length === 0 ? (
                    <option value="">No steps</option>
                  ) : null}
                  {(sourceWorkflow?.steps ?? []).map((step) => (
                    <option key={step.id} value={step.id}>
                      {step.label}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
            </>
          ) : (
            <Input
              type={
                type === "once"
                  ? "datetime-local"
                  : type === "interval"
                    ? "number"
                    : "text"
              }
              min={type === "interval" ? 1 : undefined}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                type === "interval"
                  ? "Minutes"
                  : type === "cron"
                    ? "0 9 * * 1-5"
                    : undefined
              }
              aria-label={
                type === "interval"
                  ? "Interval minutes"
                  : type === "cron"
                    ? "Cron expression"
                    : "Start time"
              }
              density="compact"
              className="min-w-40 flex-1"
            />
          )}
          <Button
            size="icon-sm"
            aria-label="Save trigger"
            disabled={busy || !canCreate}
            onClick={() => void create()}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel trigger"
            onClick={() => setType(null)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
