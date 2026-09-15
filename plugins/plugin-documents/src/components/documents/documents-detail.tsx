/**
 * Document detail viewer for the Documents/Knowledge page: loads one document
 * by id, shows its metadata and source/scope badges, renders its fragments, and
 * supports inline text editing with save. Pure formatting helpers live in
 * documents-detail.helpers; this file owns the fetch/edit/save lifecycle.
 */

import type {
  Transcript,
  TranscriptCaptureSharingState,
} from "@elizaos/shared/transcripts";
import {
  client,
  type DocumentDetail,
  type DocumentFragmentRecord,
} from "@elizaos/ui/api";
import { Button, DetailSkeleton, Textarea } from "@elizaos/ui/components";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { SettingsGroup } from "@elizaos/ui/components/composites/settings";
import { TranscriptPlayer } from "@elizaos/ui/components/transcripts/TranscriptPlayer";
import { ArtifactPrivacyControls } from "@elizaos/ui/components/transcripts/TranscriptsView";
import { useAppSelector } from "@elizaos/ui/state";
import { formatByteSize, resolveAppAssetUrl } from "@elizaos/ui/utils";
import { safeAttachmentUrl } from "@elizaos/ui/utils/attachment-url";
import { confirmDesktopAction } from "@elizaos/ui/utils/desktop-dialogs";
import {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "@elizaos/ui/utils/download-share";
import {
  AlertTriangle,
  Download,
  FileText,
  Maximize2,
  Minimize2,
  Pencil,
  Save,
  Share2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DocumentAccessPanel } from "./document-access-panel";
import { DocumentPinsPanel } from "./document-pins-panel";
import { getDocumentSourceLabel } from "./documents-detail.helpers";
import { knowledgeReaderKind } from "./knowledge-media-format";

function formatDocumentTimestamp(value?: number): string | null {
  if (!value) return null;
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type DocumentLoadIssue = {
  title: string;
  description: string;
  retryable: boolean;
};

function documentLoadIssue(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): DocumentLoadIssue {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("no longer available")) {
    return {
      title: t("documentsview.DocumentUnavailable", {
        defaultValue: "This document is no longer available",
      }),
      description: t("documentsview.DocumentUnavailableHint", {
        defaultValue: "Return to the library and choose another item.",
      }),
      retryable: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: t("documentsview.DocumentAccessUnavailable", {
        defaultValue: "This document isn't available",
      }),
      description: t("documentsview.DocumentAccessUnavailableHint", {
        defaultValue: "This account can't open it.",
      }),
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      title: t("documentsview.DocumentUnavailable", {
        defaultValue: "This document is no longer available",
      }),
      description: t("documentsview.DocumentUnavailableHint", {
        defaultValue: "Return to the library and choose another item.",
      }),
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      title: t("documentsview.DocumentBusy", {
        defaultValue: "This document is busy",
      }),
      description: t("documentsview.DocumentBusyHint", {
        defaultValue: "Wait a moment, then try again.",
      }),
      retryable: true,
    };
  }
  return {
    title: t("documentsview.FailedToLoadDocument", {
      defaultValue: "This document couldn't load",
    }),
    description: t("documentsview.FailedToLoadDocumentHint", {
      defaultValue: "Try again when Eliza is connected.",
    }),
    retryable: true,
  };
}

/* ── Document Viewer ────────────────────────────────────────────────── */

export function DocumentViewer({
  documentId,
  initialSeekMs,
  onUpdated,
}: {
  documentId: string | null;
  initialSeekMs?: number;
  onUpdated?: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [fragments, setFragments] = useState<DocumentFragmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DocumentLoadIssue | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // The rich Transcript backing a transcript-mirror knowledge record (#8789):
  // loaded lazily so the reader can render the word-synced player. The knowledge
  // doc stays the searchable denormalized copy; TranscriptStore stays the truth.
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);

  useEffect(() => {
    const id = documentId ?? "";
    void reloadToken; // re-run on manual refresh (kept in deps below)
    setFullscreen(false);
    setTranscript(null);
    if (!id) {
      setDoc(null);
      setFragments([]);
      setLoading(false);
      setError(null);
      setEditing(false);
      setDraftText("");
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const [docRes, fragRes] = await Promise.all([
        client.getDocument(id),
        client.getDocumentFragments(id),
      ]);

      if (cancelled) return;

      // A well-formed detail response always carries `document`; if the backend
      // returns an empty/malformed body (or the doc was deleted between the list
      // and detail fetch), surface a clean message instead of letting a raw
      // "Cannot read properties of undefined (reading 'content')" TypeError
      // reach the user as the error text (#8876).
      if (!docRes?.document) {
        throw new Error(
          t("documentsview.DocumentUnavailable", {
            defaultValue: "This document is no longer available.",
          }),
        );
      }

      setDoc(docRes.document);
      setFragments(fragRes?.fragments ?? []);
      setDraftText(docRes.document.content?.text ?? "");
      setEditing(false);
      setLoading(false);
    }

    load().catch((err) => {
      if (!cancelled) {
        setError(documentLoadIssue(err, t));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [documentId, reloadToken, t]);

  // Load the rich transcript once we know the record mirrors one. Kept out of
  // the main effect so a document without a transcript never pays for it.
  const transcriptId = doc?.transcriptId;
  useEffect(() => {
    if (!transcriptId) {
      setTranscript(null);
      return;
    }
    let cancelled = false;
    client
      .getTranscript(transcriptId)
      .then((res) => {
        if (!cancelled) setTranscript(res.transcript);
      })
      .catch(() => {
        // error-policy:J4 — the transcript store may not hold this record (or
        // the plugin is absent). The reader degrades to plain audio + the
        // searchable text copy below; no error state for a missing enrichment.
        if (!cancelled) setTranscript(null);
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptId]);

  const handleUpdateTranscriptPrivacy = (
    sharing: Partial<TranscriptCaptureSharingState>,
  ) => {
    if (!transcriptId) return;
    setPrivacySaving(true);
    setPrivacyError(null);
    client
      .updateTranscriptPrivacy(transcriptId, { sharing })
      .then(({ transcript: updated }) => setTranscript(updated))
      .catch((privacyUpdateError) => {
        // error-policy:J4 privacy mutation failures remain visible in the artifact reader.
        setPrivacyError(
          privacyUpdateError instanceof Error
            ? privacyUpdateError.message
            : "Failed to update artifact privacy",
        );
      })
      .finally(() => setPrivacySaving(false));
  };

  const handleDeleteTranscriptSourceAudio = async () => {
    if (!transcriptId) return;
    const confirmed = await confirmDesktopAction({
      title: "Delete source audio?",
      message:
        "The transcript text will remain, but audio replay cannot be restored.",
      type: "warning",
      confirmLabel: "Delete audio",
    });
    if (!confirmed) return;
    setPrivacySaving(true);
    setPrivacyError(null);
    try {
      const { transcript: updated } =
        await client.deleteTranscriptSourceAudio(transcriptId);
      setTranscript(updated);
    } catch (sourceAudioDeleteError) {
      // error-policy:J4 source deletion failures remain visible in the artifact reader.
      setPrivacyError(
        sourceAudioDeleteError instanceof Error
          ? sourceAudioDeleteError.message
          : "Failed to delete source audio",
      );
    } finally {
      setPrivacySaving(false);
    }
  };

  const previewText = doc?.content?.text?.trim();
  const readerKind = doc
    ? knowledgeReaderKind({
        contentType: doc.contentType,
        transcriptId: doc.transcriptId,
      })
    : "text";
  const documentCreatedLabel = formatDocumentTimestamp(doc?.createdAt);
  const scopeLabel =
    doc?.scope === "owner-private"
      ? t("documentsview.ScopeOwner", { defaultValue: "Owner" })
      : doc?.scope === "user-private"
        ? t("documentsview.ScopeUser", { defaultValue: "Private" })
        : doc?.scope === "agent-private"
          ? t("documentsview.ScopeAgent", { defaultValue: "Agent" })
          : null;
  const readableText =
    previewText || fragments.map((fragment) => fragment.text).join("\n\n");

  // The original served file (when the backend exposes a fetchable URL for the
  // document, e.g. uploaded binaries / mirrored transcript audio). v1 gates the
  // download/share affordances on this URL existing.
  const servedFileUrl =
    doc?.transcriptId && transcript
      ? transcript.audioUrl || null
      : doc?.url || doc?.transcriptAudioUrl || null;
  // Resolve to an app-absolute URL and pass it through the attachment-URL
  // allowlist before ever handing it to an <img>/<audio>/<video>/<iframe> src
  // (reuse the one guard; do not add a second, #8876).
  const mediaUrl = servedFileUrl
    ? safeAttachmentUrl(resolveAppAssetUrl(servedFileUrl))
    : "";
  const shareSupported = canShareFiles();

  const handleDownloadFile = async () => {
    if (!servedFileUrl || !doc) return;
    const filename = doc.filename || filenameForMime(doc.contentType);
    try {
      await downloadAttachment(servedFileUrl, filename);
    } catch {
      setActionNotice(
        t("documentsview.FailedToDownload", {
          defaultValue: "Failed to download file",
        }),
        "error",
        4000,
      );
    }
  };

  const handleShareFile = async () => {
    if (!servedFileUrl || !doc) return;
    const shared = await shareAttachment(servedFileUrl, {
      title: doc.filename,
      filename: doc.filename || undefined,
    });
    if (!shared) await handleDownloadFile();
  };

  const handleSave = async () => {
    if (!documentId || !doc) return;
    setSaving(true);
    try {
      const result = await client.updateDocument(documentId, {
        content: draftText,
      });
      setActionNotice(
        t("documentsview.DocumentUpdated", {
          defaultValue: "Updated knowledge document ({{count}} fragments)",
          count: result.fragmentCount,
        }),
        "success",
        3000,
      );
      setEditing(false);
      setReloadToken((current) => current + 1);
      onUpdated?.();
    } catch {
      setActionNotice(
        t("documentsview.FailedToUpdateDocument", {
          defaultValue: "Couldn't save this document. Try again.",
        }),
        "error",
        5000,
      );
    } finally {
      setSaving(false);
    }
  };

  // Per-mimeType reader block over the original served bytes (#13594). A
  // transcript-backed record renders the word-synced player; plain media
  // renders by kind; a text/pdf record has no inline media block (its prose /
  // paged text renders below). Full-screen wraps the same block in an overlay.
  let mediaBlock: ReactNode = null;
  if (doc) {
    if (readerKind === "transcript") {
      mediaBlock = transcript ? (
        <PagePanel variant="inset" className="p-4">
          <TranscriptPlayer
            transcript={transcript}
            audioUrl={mediaUrl || undefined}
            initialSeekMs={initialSeekMs}
          />
        </PagePanel>
      ) : mediaUrl ? (
        // biome-ignore lint/a11y/useMediaCaption: the searchable text copy below is the caption.
        <audio
          data-testid="reader-audio"
          controls
          src={mediaUrl}
          className="w-full"
        />
      ) : null;
    } else if (readerKind === "image" && mediaUrl) {
      mediaBlock = (
        <Button
          type="button"
          data-testid="reader-image"
          onClick={() => setFullscreen(true)}
          variant="mediaZoom"
          size="content"
          className="mx-auto"
        >
          <img
            src={mediaUrl}
            alt={doc.filename}
            className="max-h-[28rem] w-auto object-contain"
          />
        </Button>
      );
    } else if (readerKind === "audio" && mediaUrl) {
      mediaBlock = (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded audio carries no caption track.
        <audio
          data-testid="reader-audio"
          controls
          src={mediaUrl}
          className="w-full"
        />
      );
    } else if (readerKind === "video" && mediaUrl) {
      mediaBlock = (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded video carries no caption track.
        <video
          data-testid="reader-video"
          controls
          src={mediaUrl}
          className="max-h-[28rem] w-full rounded-sm bg-black"
        />
      );
    } else if (readerKind === "pdf" && mediaUrl) {
      mediaBlock = (
        <iframe
          data-testid="reader-pdf"
          src={mediaUrl}
          title={doc.filename}
          // Sandbox the embedded document: allow it to be treated as same-origin
          // so the native viewer's resources load, but grant no script/forms/etc.
          // Matches the chat PdfTile (MessageAttachments.tsx) — served bytes are
          // not guaranteed to be a real PDF.
          sandbox="allow-same-origin"
          className="h-[32rem] w-full rounded-sm border border-border/40 bg-white"
        />
      );
    }
  }

  const hasDocumentActions = Boolean(
    doc &&
      ((mediaUrl && readerKind !== "transcript") ||
        servedFileUrl ||
        doc.canEditText),
  );
  const documentMeta = doc
    ? [
        getDocumentSourceLabel(doc.source, t),
        scopeLabel,
        formatByteSize(doc.fileSize),
        doc.fragmentCount === 1
          ? t("documentsview.FragmentCountOne", {
              defaultValue: "1 fragment",
            })
          : t("documentsview.FragmentCountMany", {
              defaultValue: "{{count}} fragments",
              count: doc.fragmentCount,
            }),
        documentCreatedLabel,
      ].filter((value): value is string => Boolean(value))
    : [];

  return (
    <PagePanel className="settings-surface flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="custom-scrollbar eliza-chat-scroll min-h-0 flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div
            role="status"
            aria-label={t("appsview.Loading")}
            className="rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)] p-5"
          >
            <DetailSkeleton />
          </div>
        ) : null}

        {error ? (
          <div className="rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)]">
            <PagePanel.ContentState
              state="error"
              placement="inset"
              tone="warning"
              icon={<AlertTriangle className="size-5" />}
              title={error.title}
              description={error.description}
              action={
                error.retryable ? (
                  <Button
                    variant="outline"
                    size="touch"
                    onClick={() => setReloadToken((current) => current + 1)}
                  >
                    {t("common.retry")}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        {!loading && !error && !doc ? (
          <div className="rounded-[16px] border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)]">
            <PagePanel.ContentState
              state="empty"
              placement="inset"
              title={t("documentsview.NoDocumentSelected", {
                defaultValue: "No document selected",
              })}
              description={t("documentsview.NoDocumentSelectedDesc", {
                defaultValue: "Choose an item from the library.",
              })}
            />
          </div>
        ) : null}

        {!loading && !error && doc ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <SettingsGroup
              title={t("documentsview.Document", { defaultValue: "Document" })}
            >
              <div
                data-slot="settings-row"
                className="flex min-h-20 items-center gap-3 px-5 py-4"
              >
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--settings-fill)] text-accent"
                >
                  <FileText className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-[17px] font-semibold leading-6 text-[color:var(--settings-foreground)]">
                    {doc.filename}
                  </h2>
                  <p className="mt-0.5 text-[13px] leading-5 text-[color:var(--settings-muted)]">
                    {documentMeta.join(" · ")}
                  </p>
                </div>
              </div>

              {hasDocumentActions ? (
                <div
                  data-slot="settings-row"
                  className="flex min-h-14 flex-wrap items-center gap-2 px-4 py-2"
                >
                  {mediaUrl && readerKind !== "transcript" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="document-fullscreen"
                      aria-pressed={fullscreen}
                      onClick={() => setFullscreen((current) => !current)}
                    >
                      {fullscreen ? (
                        <Minimize2 className="size-4" aria-hidden />
                      ) : (
                        <Maximize2 className="size-4" aria-hidden />
                      )}
                      {fullscreen
                        ? t("documentsview.ExitFullScreen", {
                            defaultValue: "Exit full screen",
                          })
                        : t("documentsview.FullScreen", {
                            defaultValue: "Full screen",
                          })}
                    </Button>
                  ) : null}
                  {servedFileUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="document-download"
                      onClick={() => void handleDownloadFile()}
                    >
                      <Download className="size-4" aria-hidden />
                      {t("documentsview.Download", {
                        defaultValue: "Download",
                      })}
                    </Button>
                  ) : null}
                  {servedFileUrl && shareSupported ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="document-share"
                      onClick={() => void handleShareFile()}
                    >
                      <Share2 className="size-4" aria-hidden />
                      {t("documentsview.Share", {
                        defaultValue: "Share",
                      })}
                    </Button>
                  ) : null}
                  {doc.canEditText ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing((current) => !current)}
                        disabled={saving}
                      >
                        <Pencil className="size-4" aria-hidden />
                        {editing
                          ? t("common.cancel", { defaultValue: "Cancel" })
                          : t("documentsview.EditText", {
                              defaultValue: "Edit text",
                            })}
                      </Button>
                      {editing ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleSave()}
                          disabled={saving || draftText.trim().length === 0}
                        >
                          <Save className="size-4" aria-hidden />
                          {saving
                            ? t("common.saving", { defaultValue: "Saving…" })
                            : t("common.save", { defaultValue: "Save" })}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </SettingsGroup>

            <DocumentAccessPanel documentId={doc.id} />
            <DocumentPinsPanel documentId={doc.id} />

            {mediaBlock ? (
              <SettingsGroup
                title={t("documentsview.Preview", { defaultValue: "Preview" })}
              >
                <div data-testid="reader-media" className="p-4">
                  {mediaBlock}
                </div>
              </SettingsGroup>
            ) : null}

            {transcript?.source === "meeting" && !transcript.redacted ? (
              <ArtifactPrivacyControls
                transcript={transcript}
                onUpdate={handleUpdateTranscriptPrivacy}
                onDeleteSourceAudio={() =>
                  void handleDeleteTranscriptSourceAudio()
                }
                saving={privacySaving}
                error={privacyError}
              />
            ) : null}

            {readerKind === "transcript" && transcript ? null : (
              <SettingsGroup
                title={t("documentsview.Content", { defaultValue: "Content" })}
              >
                <div className="p-5">
                  {editing ? (
                    <Textarea
                      value={draftText}
                      rows={16}
                      onChange={(event) => setDraftText(event.target.value)}
                      variant="documentEditor"
                      density="tall"
                    />
                  ) : readableText ? (
                    <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[color:var(--settings-foreground)]">
                      {readableText}
                    </div>
                  ) : (
                    <PagePanel.ContentState
                      state="empty"
                      placement="inset"
                      title={t("documentsview.NoPreview", {
                        defaultValue: "No preview available",
                      })}
                    />
                  )}
                </div>
              </SettingsGroup>
            )}
          </div>
        ) : null}
      </div>

      {fullscreen && mediaBlock ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; the "Exit full screen" button + Escape-equivalent Close button below are the keyboard paths.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the semantic close button is the keyboard path; backdrop click is a pointer convenience.
        <div
          data-testid="reader-fullscreen"
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4 sm:p-8"
          onClick={() => setFullscreen(false)}
        >
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="reader-fullscreen-close"
              onClick={(event) => {
                event.stopPropagation();
                setFullscreen(false);
              }}
            >
              <Minimize2 className="mr-1.5 size-4" aria-hidden />
              {t("documentsview.ExitFullScreen", {
                defaultValue: "Exit full screen",
              })}
            </Button>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop close when interacting with the media itself. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: this container only cancels backdrop pointer clicks; it is not an action target. */}
          <div
            className="flex min-h-0 flex-1 items-center justify-center"
            onClick={(event) => event.stopPropagation()}
          >
            {mediaBlock}
          </div>
        </div>
      ) : null}
    </PagePanel>
  );
}
