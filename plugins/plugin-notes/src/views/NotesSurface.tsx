/**
 * Renders the authoritative Notes snapshot as a calm read-only collection.
 * Kept transport-agnostic so production, focused tests, and QA fixtures all
 * exercise the same presentation contract.
 */

import { CompactCardSkeleton } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { isApiError } from "@elizaos/ui/api";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { ViewHeader } from "@elizaos/ui/components/shared/ViewHeader";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";
import type { NotesSnapshot, StickyNote as StickyNoteModel } from "../types.js";
import {
  AgentAction,
  COLOR_MATERIALS,
  PANEL_STYLE,
  SECONDARY_TEXT_STYLE,
} from "./viewPrimitives.js";

const COLLECTION_STYLE: CSSProperties = {
  width: "100%",
};

const NOTE_LIST_STYLE: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const NOTE_ROW_BASE_STYLE: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 112,
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Updated";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function noteContent(note: StickyNoteModel): string {
  const body = note.body.trim();
  return body ? `${note.title}\n${body}` : note.title;
}

function NoteRow({ note }: { note: StickyNoteModel }) {
  const content = noteContent(note);
  const card = useAgentElement<HTMLLIElement>({
    id: note.id,
    label: `Note ${note.title}`,
    role: "card",
    group: "notes-list",
    description: content,
    status: note.color,
  });
  const material = COLOR_MATERIALS[note.color];
  const body = note.body.trim();

  return (
    <li
      ref={card.ref}
      {...card.agentProps}
      data-note-color={note.color}
      style={{
        ...PANEL_STYLE,
        ...NOTE_ROW_BASE_STYLE,
        margin: 0,
        background: `linear-gradient(${material}, ${material}), var(--card, #121212)`,
      }}
    >
      <h2
        style={{
          margin: 0,
          color: "var(--txt, #f5f5f5)",
          fontSize: 16,
          lineHeight: 1.35,
          fontWeight: 650,
          letterSpacing: "-.012em",
          overflowWrap: "anywhere",
        }}
      >
        {note.title}
      </h2>
      {body ? (
        <p
          style={{
            margin: 0,
            color: "var(--muted-strong, rgba(255,255,255,.78))",
            fontSize: 14,
            lineHeight: 1.5,
            fontWeight: 430,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {body}
        </p>
      ) : null}
      <p
        style={{
          ...SECONDARY_TEXT_STYLE,
          marginTop: 6,
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatUpdatedAt(note.updatedAt)}
      </p>
    </li>
  );
}

function NotesLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading notes"
      style={COLLECTION_STYLE}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            style={{
              ...PANEL_STYLE,
              ...NOTE_ROW_BASE_STYLE,
              margin: 0,
            }}
          >
            <CompactCardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}

interface NotesIssue {
  kind:
    | "runtime_unavailable"
    | "offline"
    | "access_denied"
    | "rate_limited"
    | "request_failed";
  title: string;
  message: string;
  retryable: boolean;
}

function errorData(error: Error): Record<string, unknown> | null {
  return isApiError(error) &&
    typeof error.data === "object" &&
    error.data !== null &&
    !Array.isArray(error.data)
    ? (error.data as Record<string, unknown>)
    : null;
}

function notesIssue(error: Error | null): NotesIssue | null {
  if (!error) return null;
  const data = errorData(error);
  const declaredRetryability =
    typeof data?.retryable === "boolean" ? data.retryable : null;
  const retryable = (fallback: boolean): boolean =>
    declaredRetryability ?? fallback;

  if (isApiError(error) && error.code === "notes_runtime_unavailable") {
    return {
      kind: "runtime_unavailable",
      title: "Notes need a Dedicated agent",
      message:
        "Connect a Dedicated agent to keep a persistent Notes collection.",
      retryable: retryable(false),
    };
  }

  if (isApiError(error)) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "access_denied",
        title: "Notes aren't available",
        message: "This account can't access these notes.",
        retryable: retryable(false),
      };
    }
    if (error.status === 404) {
      return {
        kind: "request_failed",
        title: "Notes unavailable",
        message: "The Notes service is unavailable on this runtime.",
        retryable: retryable(false),
      };
    }
    if (error.status === 429) {
      return {
        kind: "rate_limited",
        title: "Notes are busy",
        message: "Wait a moment, then try again.",
        retryable: retryable(true),
      };
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return {
        kind: "offline",
        title: "Notes are temporarily unavailable",
        message:
          "Eliza isn't responding. Try again when the connection is back.",
        retryable: retryable(true),
      };
    }
  }

  const message = error.message.toLowerCase();
  if (
    error instanceof TypeError ||
    /failed to fetch|network|offline|disconnected|connection|api server unavailable/.test(
      message,
    )
  ) {
    return {
      kind: "offline",
      title: "Notes are offline",
      message: "Reconnect to Eliza to see your saved notes.",
      retryable: retryable(true),
    };
  }

  return {
    kind: "request_failed",
    title: "Notes couldn't load",
    message: "Try again. If this keeps happening, reconnect your agent.",
    retryable: retryable(true),
  };
}

function SyncWarning({
  issue,
  onRetry,
}: {
  issue: NotesIssue;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
        padding: "2px 2px 6px",
      }}
    >
      <AlertTriangle
        size={16}
        strokeWidth={1.8}
        aria-hidden
        style={{
          flex: "0 0 auto",
          color: "var(--muted, rgba(255,255,255,.62))",
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.35,
            fontWeight: 600,
          }}
        >
          {issue.title}
        </p>
        <p
          style={{
            ...SECONDARY_TEXT_STYLE,
            marginTop: 2,
            fontSize: 12,
          }}
        >
          {issue.message}
        </p>
      </div>
      {issue.retryable ? (
        <AgentAction
          agentId="notes-retry"
          agentLabel="Retry Notes"
          agentGroup="notes-status"
          compact
          variant="quiet"
          onClick={onRetry}
        >
          <RefreshCw size={17} aria-hidden />
        </AgentAction>
      ) : null}
    </div>
  );
}

function NotesRecoveryState({
  issue,
  onRetry,
}: {
  issue: NotesIssue | null;
  onRetry: () => void;
}) {
  const resolvedIssue =
    issue ??
    ({
      kind: "request_failed",
      title: "Notes unavailable",
      message: "Notes could not reach Eliza.",
      retryable: true,
    } satisfies NotesIssue);

  return (
    <PagePanel.ContentState
      state="error"
      placement="workspace"
      className="min-h-[58vh]"
      title={resolvedIssue.title}
      description={resolvedIssue.message}
      tone={resolvedIssue.kind === "runtime_unavailable" ? "warning" : "danger"}
      action={
        resolvedIssue.retryable ? (
          <AgentAction
            agentId="notes-retry"
            agentLabel="Retry Notes"
            agentGroup="notes-status"
            onClick={onRetry}
          >
            <RefreshCw size={16} aria-hidden />
            Try again
          </AgentAction>
        ) : undefined
      }
    />
  );
}

function NotesCollectionHeader({
  count,
  issue,
}: {
  count: number;
  issue: NotesIssue | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: 36,
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingInline: 2,
      }}
    >
      <p
        style={{
          margin: 0,
          color: "var(--txt, #f5f5f5)",
          fontSize: 13,
          lineHeight: 1.4,
          fontWeight: 650,
        }}
      >
        {count} {count === 1 ? "note" : "notes"}
      </p>
      <p
        aria-live="polite"
        style={{
          ...SECONDARY_TEXT_STYLE,
          minWidth: 0,
          fontSize: 12,
          textAlign: "right",
        }}
      >
        {issue ? "Last available snapshot" : "Ask Eliza to create or edit"}
      </p>
    </div>
  );
}

function viewLabel({
  count,
  hasSnapshot,
  loading,
  error,
}: {
  count: number;
  hasSnapshot: boolean;
  loading: boolean;
  error: Error | null;
}): string {
  if (!hasSnapshot) {
    if (loading) return "Notes. Loading.";
    return "Notes. Unavailable.";
  }
  const noteCount = `${count} ${count === 1 ? "note" : "notes"}`;
  if (error) {
    return count > 0
      ? `Notes. Sync unavailable. Showing ${noteCount}.`
      : "Notes. Sync unavailable.";
  }
  // Cached content keeps its name during background refreshes. The frame's
  // aria-busy state reports synchronization without relabelling the collection.
  return `Notes. ${noteCount}.`;
}

export interface NotesSurfaceProps {
  snapshot: NotesSnapshot | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Render the shared route header. Every caller must declare its chrome context. */
  standalone: boolean;
}

export function NotesSurface({
  snapshot,
  loading,
  error,
  refresh,
  standalone,
}: NotesSurfaceProps) {
  const notes = snapshot?.notes ?? [];
  const issue = notesIssue(error);

  return (
    <PagePanel.Frame
      as="main"
      aria-busy={loading}
      aria-label={viewLabel({
        count: notes.length,
        hasSnapshot: Boolean(snapshot),
        loading,
        error,
      })}
      data-testid="simple-notes-view"
      className="relative flex-col overflow-hidden text-txt"
    >
      {standalone ? <ViewHeader title="Notes" /> : null}
      <PagePanel.ContentArea data-testid="simple-notes-scroll-region">
        <PagePanel.ContentRail
          width="wide"
          className="px-0 sm:px-0"
          style={{
            paddingBlockStart: "var(--view-pad-top, .5rem)",
            paddingBlockEnd: "var(--view-pad-bottom, 1rem)",
          }}
        >
          {!snapshot ? (
            loading ? (
              <NotesLoadingSkeleton />
            ) : (
              <NotesRecoveryState
                issue={issue}
                onRetry={() => void refresh()}
              />
            )
          ) : (
            <section aria-label="Notes" style={COLLECTION_STYLE}>
              {issue && notes.length > 0 ? (
                <>
                  <NotesCollectionHeader count={notes.length} issue={issue} />
                  <SyncWarning issue={issue} onRetry={() => void refresh()} />
                </>
              ) : null}
              {issue && notes.length === 0 ? (
                <NotesRecoveryState
                  issue={issue}
                  onRetry={() => void refresh()}
                />
              ) : notes.length === 0 ? (
                <PagePanel.ContentState
                  state="empty"
                  placement="workspace"
                  className="min-h-[58vh]"
                  title="No notes yet"
                  description="Ask Eliza to save something here."
                />
              ) : (
                <>
                  {issue ? null : (
                    <NotesCollectionHeader count={notes.length} issue={null} />
                  )}
                  <ul
                    data-testid="simple-notes-list"
                    className="grid grid-cols-1 gap-3 lg:grid-cols-2"
                    style={NOTE_LIST_STYLE}
                  >
                    {notes.map((note) => (
                      <NoteRow key={note.id} note={note} />
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </PagePanel.ContentRail>
      </PagePanel.ContentArea>
    </PagePanel.Frame>
  );
}
