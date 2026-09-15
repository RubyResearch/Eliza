/**
 * Renders one native tool-call event (a `NativeToolCallEvent` from the agent's
 * activity stream) as a collapsible log row: a running/success/preview/failure status
 * icon and the tool name, expanding to show the truncated argument/result
 * previews and pretty-printed JSON. State + name derivation live in
 * `ToolCallEventLog.helpers`.
 */
import { CheckCircle, ChevronDown, Clock3, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import { Button } from "../ui/button";
import { CodeBlock } from "../ui/code-block";
import {
  getToolCallEventDisplayState,
  getToolCallName,
} from "./ToolCallEventLog.helpers";

export interface ToolCallEventLogProps {
  event: NativeToolCallEvent;
  className?: string;
}

export type ToolCallEventDisplayState =
  | "running"
  | "success"
  | "failure"
  | "preview";

function previewValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StatePill({ state }: { state: ToolCallEventDisplayState }) {
  // Plain colored text, no pill chrome: the state color alone carries the
  // signal inside the chat flow (chat-native de-slop).
  const styles = {
    running: "text-primary",
    success: "text-success",
    failure: "text-danger",
    preview: "text-muted",
  };
  const labels = {
    running: "Running",
    success: "Success",
    failure: "Failure",
    preview: "Preview · no changes",
  };
  return (
    <span
      className={`inline-flex items-center text-xs-tight font-semibold uppercase tracking-[0.12em] ${styles[state]}`}
    >
      {labels[state]}
    </span>
  );
}

function StateIcon({ state }: { state: ToolCallEventDisplayState }) {
  if (state === "success") return <CheckCircle className="size-4" />;
  if (state === "failure") return <XCircle className="size-4" />;
  return <Clock3 className="size-4" />;
}

function PreviewRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-xs-tight text-txt">
        {value}
      </div>
    </div>
  );
}

export function ToolCallEventLog({
  className = "",
  event,
}: ToolCallEventLogProps) {
  const state = getToolCallEventDisplayState(event);
  const actionName = getToolCallName(event);
  const args = event.args ?? event.input;
  const result = event.result ?? event.output ?? event.error;

  return (
    <div className={`py-1 ${className}`} data-testid="tool-call-event-log">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`shrink-0 ${
                state === "failure"
                  ? "text-danger"
                  : state === "success"
                    ? "text-success"
                    : "text-primary"
              }`}
            >
              <StateIcon state={state} />
            </span>
            <div className="truncate text-sm font-semibold text-txt">
              {actionName}
            </div>
          </div>
          <div className="mt-1 text-xs-tight text-muted">
            {event.stage ? String(event.stage).replace(/_/g, " ") : "tool"}
            {event.durationMs || event.duration ? (
              <> - {event.durationMs ?? event.duration}ms</>
            ) : null}
          </div>
        </div>
        <StatePill state={state} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <PreviewRow label="Args" value={truncate(previewValue(args))} />
        <PreviewRow label="Result" value={truncate(previewValue(result))} />
      </div>

      <details className="group mt-3">
        <Button asChild variant="mutedLink" size="content">
          <summary className="flex cursor-pointer select-none items-center gap-1 text-xs-tight font-semibold">
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
            JSON details
          </summary>
        </Button>
        <CodeBlock
          value={formatJson(event)}
          wrap
          className="mt-2 max-h-[24rem] break-words"
        />
      </details>
    </div>
  );
}
