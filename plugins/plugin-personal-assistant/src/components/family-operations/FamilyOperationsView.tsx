/**
 * Responsive owner workspace for agreements, linked calendars, school-source
 * workflow review, and monthly family packets. Every mutation delegates to an
 * injected adapter and renders failures explicitly; no optimistic success is
 * fabricated for unavailable backend contracts.
 */

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Card as SurfaceCard,
} from "@elizaos/ui";
import {
  CalendarSync,
  FileCheck2,
  GraduationCap,
  RefreshCw,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FamilyPacketSection } from "../../lifeops/family-coordination/index.js";
import { nextFamilyPacketPeriod } from "../../lifeops/family-workflows/period.js";
import type { FamilyMonthlyScheduleView } from "../../lifeops/family-workflows/runtime.js";
import { AgreementGuestAccessPanel } from "./AgreementGuestAccessPanel.js";
import { AgreementObligationReview } from "./AgreementObligationReview.js";
import { AgreementProposalEditor } from "./AgreementProposalEditor.js";
import { AgreementReviewPanel } from "./AgreementReviewPanel.js";
import { defaultFamilyOperationsAdapter } from "./adapter.js";
import type { FamilyDeletionAdapter } from "./deletion-adapter.js";
import { FamilyDeletionPanel } from "./FamilyDeletionPanel.js";
import { FamilyIntakePanel } from "./FamilyIntakePanel.js";
import {
  defaultFamilyIntakeAdapter,
  type FamilyIntakeAdapter,
} from "./intake-adapter.js";
import { MonthlyScheduleEditor } from "./MonthlyScheduleEditor.js";
import { PacketDraftEditor } from "./PacketDraftEditor.js";
import { RecipientSetup } from "./RecipientSetup.js";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  Loadable,
  SchoolWorkflowView,
} from "./types.js";

const packetSectionLabels: Record<FamilyPacketSection, string> = {
  custody_calendar: "Parenting schedule",
  school: "School",
  approved_obligations: "Agreement obligations",
  travel_consent_health: "Travel, consent and health",
  unanswered: "Unanswered requests",
};

const packetStatusLabels = {
  complete: "Source material available for every section",
  missing: "Some sections need source material",
  contradictory: "Conflicting sources need review",
};

type Tab = "agreements" | "calendar" | "school" | "packets";

const tabs: Array<{ id: Tab; label: string; icon: typeof FileCheck2 }> = [
  { id: "agreements", label: "Agreement", icon: FileCheck2 },
  { id: "calendar", label: "Calendar sync", icon: CalendarSync },
  { id: "school", label: "School calendar", icon: GraduationCap },
  { id: "packets", label: "Monthly packet", icon: UsersRound },
];

function date(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function Card({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <SurfaceCard
      asChild
      border="standard"
      padding="comfortable"
      radius="xlarge"
      surface="card"
      className="md:p-6"
    >
      <section>
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        {detail ? (
          <p
            style={{
              margin: "6px 0 18px",
              color: "var(--muted)",
              lineHeight: 1.5,
            }}
          >
            {detail}
          </p>
        ) : null}
        {children}
      </section>
    </SurfaceCard>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Unavailable</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: "var(--muted)", margin: 0 }}>{children}</p>;
}

function AgreementUploadCard({
  adapter,
  refresh,
}: {
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [agreementKey, setAgreementKey] = useState("parenting-plan");
  const [title, setTitle] = useState("Parenting agreement");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUpload =
    file?.type === "application/pdf" &&
    file.size > 0 &&
    title.trim().length > 0 &&
    agreementKey.trim().length > 0;

  const upload = async () => {
    if (!file || !canUpload) return;
    setError(null);
    setNotice(null);
    try {
      await adapter.uploadAgreement({
        agreementKey: agreementKey.trim(),
        title: title.trim(),
        file,
        onProgress: ({ uploadedBytes, totalBytes, phase }) => {
          setProgress(
            phase === "processing"
              ? "Upload verified. Reading every PDF page…"
              : `Uploading ${Math.round((uploadedBytes / totalBytes) * 100)}%`,
          );
        },
      });
      setNotice("Immutable agreement version uploaded.");
      setProgress(null);
      setFile(null);
      await refresh();
    } catch (cause) {
      // error-policy:J1 Show the failed upload without retaining active progress.
      setProgress(null);
      setError(cause instanceof Error ? cause.message : "Upload failed");
    }
  };

  return (
    <Card
      title="Upload signed agreement"
      detail="Upload your signed PDF, then review the extracted obligations and their source pages."
    >
      <Button variant="outline" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Close PDF form" : "Choose a signed PDF"}
      </Button>
      {expanded ? (
        <div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 12,
              marginTop: 14,
            }}
          >
            <label
              htmlFor="agreement-title"
              style={{ display: "grid", gap: 6 }}
            >
              <span>Agreement name</span>
              <Input
                id="agreement-title"
                value={title}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setTitle(event.target.value)
                }
              />
            </label>
            <label htmlFor="agreement-key" style={{ display: "grid", gap: 6 }}>
              <span>Agreement key</span>
              <Input
                id="agreement-key"
                value={agreementKey}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setAgreementKey(event.target.value)
                }
              />
            </label>
            <label htmlFor="agreement-pdf" style={{ display: "grid", gap: 6 }}>
              <span>Signed PDF</span>
              <Input
                id="agreement-pdf"
                type="file"
                aria-label="Signed PDF"
                accept="application/pdf,.pdf"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  setNotice(null);
                  setError(
                    selected && selected.size < 1
                      ? "Agreement PDF must not be empty."
                      : null,
                  );
                }}
              />
              <small style={{ color: "var(--muted)" }}>
                Large PDFs are split into verified chunks and resumed after
                interruption.
              </small>
            </label>
          </div>
          <div style={{ marginTop: 14 }}>
            <Button disabled={!canUpload} onClick={() => void upload()}>
              Upload immutable PDF
            </Button>
          </div>
          {notice ? <p role="status">{notice}</p> : null}
          {progress ? <p role="status">{progress}</p> : null}
          {error ? <Unavailable message={error} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function AgreementPanel({
  state,
  adapter,
  refresh,
  refreshReview,
}: {
  state: FamilyOperationsSnapshot["agreements"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
  refreshReview: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [downloading, setDownloading] = useState<"original" | "export" | null>(
    null,
  );
  const [targetType, setTargetType] = useState<"agent" | "chat">("agent");
  const [targetId, setTargetId] = useState("");
  const pinLoadRequest = useRef(0);
  const [targets, setTargets] = useState<Loadable<
    Awaited<ReturnType<FamilyOperationsAdapter["listPinTargets"]>>
  > | null>(null);
  const [pins, setPins] = useState<
    Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>>
  >([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agreements = state.status === "ready" ? state.data : [];
  const selected =
    agreements.find((item) => item.artifact.id === selectedId) ?? agreements[0];
  const selectedArtifactId = selected?.artifact.id;

  const loadPinTargets = useCallback(async () => {
    if (!selectedArtifactId) return;
    const requestId = ++pinLoadRequest.current;
    setSelectedId(selectedArtifactId);
    setTargets(null);
    setPins([]);
    try {
      const [loadedPins, loadedTargets] = await Promise.all([
        adapter.listPins(selectedArtifactId),
        adapter.listPinTargets(),
      ]);
      if (requestId !== pinLoadRequest.current) return;
      setPins(loadedPins);
      setTargets({ status: "ready", data: loadedTargets });
    } catch (cause) {
      // error-policy:J1 display loading failures without accepting a stale destination.
      if (requestId === pinLoadRequest.current)
        setTargets({
          status: "unavailable",
          message:
            cause instanceof Error
              ? cause.message
              : "Pin destinations could not load",
        });
    }
  }, [adapter, selectedArtifactId]);

  useEffect(() => {
    void loadPinTargets();
    return () => {
      pinLoadRequest.current += 1;
    };
  }, [loadPinTargets]);

  const pinTarget =
    targets?.status === "ready"
      ? targetType === "agent"
        ? targets.data.agent.id
        : targets.data.chats.find((chat) => chat.id === targetId)?.id
      : undefined;
  const pinLabel = (pin: (typeof pins)[number]): string => {
    if (targets?.status !== "ready") return "Unavailable destination";
    if (pin.targetType === "agent")
      return pin.targetId === targets.data.agent.id
        ? `This agent: ${targets.data.agent.name ?? "Unnamed agent"}`
        : "Unavailable agent";
    const chat = targets.data.chats.find((item) => item.id === pin.targetId);
    return chat
      ? `${chat.name ?? "Unnamed conversation"} · ${chat.source}`
      : "Unavailable conversation";
  };

  const act = async (operation: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(success);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed");
    }
  };

  const download = async (format: "original" | "export") => {
    if (!selected || downloading) return;
    setDownloading(format);
    setError(null);
    setNotice(null);
    try {
      const blob = await adapter.downloadAgreement(
        selected.artifact.id,
        format,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        format === "original"
          ? selected.artifact.originalFilename
          : `agreement-${selected.artifact.id}-v${selected.artifact.version}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      // Allow the browser to consume the object URL before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(
        format === "original"
          ? "Original PDF download started."
          : "Agreement export download started. The archive includes the original, provenance, and checksums.",
      );
    } catch (cause) {
      // error-policy:J1 Download failures remain visible in the owner workspace.
      setError(cause instanceof Error ? cause.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  };

  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  if (!selected)
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <AgreementUploadCard adapter={adapter} refresh={refresh} />
        <Empty>No parenting agreement has been uploaded yet.</Empty>
      </div>
    );
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <AgreementUploadCard adapter={adapter} refresh={refresh} />
      <Card
        title="Agreement versions"
        detail="Signed PDFs are immutable. Select a version to review its page-cited obligations."
      >
        <label
          htmlFor="agreement-version"
          style={{ display: "grid", gap: 7, maxWidth: 520 }}
        >
          <span>Version</span>
          <Select value={selected.artifact.id} onValueChange={setSelectedId}>
            <SelectTrigger
              id="agreement-version"
              aria-label="Agreement version"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agreements.map((view) => (
                <SelectItem key={view.artifact.id} value={view.artifact.id}>
                  {view.artifact.title} · v{view.artifact.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            margin: "16px 0 0",
          }}
        >
          <div>
            <dt style={{ color: "var(--muted)" }}>Pages</dt>
            <dd style={{ margin: "3px 0" }}>{selected.artifact.pageCount}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>Uploaded</dt>
            <dd style={{ margin: "3px 0" }}>
              {date(selected.artifact.createdAt)}
            </dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>SHA-256</dt>
            <dd style={{ margin: "3px 0", overflowWrap: "anywhere" }}>
              {selected.artifact.contentSha256}
            </dd>
          </div>
        </dl>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}
        >
          <Button
            className="min-h-11"
            variant="accentDarkHover"
            disabled={downloading !== null}
            onClick={() => void download("original")}
          >
            {downloading === "original"
              ? "Preparing PDF…"
              : "Download original PDF"}
          </Button>
          <Button
            className="min-h-11"
            variant="accentDarkHover"
            disabled={downloading !== null}
            onClick={() => void download("export")}
          >
            {downloading === "export"
              ? "Preparing export…"
              : "Export agreement"}
          </Button>
        </div>
      </Card>

      <Card
        title="Reviewed obligations"
        detail="Proposals do not become active until you approve them against the cited PDF pages."
      >
        <AgreementReviewPanel
          key={selected.artifact.id}
          artifactId={selected.artifact.id}
          adapter={adapter}
          onPrepared={refreshReview}
        />
        <AgreementProposalEditor
          key={selected.artifact.id}
          artifactId={selected.artifact.id}
          pageCount={selected.artifact.pageCount}
          adapter={adapter}
          onSaved={refreshReview}
        />
        {selected.obligations.length === 0 ? (
          <Empty>No reviewed obligations yet.</Empty>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {selected.obligations.map((obligation) => (
              <AgreementObligationReview
                key={obligation.id}
                obligation={obligation}
                adapter={adapter}
                onDecided={refreshReview}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Pins"
        detail="Pinning adds approved obligations to this agent or one chat. It never grants another person access."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
            gap: 8,
          }}
        >
          <Select
            value={targetType}
            onValueChange={(value) => setTargetType(value as "agent" | "chat")}
          >
            <SelectTrigger aria-label="Pin target type" className="min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">This agent</SelectItem>
              <SelectItem value="chat">Chat</SelectItem>
            </SelectContent>
          </Select>
          {targets === null ? (
            <p role="status">Loading destinations…</p>
          ) : targets.status === "unavailable" ? (
            <Unavailable message={targets.message} />
          ) : targetType === "agent" ? (
            <p>{targets.data.agent.name ?? "Unnamed agent"}</p>
          ) : targets.data.chats.length === 0 ? (
            <p>
              No conversations are available. Start a chat, then refresh
              destinations.
            </p>
          ) : (
            <Select value={pinTarget ?? ""} onValueChange={setTargetId}>
              <SelectTrigger aria-label="Pin conversation" className="min-h-11">
                <SelectValue placeholder="Choose a conversation" />
              </SelectTrigger>
              <SelectContent>
                {targets.data.chats.map((chat) => (
                  <SelectItem key={chat.id} value={chat.id}>
                    {chat.name ?? "Unnamed conversation"} · {chat.source}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            className="min-h-11"
            disabled={!pinTarget}
            onClick={() =>
              void act(async () => {
                if (!pinTarget)
                  throw new Error("Choose an available pin destination.");
                const pin = await adapter.pin({
                  artifactId: selected.artifact.id,
                  targetType,
                  targetId: pinTarget,
                });
                const storedPins = await adapter.listPins(selected.artifact.id);
                setPins(storedPins);
                if (
                  !storedPins.some(
                    (stored) =>
                      stored.id === pin.id &&
                      stored.targetType === targetType &&
                      stored.targetId === pinTarget &&
                      stored.unpinnedAt === null,
                  )
                )
                  throw new Error(
                    "The pin could not be confirmed. Refresh destinations before retrying.",
                  );
              }, "Pin saved.")
            }
          >
            Pin
          </Button>
        </div>
        <Button
          className="min-h-11 mt-3"
          variant="outline"
          onClick={() => void loadPinTargets()}
        >
          Refresh destinations
        </Button>
        <ul style={{ padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {pins.map((pin) => (
            <li
              key={pin.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>{pinLabel(pin)}</span>
              <Button
                className="min-h-11"
                variant="outline"
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await adapter.unpin(pin.id);
                    setPins(await adapter.listPins(selected.artifact.id));
                  }, "Pin removed.")
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Guest access"
        detail="Choose a verified guest and preview the limited access before enabling it."
      >
        <AgreementGuestAccessPanel
          key={selected.artifact.id}
          artifactId={selected.artifact.id}
          adapter={adapter}
        />
      </Card>
      {error ? <Unavailable message={error} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}

function CalendarPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["calendarLinks"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  if (state.data.length === 0)
    return (
      <Empty>
        No Eliza events are linked to Google yet. Create a link from an event in
        Calendar.
      </Empty>
    );
  const run = async (op: () => Promise<void>) => {
    try {
      setError(null);
      await op();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Calendar update failed",
      );
    }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {state.data.map((link) => (
        <Card
          key={link.id}
          title={
            link.event
              ? link.event.title || "Untitled event"
              : "Event details unavailable"
          }
          detail={`Google sync · updated ${date(link.updatedAt)}`}
        >
          <p>
            <strong>Status:</strong> {link.state}
          </p>
          <details>
            <summary>Connection details</summary>
            <p style={{ overflowWrap: "anywhere" }}>
              Event ID: {link.localEventId}
            </p>
            <p style={{ overflowWrap: "anywhere" }}>
              Google calendar: {link.providerCalendarId}
            </p>
          </details>
          {link.state === "conflicted" ? (
            <div>
              <p role="alert">
                Both calendars changed. Choose which version should win.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  className="min-h-11"
                  onClick={() =>
                    void run(() =>
                      adapter.resolveCalendarConflict(
                        link.id,
                        "keep_eliza",
                        link.updatedAt,
                      ),
                    )
                  }
                >
                  Keep Eliza
                </Button>
                <Button
                  className="min-h-11"
                  variant="outline"
                  onClick={() =>
                    void run(() =>
                      adapter.resolveCalendarConflict(
                        link.id,
                        "keep_google",
                        link.updatedAt,
                      ),
                    )
                  }
                >
                  Keep Google
                </Button>
              </div>
            </div>
          ) : null}
          <Button
            className="min-h-11"
            variant="outline"
            onClick={() =>
              void run(() =>
                adapter.disconnectCalendar(link.id, link.updatedAt),
              )
            }
          >
            Disconnect, keep events
          </Button>
        </Card>
      ))}
      {error ? <Unavailable message={error} /> : null}
    </div>
  );
}

const schoolStatusLabels: Record<SchoolWorkflowView["state"], string> = {
  never_run: "Not checked yet",
  running: "Checking",
  unchanged: "No changes",
  awaiting_approval: "Ready for review",
  applied: "Updated",
  failed: "Check failed",
};
const monthlyScheduleStatusLabels: Record<
  FamilyMonthlyScheduleView["status"],
  string
> = {
  scheduled: "Scheduled",
  fired: "Last run started",
  acknowledged: "Acknowledged",
  completed: "Completed",
  skipped: "Skipped",
  expired: "Expired",
  failed: "Failed",
  dismissed: "Stopped",
};

function SchoolPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["school"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [errorTarget, setErrorTarget] = useState<"school" | "schedule">(
    "school",
  );
  const [busy, setBusy] = useState(false);
  const [schoolLevel, setSchoolLevel] = useState<"all" | "elementary">(
    "elementary",
  );
  const [updateMode, setUpdateMode] = useState<"review" | "automatic">(
    "automatic",
  );
  useEffect(() => {
    if (state.status === "ready" && state.data.sourceUrl) {
      setSchoolLevel(state.data.schoolLevel);
      setUpdateMode(state.data.updateMode);
    }
  }, [state]);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  const workflow = state.data;
  const run = async (
    op: () => Promise<void>,
    target: "school" | "schedule" = "school",
  ) => {
    try {
      setBusy(true);
      setError(null);
      setErrorTarget(target);
      await op();
      await refresh();
    } catch (cause) {
      // error-policy:J4 Configuration and execution failures remain visible to the owner.
      setError(
        cause instanceof Error ? cause.message : "School workflow failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={workflow.label} detail={`Source: ${workflow.sourceUrl}`}>
      <fieldset
        disabled={busy}
        style={{ border: 0, padding: 0, display: "grid", gap: 12 }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="school-level">School level</label>
          <Select
            disabled={busy}
            value={schoolLevel}
            onValueChange={(value) =>
              setSchoolLevel(value === "elementary" ? "elementary" : "all")
            }
          >
            <SelectTrigger id="school-level" className="min-h-12">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="elementary">
                Elementary school and district dates
              </SelectItem>
              <SelectItem value="all">All school levels</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="school-update-mode">Calendar updates</label>
          <Select
            disabled={busy}
            value={updateMode}
            onValueChange={(value) =>
              setUpdateMode(value === "automatic" ? "automatic" : "review")
            }
          >
            <SelectTrigger id="school-update-mode" className="min-h-12">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="automatic">
                Apply validated school changes automatically
              </SelectItem>
              <SelectItem value="review">Review each change</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p>
          Saving creates a monthly school check and packet preparation task if
          one does not exist. The default is the first day of each month at 9:00
          AM America/New_York; an existing schedule and its status are
          preserved. It never sends email automatically. Unchanged files add no
          events. Unclear dates stop for review; changes apply only to events
          managed by this school source.
        </p>
        <Button
          className="min-h-12"
          onClick={() =>
            void run(() => adapter.configureSchool({ schoolLevel, updateMode }))
          }
        >
          Save school settings
        </Button>
      </fieldset>
      <section
        aria-label="Saved family schedule"
        style={{ display: "grid", gap: 8, marginTop: 20, marginBottom: 20 }}
      >
        <h3 style={{ fontWeight: 700 }}>Saved family schedule</h3>
        {workflow.monthlySchedule.status === "unavailable" ? (
          <Unavailable message={workflow.monthlySchedule.message} />
        ) : workflow.monthlySchedule.data === null ? (
          <p>
            Not scheduled yet. Save school settings to enable monthly
            preparation.
          </p>
        ) : (
          <>
            <p>
              Status:{" "}
              {
                monthlyScheduleStatusLabels[
                  workflow.monthlySchedule.data.status
                ]
              }
            </p>
            <MonthlyScheduleEditor
              key={workflow.monthlySchedule.data.taskId}
              schedule={workflow.monthlySchedule.data}
              busy={busy}
              save={(input) =>
                run(() => adapter.updateMonthlySchedule(input), "schedule")
              }
              error={
                errorTarget === "schedule" && error ? (
                  <Unavailable message={error} />
                ) : null
              }
            />
            <p>
              Last recorded start:{" "}
              {date(workflow.monthlySchedule.data.lastFiredAt)}
            </p>
            <p>
              Checks school dates and prepares an owner-review packet. Email
              still requires your approval.
            </p>
          </>
        )}
        <a href="/automations">Review scheduled tasks</a>
      </section>
      <p>
        <strong>Status:</strong> {schoolStatusLabels[workflow.state]} · checked{" "}
        {date(workflow.lastCheckedAt)}
      </p>
      {workflow.changes?.length ? (
        <ul>
          {workflow.changes.map((change) => (
            <li key={`${change.kind}:${change.label}`}>
              {change.kind}: {change.label}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No pending calendar differences.</Empty>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <Button
          className="min-h-12"
          disabled={busy}
          onClick={() => void run(() => adapter.runSchoolWorkflow())}
        >
          <RefreshCw size={16} /> Run now
        </Button>
        {workflow.state === "awaiting_approval" && workflow.runId ? (
          <Button
            className="min-h-12"
            disabled={busy}
            variant="outline"
            onClick={() =>
              void run(() =>
                adapter.approveSchoolDiff(workflow.runId as string),
              )
            }
          >
            <ShieldCheck size={16} /> Approve diff
          </Button>
        ) : null}
      </div>
      {errorTarget === "school" && error ? (
        <Unavailable message={error} />
      ) : null}
    </Card>
  );
}

function PacketPanel({
  state,
  emailOptions,
  adapter,
  refresh,
  intakeAdapter,
}: {
  state: FamilyOperationsSnapshot["packets"];
  emailOptions: FamilyOperationsSnapshot["emailOptions"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
  intakeAdapter: FamilyIntakeAdapter;
}) {
  const [currentPeriod, setCurrentPeriod] = useState(
    () => nextFamilyPacketPeriod(new Date()).key,
  );
  const [requestedPeriod, setRequestedPeriod] = useState(currentPeriod);
  const [confirmMonthChange, setConfirmMonthChange] = useState(false);
  const [intakeEditState, setIntakeEditState] = useState({
    busy: false,
    unsaved: false,
  });
  const [generating, setGenerating] = useState(false);
  const [recipientKey, setRecipientKey] = useState("");
  const [senderGrantId, setSenderGrantId] = useState("");
  const [subject, setSubject] = useState(
    `Family coordination for ${currentPeriod}`,
  );
  const recipient =
    emailOptions.status === "ready"
      ? emailOptions.data.recipients.find(
          (value) =>
            JSON.stringify([value.entityId, value.address]) === recipientKey,
        )
      : undefined;
  const sender =
    emailOptions.status === "ready"
      ? emailOptions.data.accounts.find(
          (value) => value.grantId === senderGrantId,
        )
      : undefined;
  const [calendarPrivacyMode, setCalendarPrivacyMode] = useState<
    "full" | "times_only" | "busy_only"
  >("busy_only");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  const selectedPackets = state.data.filter(
    (packet) => packet.periodKey === currentPeriod,
  );
  const latestPacket = selectedPackets.reduce<
    (typeof selectedPackets)[number] | undefined
  >(
    (latest, packet) =>
      !latest || packet.version > latest.version ? packet : latest,
    undefined,
  );
  const missingSections = latestPacket
    ? latestPacket.sections
        .filter((section) => section.state === "missing")
        .map((section) => section.section)
    : ["custody_calendar", "school", "travel_consent_health", "unanswered"];
  const validRequestedPeriod = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(
    requestedPeriod,
  );
  const openMonth = () => {
    if (!validRequestedPeriod || intakeEditState.busy || generating) return;
    setSubject((value) =>
      value === `Family coordination for ${currentPeriod}`
        ? `Family coordination for ${requestedPeriod}`
        : value,
    );
    setCurrentPeriod(requestedPeriod);
    setIntakeEditState({ busy: false, unsaved: false });
    setConfirmMonthChange(false);
    setError(null);
    setNotice(null);
  };
  const generate = async () => {
    setGenerating(true);
    try {
      setError(null);
      await adapter.generatePacket(currentPeriod);
      await refresh();
    } catch (cause) {
      // error-policy:J4 Generation failure remains visible and does not replace saved packets.
      setError(
        cause instanceof Error ? cause.message : "Packet generation failed",
      );
    } finally {
      setGenerating(false);
    }
  };
  const createDraft = async (
    packetId: string,
    expectedPacketVersion: number,
  ) => {
    try {
      setError(null);
      setNotice(null);
      if (!recipient || !sender)
        throw new Error("Choose a connected sender and a verified recipient.");
      await adapter.createPacketDraft({
        packetId,
        expectedPacketVersion,
        recipient: recipient.address,
        recipientEntityId: recipient.entityId,
        calendarPrivacyMode,
        email: { subject, senderGrantId: sender.grantId },
      });
      setNotice("Immutable guest-shareable draft created for review.");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Draft creation failed",
      );
    }
  };
  const requestApproval = async (packetId: string, draftVersion: number) => {
    try {
      setError(null);
      setNotice(null);
      await adapter.requestPacketApproval(packetId, draftVersion);
      setNotice("Exact draft submitted to the owner approval queue.");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Approval request failed",
      );
    }
  };
  const canCreateDraft = Boolean(recipient && sender && subject.trim());
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section aria-label="Packet month" className="space-y-3">
        <label className="grid gap-2" htmlFor="family-packet-month">
          Month to prepare
          <Input
            id="family-packet-month"
            type="month"
            value={requestedPeriod}
            disabled={intakeEditState.busy || generating}
            onChange={(event) => {
              setRequestedPeriod(event.target.value);
              setConfirmMonthChange(false);
            }}
          />
        </label>
        <Button
          variant="accentDarkHover"
          disabled={
            !validRequestedPeriod ||
            requestedPeriod === currentPeriod ||
            intakeEditState.busy ||
            generating
          }
          onClick={() =>
            intakeEditState.unsaved ? setConfirmMonthChange(true) : openMonth()
          }
        >
          Open month
        </Button>
        {confirmMonthChange ? (
          <div role="alert" className="space-y-3">
            <p>
              Opening {requestedPeriod} will discard unsaved correspondence and
              fact edits. Saved source reviews remain in {currentPeriod}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmMonthChange(false);
                  setRequestedPeriod(currentPeriod);
                }}
              >
                Keep editing
              </Button>
              <Button
                variant="accentDarkHover"
                disabled={intakeEditState.busy || generating}
                onClick={openMonth}
              >
                Discard edits and open month
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      <FamilyIntakePanel
        key={currentPeriod}
        period={currentPeriod}
        adapter={intakeAdapter}
        emailOptions={emailOptions}
        onChanged={refresh}
        onEditStateChange={setIntakeEditState}
        missingSections={missingSections}
      />
      <div>
        <Button
          variant="accentDarkHover"
          disabled={
            generating || intakeEditState.busy || intakeEditState.unsaved
          }
          onClick={() => void generate()}
        >
          {generating
            ? "Generating packet…"
            : `Generate ${currentPeriod} packet`}
        </Button>
        {intakeEditState.unsaved ? (
          <p>
            Save or discard correspondence edits before generating the packet.
          </p>
        ) : null}
      </div>
      {emailOptions.status === "unavailable" ? (
        <Unavailable message={emailOptions.message} />
      ) : emailOptions.data.accounts.length === 0 ? (
        <p>
          Connect an email account with permission to send approved email in
          Mail &amp; Calendars.
        </p>
      ) : emailOptions.data.recipients.length === 0 ? (
        <p>
          Add and verify your recipient's email address before preparing an
          external draft.
        </p>
      ) : null}
      <RecipientSetup
        adapter={adapter}
        onConfirmed={async (contact) => {
          await refresh();
          setRecipientKey(JSON.stringify([contact.entityId, contact.address]));
          setNotice(
            "Recipient confirmed. Review a new draft before approving email delivery.",
          );
        }}
      />
      <Card
        title="Monthly email"
        detail="Choose your sending account and a verified recipient. Review the exact email before approving delivery."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 12,
          }}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor="packet-sender">Sending account</label>
            <Select value={senderGrantId} onValueChange={setSenderGrantId}>
              <SelectTrigger id="packet-sender" aria-label="Sending account">
                <SelectValue placeholder="Choose a sending account" />
              </SelectTrigger>
              <SelectContent>
                {emailOptions.status === "ready"
                  ? emailOptions.data.accounts.map((account) => (
                      <SelectItem key={account.grantId} value={account.grantId}>
                        {account.label}
                      </SelectItem>
                    ))
                  : null}
              </SelectContent>
            </Select>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor="packet-recipient">Email recipient</label>
            <Select value={recipientKey} onValueChange={setRecipientKey}>
              <SelectTrigger id="packet-recipient" aria-label="Email recipient">
                <SelectValue placeholder="Choose a verified contact" />
              </SelectTrigger>
              <SelectContent>
                {emailOptions.status === "ready"
                  ? emailOptions.data.recipients.map((contact) => (
                      <SelectItem
                        key={JSON.stringify([
                          contact.entityId,
                          contact.address,
                        ])}
                        value={JSON.stringify([
                          contact.entityId,
                          contact.address,
                        ])}
                      >
                        {contact.name} — {contact.address}
                      </SelectItem>
                    ))
                  : null}
              </SelectContent>
            </Select>
          </div>
          <label
            htmlFor="packet-email-subject"
            style={{ display: "grid", gap: 6 }}
          >
            Subject
            <Input
              aria-label="Email subject"
              id="packet-email-subject"
              value={subject}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setSubject(event.target.value)
              }
            />
          </label>
          <label
            htmlFor="packet-calendar-privacy"
            style={{ display: "grid", gap: 6 }}
          >
            <span>Calendar privacy</span>
            <Select
              value={calendarPrivacyMode}
              onValueChange={(value) =>
                setCalendarPrivacyMode(
                  value as "full" | "times_only" | "busy_only",
                )
              }
            >
              <SelectTrigger
                id="packet-calendar-privacy"
                aria-label="Calendar privacy"
                className="min-h-11"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="busy_only">Busy only</SelectItem>
                <SelectItem value="times_only">Times only</SelectItem>
                <SelectItem value="full">Full event details</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
      </Card>
      {selectedPackets.length === 0 ? (
        <Empty>No packet has been generated for {currentPeriod}.</Empty>
      ) : (
        selectedPackets.map((packet) => (
          <Card
            key={`${packet.packetId}:${packet.version}`}
            title={`${packet.periodKey} · version ${packet.version}`}
            detail={`Built ${date(packet.createdAt)} · ${packetStatusLabels[packet.status]}`}
          >
            {packet.sections
              .filter((section) => section.state !== "complete")
              .map((section) => (
                <section
                  key={section.section}
                  aria-label={`${packetSectionLabels[section.section]} review`}
                >
                  <h3>{packetSectionLabels[section.section]}</h3>
                  {section.state === "missing" ? (
                    <p>
                      No source material is recorded for this section. Add the
                      relevant information before regenerating the packet; an
                      empty section does not confirm there is nothing to report.
                    </p>
                  ) : (
                    <>
                      <p>
                        These sources disagree. Review and correct the
                        underlying information before regenerating the packet.
                      </p>
                      <ul>
                        {packet.claims
                          .filter((claim) =>
                            section.claimIds.includes(claim.id),
                          )
                          .map((claim) => (
                            <li key={claim.id}>{claim.text}</li>
                          ))}
                      </ul>
                    </>
                  )}
                </section>
              ))}
            <ul>
              {packet.claims
                .filter(
                  (claim) =>
                    !packet.sections.some(
                      (section) =>
                        section.state === "contradictory" &&
                        section.claimIds.includes(claim.id),
                    ),
                )
                .map((claim) => (
                  <li key={claim.id}>
                    <strong>{packetSectionLabels[claim.section]}:</strong>{" "}
                    {claim.text}
                  </li>
                ))}
            </ul>
            <div style={{ marginBottom: 12 }}>
              <Button
                variant="outline"
                disabled={!canCreateDraft}
                onClick={() =>
                  void createDraft(packet.packetId, packet.version)
                }
              >
                Create privacy-filtered draft
              </Button>
            </div>
            {packet.draft ? (
              <details>
                <summary>
                  Review guest-shareable draft v{packet.draft.draftVersion}
                </summary>
                <p>To: {packet.draft.recipient}</p>
                {packet.draft.email ? (
                  <>
                    <p>
                      From:{" "}
                      {emailOptions.status === "ready"
                        ? (emailOptions.data.accounts.find(
                            (account) =>
                              account.grantId ===
                              packet.draft?.email?.senderGrantId,
                          )?.label ?? "Sender account is no longer connected")
                        : "Sender account status unavailable"}
                    </p>
                    <p>Subject: {packet.draft.email.subject}</p>
                  </>
                ) : null}
                <pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>
                  {packet.draft.body}
                </pre>
                <p>
                  <a
                    download={`family-packet-${packet.periodKey}-draft-${packet.draft.draftVersion}.json`}
                    href={`data:application/json;charset=utf-8,${encodeURIComponent(
                      JSON.stringify(
                        {
                          recordType: "family_packet_draft",
                          deliveryStatus: "not_verified_by_this_record",
                          packetId: packet.packetId,
                          period: packet.periodKey,
                          packetVersion: packet.version,
                          draft: packet.draft,
                        },
                        null,
                        2,
                      ),
                    )}`}
                  >
                    Download draft record
                  </a>
                </p>
                <PacketDraftEditor
                  key={packet.draft.draftVersion}
                  packetId={packet.packetId}
                  draft={packet.draft}
                  adapter={adapter}
                  refresh={refresh}
                  requestApproval={(version) =>
                    requestApproval(packet.packetId, version)
                  }
                />
              </details>
            ) : (
              <Empty>No shareable draft yet.</Empty>
            )}
          </Card>
        ))
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <Unavailable message={error} /> : null}
    </div>
  );
}

export interface FamilyOperationsViewProps {
  intakeAdapter?: FamilyIntakeAdapter;
  adapter?: FamilyOperationsAdapter;
  deletionAdapter?: FamilyDeletionAdapter;
}

export function FamilyOperationsView({
  adapter = defaultFamilyOperationsAdapter,
  intakeAdapter = defaultFamilyIntakeAdapter,
  deletionAdapter,
}: FamilyOperationsViewProps) {
  const [tab, setTab] = useState<Tab>("agreements");
  const [snapshot, setSnapshot] = useState<FamilyOperationsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const exportWorkspace = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const blob = await adapter.downloadWorkspace();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "family-workspace.zip";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExportNotice("Workspace download started.");
    } catch (cause) {
      // error-policy:J1 A failed export remains visible and can be retried.
      setExportError(
        cause instanceof Error ? cause.message : "Workspace export failed",
      );
    } finally {
      setExporting(false);
    }
  };
  const refresh = useCallback(
    async (requireAgreementReview = false) => {
      setLoading(true);
      setError(null);
      try {
        const next = await adapter.load();
        if (requireAgreementReview && next.agreements.status === "unavailable")
          throw new Error(next.agreements.message);
        setSnapshot(next);
      } catch (cause) {
        // error-policy:J4 Keep the prior view with an explicit refresh failure; review preparation must also observe the failure.
        setError(
          cause instanceof Error
            ? cause.message
            : "Family Operations could not load",
        );
        if (requireAgreementReview) throw cause;
      } finally {
        setLoading(false);
      }
    },
    [adapter],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main
      style={{
        ...{
          "--accent": "var(--brand-orange)",
          "--accent-foreground": "#140c07",
          "--accent-hover": "#e65a10",
          "--accent-muted": "#c94400",
          "--accent-subtle": "rgba(255,106,31,0.08)",
          "--inverse": "#fdfaf7",
        },
        width: "100%",
        // This fullscreen plugin owns its scroller; keep interactive rows above
        // the shell's measured resting composer rather than behind its overlay.
        height: "calc(100% - var(--eliza-chat-clearance, 5.25rem))",
        minHeight: 0,
        overflowY: "auto",
        color: "var(--txt)",
        background:
          "radial-gradient(circle at 8% 0%, var(--accent-subtle), transparent 35%), var(--bg)",
        padding: "clamp(14px, 3vw, 28px)",
        paddingBottom:
          "calc(clamp(14px, 3vw, 28px) + var(--eliza-chat-clearance, 5.25rem))",
      }}
    >
      <div
        style={{
          maxWidth: 1040,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 18,
        }}
      >
        <header>
          <p
            style={{
              margin: 0,
              color: "var(--accent)",
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              fontSize: 12,
            }}
          >
            Private owner workspace
          </p>
          <h1 style={{ margin: "6px 0", fontSize: "clamp(28px, 5vw, 44px)" }}>
            Family Operations
          </h1>
          <p style={{ margin: 0, color: "var(--muted)", maxWidth: 720 }}>
            Review the parenting agreement, calendar synchronization, school
            dates, and monthly coordination email.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={loading || exporting}
            onClick={() => void exportWorkspace()}
            style={{ marginTop: 12 }}
          >
            {exporting ? "Preparing workspace export…" : "Export workspace"}
          </Button>
          {exportError ? <Unavailable message={exportError} /> : null}
          {exportNotice ? <p role="status">{exportNotice}</p> : null}
        </header>
        <nav
          aria-label="Family Operations sections"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              type="button"
              variant="choice"
              data-state={tab === id ? "on" : "off"}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
              className="min-h-12 w-full font-bold"
            >
              <Icon size={18} aria-hidden />
              {label}
            </Button>
          ))}
        </nav>
        {loading && !snapshot ? (
          <p role="status">Loading Family Operations…</p>
        ) : null}
        {error ? <Unavailable message={error} /> : null}
        {snapshot ? (
          <div>
            {tab === "agreements" ? (
              <AgreementPanel
                state={snapshot.agreements}
                adapter={adapter}
                refresh={refresh}
                refreshReview={() => refresh(true)}
              />
            ) : tab === "calendar" ? (
              <CalendarPanel
                state={snapshot.calendarLinks}
                adapter={adapter}
                refresh={refresh}
              />
            ) : tab === "school" ? (
              <SchoolPanel
                state={snapshot.school}
                adapter={adapter}
                refresh={refresh}
              />
            ) : (
              <PacketPanel
                intakeAdapter={intakeAdapter}
                state={snapshot.packets}
                emailOptions={snapshot.emailOptions}
                adapter={adapter}
                refresh={refresh}
              />
            )}
          </div>
        ) : null}
        <FamilyDeletionPanel adapter={deletionAdapter} onChange={refresh} />
      </div>
    </main>
  );
}
