/** A local developer shell around the existing App, under its one AppProvider. */
import {
  type FormEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import type {
  NativeToolCallEvent,
  TrajectoryDetailResult,
  TrajectoryLlmCall,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import { pathForTab } from "../../navigation";
import "../../styles/developer-workspace.css";
import { useAppSelectorShallow } from "../../state/app-store";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { useChatTurnStatus } from "../../state/ChatTurnStatusContext.hooks";
import { useConversationMessages } from "../../state/ConversationMessagesContext.hooks";
import {
  getDeveloperTabState,
  selectDeveloperAppTab,
  sendToDeveloperAppTab,
  stopDeveloperAppTurn,
  subscribeDeveloperTabs,
} from "../../state/developer-tab-bridge";
import { deriveAgentReady } from "../../state/types";
import { AddAccountDialog } from "../accounts/AddAccountDialog";
import { MessageContent } from "../chat/MessageContent";
import { ThinkingBlock } from "../chat/ThinkingBlock";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { ModelConfigurationPanel } from "../settings/ModelConfigurationPanel";
import { ToolCallEventLog } from "../tool-events/ToolCallEventLog";
import { Button } from "../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { NativeSelect } from "../ui/native-select";
import { SemanticForm } from "../ui/semantic-form";
import { Separator } from "../ui/separator";
import { Table, TableRow } from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import {
  DeveloperTrajectories,
  isReplyRecoveryRun,
  useMessageTrajectories,
} from "./DeveloperTrajectories";
import {
  trajectoryRevision,
  useDeveloperTrajectories,
} from "./useDeveloperTrajectories";

const isMeasurement = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: number | null | undefined) =>
  isMeasurement(value) ? value.toLocaleString() : "—";
const duration = (value: number | null | undefined) =>
  isMeasurement(value) ? `${(value / 1000).toFixed(2)}s` : "—";

/** Unknown measurements stay unknown, including calls not yet loaded. */
function recordedTotal(
  values: (number | null | undefined)[],
  expected: number,
  format: (value: number) => string,
): string {
  const measured = values.filter(isMeasurement);
  if (!measured.length && expected > 0) return "Unknown";
  const total = format(measured.reduce((sum, value) => sum + value, 0));
  return measured.length < expected ? `${total}+ (partial)` : total;
}

/** Source identifies ownership; an evaluation stage does not identify delivery timing. */
export function callLane(source: string, replyRecovery = false): string {
  if (replyRecovery) return "Reply recovery";
  if (source === "background_memory") return "Background memory";
  return source === "client_chat" ? "Chat run" : source;
}

function recordedStage(
  call: TrajectoryLlmCall,
  detail: TrajectoryDetailResult,
): string {
  const containing = detail.semanticStages?.filter(
    (stage) =>
      call.timestamp >= stage.startedAt && call.timestamp <= stage.endedAt,
  );
  containing?.sort(
    (a, b) => a.endedAt - a.startedAt - (b.endedAt - b.startedAt),
  );
  return containing?.[0]?.kind || call.purpose || call.stepType || "Model";
}

/** Pure recorded-data view, shared by the workspace and its visual fixtures. */
export function DeveloperTrace({
  record,
  detail,
}: {
  record: TrajectoryRecord;
  detail: TrajectoryDetailResult;
}) {
  const calls = detail.llmCalls;
  const expectedCalls = Math.max(record.llmCallCount, calls.length);
  const input = recordedTotal(
    calls.map((call) => call.promptTokens),
    expectedCalls,
    count,
  );
  const modelTime = recordedTotal(
    calls.map((call) => call.latencyMs),
    expectedCalls,
    duration,
  );
  const cachedInput = recordedTotal(
    calls.map((call) => call.cacheReadInputTokens),
    expectedCalls,
    count,
  );
  return (
    <div className="space-y-4">
      <Separator />
      <div className="grid grid-cols-3 gap-3 py-3">
        <div>
          <div className="text-xs text-muted">Model attempts</div>
          <div className="text-lg tabular-nums">{detail.llmCalls.length}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Run input</div>
          <div className="text-lg tabular-nums">
            {calls.some((call) => call.tokenUsageEstimated) ? "≈ " : ""}
            {input}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">
            {record.status === "active"
              ? "Server run so far"
              : "Server run time"}
          </div>
          <div className="text-lg tabular-nums">
            {duration(record.durationMs)}
          </div>
        </div>
      </div>
      <Separator />
      <dl className="space-y-3 text-sm">
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt>Combined model time</dt>
          <dd className="tabular-nums">{modelTime}</dd>
          <dd className="mt-1 w-full text-xs leading-relaxed text-muted">
            Sum of recorded call durations. Server run time also includes
            context, tools and orchestration. Concurrent calls can overlap, so
            this sum cannot be subtracted to measure other work. Server run time
            excludes waiting before the run starts and final delivery or
            rendering afterward.
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Cached input (included)</dt>
          <dd className="tabular-nums">{cachedInput}</dd>
        </div>
      </dl>
      <p className="text-xs leading-relaxed text-muted">
        Model attempts include local rejections before a provider request. HTTP
        request counts are not recorded here. Tokens include evaluation and
        cached input; missing usage is unknown and ≈ marks estimates. Run time
        is not time to first token or reply delivery.
      </p>
      <div className="overflow-x-auto">
        <Table density="compact" className="caption-top text-left">
          <caption className="pb-2 text-left font-medium">
            Model attempts · {record.status}
          </caption>
          <thead className="text-muted">
            <tr>
              <th className="py-2 pr-3">Call / route</th>
              <th className="pr-3 text-right">Input</th>
              <th className="pr-3 text-right">Output</th>
              <th className="text-right">Model time</th>
            </tr>
          </thead>
          <tbody>
            {detail.llmCalls.map((call, index) => (
              <TableRow key={call.id || index} className="align-top">
                <td className="py-3 pr-3">
                  <div className="font-medium">
                    {index + 1}. {recordedStage(call, detail)}
                  </div>
                  <div className="mt-1 break-all text-muted">
                    {call.provider || "Provider not recorded"} / {call.model}
                  </div>
                  <div className="mt-1 text-muted">
                    {callLane(record.source, isReplyRecoveryRun(record))}
                  </div>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">
                  {count(call.promptTokens)}
                  {call.tokenUsageEstimated ? " ≈" : ""}
                  <div className="mt-1 whitespace-nowrap text-muted">
                    {count(call.cacheReadInputTokens)} cached
                  </div>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">
                  {count(call.completionTokens)}
                  {call.tokenUsageEstimated ? " ≈" : ""}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {duration(call.latencyMs)}
                </td>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </div>
      {detail.semanticStages?.length ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="touch">
              Recorded stages ({detail.semanticStages.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="py-2 text-xs text-muted">
              Inclusive spans: stages contain model calls and may overlap. Do
              not add them to model time or to each other.
            </p>
            <ol className="space-y-2 py-2 text-xs">
              {detail.semanticStages.map((stage) => (
                <li key={stage.stageId} className="flex justify-between gap-3">
                  <span>
                    {stage.kind}
                    {stage.iteration == null
                      ? ""
                      : ` · iteration ${stage.iteration}`}
                  </span>
                  <span className="tabular-nums text-muted">
                    {duration(stage.latencyMs)}
                  </span>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <div className="break-all text-xs text-muted">
        Run: {record.id}
        <br />
        Trace: {String(record.metadata?.traceId ?? "Not recorded")}
        <br />
        Message: {String(record.metadata?.messageId ?? "Not recorded")}
        <br />
        Room: {record.roomId ?? "Not recorded"}
      </div>
    </div>
  );
}

function WireEvidence({ record }: { record: TrajectoryRecord }) {
  const evidenceId = useId();
  const [open, setOpen] = useState(false);
  const [wire, setWire] = useState<TrajectoryDetailResult | null>(null);
  const [error, setError] = useState(false);
  const [part, setPart] = useState("0");
  const revision = trajectoryRevision(record);
  useEffect(() => {
    if (!open || !revision) return;
    const controller = new AbortController();
    setError(false);
    setWire(null);
    void client
      .getTrajectoryDetail(record.id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setWire(result);
      })
      .catch(() => {
        // error-policy:J4 An unavailable evidence read is shown inline.
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [open, record.id, revision]);
  const evidence = useMemo(() => {
    if (!wire) return "";
    const stage = wire.semanticStages?.[Number(part)];
    return JSON.stringify(part === "all" || !stage ? wire : stage, null, 2);
  }, [wire, part]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="pt-2">
      <Separator />
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="touch">
          Full prompts, tools, results &amp; context
        </Button>
      </CollapsibleTrigger>
      {open ? (
        <CollapsibleContent className="space-y-3 py-2">
          <p className="text-xs text-muted">
            Full recorded evidence, loaded on demand. This can be large and
            contain private conversation content. No prompt truncation is
            applied.
          </p>
          {wire ? (
            <label htmlFor={evidenceId} className="block text-xs text-muted">
              Evidence section
              <NativeSelect
                id={evidenceId}
                className="mt-2 block"
                value={part}
                onChange={(event) => setPart(event.target.value)}
              >
                {wire.semanticStages?.map((stage, index) => (
                  <option key={stage.stageId} value={String(index)}>
                    {index + 1}. {stage.kind}
                  </option>
                ))}
                <option value="all">Entire recorded run</option>
              </NativeSelect>
            </label>
          ) : null}
          {error ? (
            <p role="alert">
              Evidence could not be loaded. Close and reopen to retry.
            </p>
          ) : wire ? (
            <Textarea
              variant="codeEditor"
              className="h-[45dvh] max-h-[60dvh] text-xs leading-relaxed"
              aria-label="Full trajectory JSON"
              readOnly
              value={evidence}
            />
          ) : (
            <p role="status">Loading recorded evidence…</p>
          )}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function DeveloperSettings() {
  const [addKey, setAddKey] = useState(false);
  const [route, setRoute] = useState<string>("Loading configured route…");
  useEffect(() => {
    const controller = new AbortController();
    void client
      .getModelsConfig({ signal: controller.signal })
      .then((config) => {
        if (!controller.signal.aborted)
          setRoute(
            config.activeChat
              ? `${config.activeChat.provider} · ${config.activeChat.endpoint}`
              : "Active route not reported",
          );
      })
      .catch(() => {
        // error-policy:J4 Configuration availability is shown without guessing routing.
        if (!controller.signal.aborted)
          setRoute("Configured route unavailable");
      });
    return () => controller.abort();
  }, []);
  return (
    <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Cerebras connection</h2>
          <p className="mt-1 text-xs text-muted">Configured route: {route}</p>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          Uses this Eliza instance’s server-side credentials and routing. Any
          configured fallback still applies; inspect each recorded call for the
          provider actually used.
        </p>
        <Button variant="outline" onClick={() => setAddKey(true)}>
          Add Cerebras API key
        </Button>
        <ModelConfigurationPanel
          activeChatProvider="cerebras"
          showCodingModels={false}
        />
        <AddAccountDialog
          open={addKey}
          providerId="cerebras-api"
          onClose={() => setAddKey(false)}
          onCreated={() => setAddKey(false)}
        />
      </div>
    </RoleGate>
  );
}

/** Counts stay on the reply; model calls and full payloads load only when opened. */
export function DeveloperReplyDetails({
  record: summaryRecord,
  toolEvents = [],
  reasoning,
  backgrounds = [],
  relatedRuns = [],
  roomId,
  messageId,
  replyText,
}: {
  replyText?: string;
  record?: TrajectoryRecord;
  relatedRuns?: TrajectoryRecord[];
  roomId?: string;
  messageId?: string;
  toolEvents?: NativeToolCallEvent[];
  reasoning?: string;
  backgrounds?: TrajectoryRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TrajectoryDetailResult | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState("details");
  const history = useMessageTrajectories({
    records: [
      ...(summaryRecord ? [summaryRecord] : []),
      ...relatedRuns,
      ...backgrounds,
    ],
    roomId: roomId ?? summaryRecord?.roomId ?? undefined,
    messageId:
      messageId ??
      (typeof summaryRecord?.metadata?.messageId === "string"
        ? summaryRecord.metadata.messageId
        : undefined),
    enabled: open,
  });
  const record =
    summaryRecord ??
    [...history.runs]
      .reverse()
      .find((row) => row.source === "client_chat" && !isReplyRecoveryRun(row));
  const recoveries = history.runs.filter(isReplyRecoveryRun);
  const revision = record ? trajectoryRevision(record) : "";
  const recordId = record?.id;
  useEffect(() => {
    if (!open || tab !== "details" || !recordId || !revision) return;
    const controller = new AbortController();
    setDetail(null);
    setError(false);
    void client
      .getTrajectoryDetail(recordId, {
        signal: controller.signal,
        includePayloads: false,
      })
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch(() => {
        // error-policy:J4 A failed optional detail read never interrupts chat.
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [open, tab, recordId, revision]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="developer-reply-summary">
        {record || open ? (
          <span
            className="developer-token-count"
            title="Model attempts include local rejections, not just provider requests. Input includes cached tokens. Server run time excludes waiting before the run starts and delivery or rendering afterward. Inspect for timing details."
          >
            {recoveries.length ? "Original run: " : ""}
            {record &&
            (record.totalPromptTokens > 0 || record.totalCompletionTokens > 0)
              ? `${count(record.totalPromptTokens)} tokens in · ${count(record.totalCompletionTokens)} out`
              : !record
                ? !messageId
                  ? "No linked run"
                  : history.loading
                    ? "Loading token counts…"
                    : history.error
                      ? "Token counts couldn’t load"
                      : history.runs.length
                        ? "No foreground counts"
                        : "No recorded run"
                : record.status === "active"
                  ? "Usage pending"
                  : record.llmCallCount === 0
                    ? "No recorded model attempts"
                    : "Usage details"}
            {record && record.llmCallCount > 0
              ? ` · ${count(record.llmCallCount)} model ${record.llmCallCount === 1 ? "attempt" : "attempts"}`
              : ""}
            {!isMeasurement(record?.durationMs)
              ? ""
              : ` · ${duration(record?.durationMs)} ${record?.status === "active" ? "server run so far" : "server run"}`}
            {record?.status === "active" ? " · Working…" : ""}
          </span>
        ) : null}
        {recoveries.map((recovery, index) => (
          <span key={recovery.id} className="developer-token-count">
            Reply recovery {index + 1}: {count(recovery.llmCallCount)} model{" "}
            {recovery.llmCallCount === 1 ? "attempt" : "attempts"} ·{" "}
            {recovery.totalPromptTokens > 0 ||
            recovery.totalCompletionTokens > 0
              ? `${count(recovery.totalPromptTokens)} tokens in · ${count(recovery.totalCompletionTokens)} out`
              : recovery.status === "active"
                ? "Usage pending"
                : "Token usage unavailable"}
            {isMeasurement(recovery.durationMs)
              ? ` · ${duration(recovery.durationMs)} ${recovery.status === "active" ? "server run so far" : "server run"}`
              : ""}
            {recovery.status === "error" ? " · Failed" : ""}
          </span>
        ))}
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="touch"
            className="developer-inspect-trigger"
          >
            Inspect
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="developer-reply-inspector">
        <header className="developer-inspection-header">
          <DialogTitle>Inspect reply</DialogTitle>
          <DialogDescription className="developer-inspection-preview">
            {replyText ||
              "Recorded usage, model inputs, outputs and context for this reply."}
          </DialogDescription>
        </header>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="developer-expanded-reply"
        >
          <TabsList aria-label="Reply inspection" className="h-auto">
            <TabsTrigger value="details" className="min-h-11">
              Details
            </TabsTrigger>
            <TabsTrigger value="trajectories" className="min-h-11">
              Trajectories
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="details"
            className="developer-details-scroll space-y-3"
          >
            <p className="text-xs text-muted">
              Recorded tokens across this run’s model calls, including
              evaluation. Background memory runs separately.
            </p>
            {error ? (
              <p role="alert">
                Details unavailable. Close and reopen to retry.
              </p>
            ) : detail && record && detail.trajectory.id === record.id ? (
              <DeveloperTrace record={record} detail={detail} />
            ) : (
              <p role="status">
                {record
                  ? "Loading details…"
                  : history.loading
                    ? "Loading recorded counts…"
                    : history.error
                      ? "Recorded counts could not load. Open Trajectories to retry."
                      : history.runs.length
                        ? "No foreground run. Open Trajectories to inspect the other recorded runs."
                        : "No recorded trajectory matches this message."}
              </p>
            )}
            {toolEvents.length ? (
              <details>
                <summary>Tool activity ({toolEvents.length})</summary>
                {toolEvents.map((event) => (
                  <ToolCallEventLog
                    key={event.callId || event.id}
                    event={event}
                  />
                ))}
              </details>
            ) : null}
            {reasoning ? <ThinkingBlock reasoning={reasoning} /> : null}
            {record ? <WireEvidence record={record} /> : null}
            {backgrounds.length ? (
              <details>
                <summary>
                  Background memory ({backgrounds.length}{" "}
                  {backgrounds.length === 1 ? "run" : "runs"})
                </summary>
                {backgrounds.map((background) => (
                  <DeveloperReplyDetails
                    key={background.id}
                    record={background}
                  />
                ))}
              </details>
            ) : null}
          </TabsContent>
          <TabsContent
            value="trajectories"
            className="developer-trajectories-panel"
          >
            <DeveloperTrajectories {...history} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const DeveloperMessage = memo(
  function DeveloperMessage({
    message,
    record,
    backgrounds,
    relatedRuns,
    roomId,
    messageId,
  }: {
    message: ConversationMessage;
    record?: TrajectoryRecord;
    backgrounds: TrajectoryRecord[];
    relatedRuns: TrajectoryRecord[];
    roomId?: string;
    messageId?: string;
  }) {
    return (
      <article
        className={`developer-message developer-message-${message.role}`}
        aria-label={message.role === "user" ? "You" : "Eliza"}
      >
        <div
          className="developer-message-body"
          data-testid={
            message.role === "assistant" ? "developer-reply" : undefined
          }
        >
          <MessageContent
            message={{
              ...message,
              reasoning: undefined,
              toolEvents: undefined,
            }}
          />
        </div>
        {message.role === "assistant" ? (
          <DeveloperReplyDetails
            replyText={message.text}
            record={record}
            toolEvents={message.toolEvents}
            reasoning={message.reasoning}
            backgrounds={backgrounds}
            relatedRuns={relatedRuns}
            roomId={roomId}
            messageId={messageId}
          />
        ) : message.toolEvents?.length ? (
          <details>
            <summary className="text-xs text-muted">Tool activity</summary>
            {message.toolEvents.map((event) => (
              <ToolCallEventLog key={event.callId || event.id} event={event} />
            ))}
          </details>
        ) : null}
      </article>
    );
  },
  (before, after) =>
    before.message === after.message &&
    before.roomId === after.roomId &&
    before.messageId === after.messageId &&
    before.relatedRuns.map(trajectoryRevision).join("|") ===
      after.relatedRuns.map(trajectoryRevision).join("|") &&
    (before.record ? trajectoryRevision(before.record) : "") ===
      (after.record ? trajectoryRevision(after.record) : "") &&
    before.backgrounds.map(trajectoryRevision).join("|") ===
      after.backgrounds.map(trajectoryRevision).join("|"),
);

/** Local elapsed time and server SSE activity render without repainting the transcript. */
function LiveActivity({
  startedAt,
  record,
  toolEvents,
}: {
  startedAt: number;
  record?: TrajectoryRecord;
  toolEvents: NativeToolCallEvent[];
}) {
  const { serverTurnStatus } = useChatTurnStatus();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const phase =
    serverTurnStatus?.label ||
    {
      thinking: "Thinking",
      streaming: "Writing reply",
      running_action: "Using a tool",
      running_tool: "Using a tool",
      evaluating: "Checking results",
      waking: "Connecting",
      speaking: "Speaking",
    }[serverTurnStatus?.kind || "thinking"];
  const operation = serverTurnStatus?.actionName || serverTurnStatus?.toolName;
  return (
    <div className="developer-live-activity">
      <p role="status" className="text-sm">
        <span className="developer-live-dot" />
        {phase}
        {operation ? ` · ${operation}` : ""}{" "}
        <span className="text-muted">
          · {duration(Math.max(0, now - startedAt))}
        </span>
      </p>
      <details>
        <summary className="text-xs text-muted">
          Live details{toolEvents.length ? ` · ${toolEvents.length} tools` : ""}
        </summary>
        <p className="text-xs text-muted">
          Tool activity arrives live. Token counts update after model calls
          finish; an unfinished call has no final usage yet.
        </p>
        {toolEvents.map((event) => (
          <ToolCallEventLog key={event.callId || event.id} event={event} />
        ))}
        {record ? (
          <div className="mt-3">
            <p className="text-xs text-muted">
              Latest run in this chat · {record.llmCallCount} recorded model
              attempts
            </p>
            <DeveloperReplyDetails record={record} />
          </div>
        ) : (
          <p className="text-xs text-muted">
            Waiting for the run to be recorded…
          </p>
        )}
      </details>
    </div>
  );
}

function DeveloperPanel({ section }: { section: "chat" | "settings" }) {
  const runSelectId = useId();
  const {
    chatSending,
    chatInput: draft,
    setChatInput: setDraft,
  } = useChatComposer();
  const { conversationMessages } = useConversationMessages();
  const state = useAppSelectorShallow((s) => ({
    activeConversationId: s.activeConversationId,
    conversations: s.conversations,
    status: s.agentStatus,
  }));
  const conversation = state.conversations.find(
    (item) => item.id === state.activeConversationId,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const telemetry = useDeveloperTrajectories(
    conversation?.roomId,
    chatSending,
    advancedOpen && section === "settings",
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = chatSending || sending;
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrollConversation = useRef(state.activeConversationId);
  useEffect(() => {
    if (scrollConversation.current !== state.activeConversationId) {
      following.current = true;
      scrollConversation.current = state.activeConversationId;
    }
    const node = scrollRef.current;
    if (
      node &&
      section === "chat" &&
      conversationMessages.length &&
      following.current
    ) {
      node.scrollTop = node.scrollHeight;
    }
  }, [state.activeConversationId, conversationMessages, section]);
  const messages = useMemo(() => {
    return conversationMessages
      .filter((message) => message.transcriptVisibility !== "internal")
      .map((message) => {
        // Only recorded reply ownership can attach request costs. Adjacent
        // assistant rows may instead be unsolicited background notifications.
        const messageId =
          message.role === "assistant" ? message.replyToMessageId : undefined;
        const record =
          message.role === "assistant" && messageId
            ? telemetry.rows.find(
                (row) =>
                  row.source === "client_chat" &&
                  !isReplyRecoveryRun(row) &&
                  row.roomId === conversation?.roomId &&
                  row.metadata?.messageId === messageId,
              )
            : undefined;
        const backgrounds =
          message.role === "assistant" && messageId
            ? telemetry.rows.filter(
                (row) =>
                  row.source === "background_memory" &&
                  row.roomId === conversation?.roomId &&
                  row.metadata?.messageId === messageId,
              )
            : [];
        const relatedRuns =
          message.role === "assistant" && messageId
            ? telemetry.rows.filter(
                (row) =>
                  row.id !== record?.id &&
                  row.source !== "background_memory" &&
                  row.roomId === conversation?.roomId &&
                  row.metadata?.messageId === messageId,
              )
            : [];
        return {
          message,
          record,
          backgrounds,
          relatedRuns,
          messageId,
        };
      });
  }, [conversationMessages, telemetry.rows, conversation?.roomId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy || !deriveAgentReady(state.status)) return;
    const prompt = draft;
    setSending(true);
    setSendError(null);
    setDraft("");
    following.current = true;
    telemetry.setOffset(0);
    telemetry.select(null);
    try {
      await sendToDeveloperAppTab(prompt, state.activeConversationId);
    } catch (error) {
      // error-policy:J4 Relay failures stay visible; never replay a possibly effectful turn.
      if (!draftRef.current) setDraft(prompt);
      setSendError(
        error instanceof Error
          ? error.message
          : "Couldn’t send to the app tab. Check it before retrying.",
      );
    } finally {
      setSending(false);
    }
  };
  const latestUser = useMemo(() => {
    for (let index = conversationMessages.length - 1; index >= 0; index--) {
      if (conversationMessages[index].role === "user")
        return conversationMessages[index];
    }
    return undefined;
  }, [conversationMessages]);
  const latestMessage = conversationMessages[conversationMessages.length - 1];
  const liveTools =
    latestMessage?.role === "assistant" ? (latestMessage.toolEvents ?? []) : [];
  // A room-level live preview, not a guessed binding to an optimistic reply ID.
  const liveRecord = latestUser
    ? telemetry.rows.find(
        (row) =>
          row.source === "client_chat" &&
          row.roomId === conversation?.roomId &&
          row.startTime >= latestUser.timestamp,
      )
    : undefined;
  const inspection = telemetry.inspection;
  return (
    <section aria-label="Eliza chat" className="developer-console">
      <div
        className="developer-chat-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 96;
        }}
      >
        <div className="developer-chat-content">
          {section === "settings" ? (
            <>
              <h2 className="text-lg font-semibold">Settings</h2>
              <DeveloperSettings />
              <details
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary className="cursor-pointer text-sm">
                  Advanced diagnostics
                </summary>
                {advancedOpen ? (
                  <div className="space-y-4 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-medium">Recorded runs</h2>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => telemetry.setPaused(!telemetry.paused)}
                      >
                        {telemetry.paused
                          ? "Resume telemetry"
                          : "Pause telemetry"}
                      </Button>
                    </div>
                    <label
                      htmlFor={runSelectId}
                      className="block text-xs text-muted"
                    >
                      Inspect a run
                      <NativeSelect
                        id={runSelectId}
                        aria-label="Inspect a run"
                        className="mt-2 block min-w-0"
                        value={telemetry.selectedId ?? ""}
                        onChange={(event) =>
                          telemetry.select(event.target.value || null)
                        }
                      >
                        <option value="">
                          Follow latest turn in this conversation
                        </option>
                        {telemetry.rows.map((row) => (
                          <option key={row.id} value={row.id}>
                            {new Date(row.startTime).toLocaleTimeString()} ·{" "}
                            {row.source} · {row.llmCallCount} attempts ·{" "}
                            {row.roomId === conversation?.roomId
                              ? "this room"
                              : "other room"}{" "}
                            · {row.id}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span>
                        Agent history · {telemetry.offset + 1}–
                        {telemetry.offset + telemetry.rows.length} of{" "}
                        {telemetry.total}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={telemetry.offset === 0}
                          onClick={() => {
                            telemetry.select(null);
                            telemetry.setOffset(
                              Math.max(0, telemetry.offset - 50),
                            );
                          }}
                        >
                          Newer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={telemetry.offset + 50 >= telemetry.total}
                          onClick={() => {
                            telemetry.select(null);
                            telemetry.setOffset(telemetry.offset + 50);
                          }}
                        >
                          Older
                        </Button>
                      </div>
                    </div>
                    {telemetry.error ? (
                      <p role="alert" className="text-sm text-warn">
                        {telemetry.error}
                      </p>
                    ) : null}
                    {inspection ? (
                      <>
                        <DeveloperTrace
                          record={inspection.record}
                          detail={inspection.detail}
                        />
                        <WireEvidence
                          key={inspection.record.id}
                          record={inspection.record}
                        />
                        <p className="text-xs leading-relaxed text-muted">
                          Background memory runs appear separately above. Match
                          the message ID to correlate them; they can finish
                          after the reply.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted">
                        No matching run on this page yet. Recording appears as
                        stages finish.
                      </p>
                    )}
                  </div>
                ) : null}
              </details>
            </>
          ) : (
            <>
              {messages.length ? (
                messages.map(
                  ({
                    message,
                    record,
                    backgrounds,
                    relatedRuns,
                    messageId,
                  }) => (
                    <DeveloperMessage
                      key={message.clientRenderId || message.id}
                      message={message}
                      record={record}
                      backgrounds={backgrounds}
                      relatedRuns={relatedRuns}
                      roomId={conversation?.roomId}
                      messageId={messageId}
                    />
                  ),
                )
              ) : (
                <p className="developer-chat-empty">
                  What would you like to do?
                </p>
              )}
              {busy ? (
                <LiveActivity
                  startedAt={latestUser?.timestamp || Date.now()}
                  record={liveRecord}
                  toolEvents={liveTools}
                />
              ) : null}
              {!deriveAgentReady(state.status) ? (
                <p role="status" className="text-sm text-muted">
                  Agent unavailable. Reconnecting…
                </p>
              ) : null}
              {telemetry.error ? (
                <p className="text-xs text-muted">
                  Token counts are temporarily unavailable.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {section === "chat" ? (
        <SemanticForm
          className="developer-chat-composer"
          onSubmit={(event) => void submit(event)}
        >
          <label htmlFor="developer-prompt" className="sr-only">
            Message Eliza
          </label>
          <Textarea
            id="developer-prompt"
            placeholder="Message Eliza…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="developer-composer-footer">
            <span className="text-xs text-muted">
              Enter to send · Shift+Enter for a new line
            </span>
            {busy ? (
              <Button
                type="button"
                variant="outline"
                onClick={stopDeveloperAppTurn}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!draft.trim() || !deriveAgentReady(state.status)}
              >
                Send
              </Button>
            )}
          </div>
          {sendError ? (
            <p role="alert" className="text-xs text-warn">
              {sendError}
            </p>
          ) : null}
        </SemanticForm>
      ) : null}
    </section>
  );
}

export function DeveloperWorkspace({ children }: { children: ReactNode }) {
  const authority = useActiveAgentAuthority();
  const { activeTab } = useAppSelectorShallow((state) => ({
    activeTab: state.tab,
  }));
  const appTabs = useSyncExternalStore(
    subscribeDeveloperTabs,
    getDeveloperTabState,
    getDeveloperTabState,
  );
  const selectedApp =
    appTabs.peers.find((peer) => peer.id === appTabs.selectedId) ??
    (appTabs.peers.length === 1 ? appTabs.peers[0] : undefined);
  const [section, setSection] = useState<"chat" | "settings">("chat");
  return (
    <div className="eliza-developer-workspace">
      <header className="developer-chat-header">
        <h1>Eliza</h1>
        <nav aria-label="Chat options">
          {appTabs.peers.length > 1 ? (
            <NativeSelect
              aria-label="App tab"
              value={selectedApp?.id ?? ""}
              onChange={(event) => selectDeveloperAppTab(event.target.value)}
            >
              <option value="">Select app tab</option>
              {appTabs.peers.map((peer) => (
                <option key={peer.id} value={peer.id}>
                  {peer.path} · {peer.id.slice(-6)}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <span className="text-xs text-muted">
              {selectedApp
                ? `App tab: ${selectedApp.path}`
                : "Waiting for app tab"}
            </span>
          )}
          {!selectedApp && (
            <a href="/chat" target="_blank" rel="noopener noreferrer">
              Open app
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={section === "settings"}
            onClick={() => {
              setSection(section === "settings" ? "chat" : "settings");
            }}
          >
            {section === "settings" ? "Back to chat" : "Settings"}
          </Button>
          <a href={selectedApp?.path ?? pathForTab(activeTab)}>Exit</a>
        </nav>
      </header>
      <div className="developer-workspace-body">
        <div data-testid="developer-app-pane" className="developer-app-pane">
          {children}
        </div>
        <div className="developer-inspector-pane">
          <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
            <DeveloperPanel key={authority} section={section} />
          </RoleGate>
        </div>
      </div>
    </div>
  );
}
