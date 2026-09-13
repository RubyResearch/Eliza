/**
 * The folded Knowledge multimedia hub (#13594): one surface over every ingested
 * knowledge record — documents, images, audio, video, and transcript mirrors —
 * instead of the old three views (Knowledge + Transcripts + Files). A top-bar
 * media-format facet control and a scope filter narrow a single-column list; a
 * row opens the record in a pushed reader sub-view (its own header, back → list)
 * that renders per-mimeType (prose / pdf / image / word-synced or plain audio /
 * video) via {@link DocumentViewer}.
 *
 * Reads/writes through the `client` documents API, seeds from `resource-cache`
 * for instant revisits, and binds the floating chat composer as its search box
 * via `useRegisterViewChatBinding`. Records flow in from the slice-1 ingest
 * pipeline (#13593) tagged by room/sender/role/media-format; there is no second
 * store (#8876) — format is derived from mime at read time. Rendered by
 * `KnowledgeView` (the `/documents` route) and, controlled, inside the character
 * hub. Upload compresses large images before sending.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  client,
  type DocumentRecord,
  type DocumentScope,
  type DocumentSearchResult,
  isApiError,
} from "@elizaos/ui/api";
import {
  Button,
  FormSelect,
  FormSelectItem,
  Input,
} from "@elizaos/ui/components";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { SettingsGroup } from "@elizaos/ui/components/composites/settings";
import { ConfirmDeleteControl } from "@elizaos/ui/components/shared/confirm-delete-control";
import { SectionTabStrip } from "@elizaos/ui/components/shared/SectionNav";
import { ViewHeader } from "@elizaos/ui/components/shared/ViewHeader";
import { getCached, setCached } from "@elizaos/ui/hooks/resource-cache";
import {
  isCapabilityWarmupAbort,
  useAbortableCapabilityWarmup,
} from "@elizaos/ui/hooks/runtime-capability-retry";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
import { isNative } from "@elizaos/ui/platform";
import {
  useAppSelector,
  useRegisterViewChatBinding,
  useTranslation,
} from "@elizaos/ui/state";
import {
  confirmDesktopAction,
  formatByteSize,
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "@elizaos/ui/utils";
import {
  AlertTriangle,
  ChevronRight,
  FileSearch,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DocumentViewer } from "./documents-detail";
import { getDocumentSummary } from "./documents-detail.helpers";
import {
  BULK_UPLOAD_TARGET_BYTES,
  DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  DOCUMENT_UPLOAD_ACCEPT,
  type DocumentUploadFile,
  type DocumentUploadOptions,
  getDocumentUploadFilename,
  isSupportedDocumentFile,
  LARGE_FILE_WARNING_BYTES,
  MAX_BULK_REQUEST_DOCUMENTS,
  MAX_UPLOAD_REQUEST_BYTES,
  shouldReadDocumentFileAsText,
} from "./documents-upload.helpers";
import {
  documentMatchesFacet,
  documentMediaFormat,
  KNOWLEDGE_FACETS,
  type KnowledgeFacet,
  knowledgeFacetCounts,
  knowledgeFacetIcon,
  knowledgeFacetLabel,
} from "./knowledge-media-format";

export type { DocumentUploadFile } from "./documents-upload.helpers";

type DocumentScopeFilter = "all" | DocumentScope;

const SCOPE_FILTER_OPTIONS: ReadonlyArray<{
  value: DocumentScopeFilter;
  labelKey: string;
  defaultLabel: string;
}> = [
  {
    value: "all",
    labelKey: "documentsview.ScopeAll",
    defaultLabel: "All knowledge",
  },
  {
    value: "global",
    labelKey: "documentsview.ScopeGlobal",
    defaultLabel: "Shared",
  },
  {
    value: "owner-private",
    labelKey: "documentsview.ScopeOwner",
    defaultLabel: "Owner",
  },
  {
    value: "user-private",
    labelKey: "documentsview.ScopeUser",
    defaultLabel: "Private",
  },
  {
    value: "agent-private",
    labelKey: "documentsview.ScopeAgent",
    defaultLabel: "Agent",
  },
];

type KnowledgeLoadIssue = {
  title: string;
  description: string;
  retryable: boolean;
};

function knowledgeLoadIssue(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): KnowledgeLoadIssue {
  if (isApiError(error)) {
    if (error.status === 401 || error.status === 403) {
      return {
        title: t("documentsview.AccessUnavailableTitle", {
          defaultValue: "Knowledge isn't available",
        }),
        description: t("documentsview.AccessUnavailableHint", {
          defaultValue: "This account can't access this knowledge library.",
        }),
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        title: t("documentsview.ServiceUnavailableTitle", {
          defaultValue: "Knowledge unavailable",
        }),
        description: t("documentsview.ServiceUnavailable", {
          defaultValue: "This agent doesn't expose a Knowledge library yet.",
        }),
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        title: t("documentsview.ServiceBusyTitle", {
          defaultValue: "Knowledge is busy",
        }),
        description: t("documentsview.ServiceBusyHint", {
          defaultValue: "Wait a moment, then try again.",
        }),
        retryable: true,
      };
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return {
        title: t("documentsview.ServiceOfflineTitle", {
          defaultValue: "Knowledge is temporarily unavailable",
        }),
        description: t("documentsview.ServiceOfflineHint", {
          defaultValue: "Reconnect to Eliza, then try again.",
        }),
        retryable: true,
      };
    }
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    error instanceof TypeError ||
    /failed to fetch|network|offline|disconnected|connection/.test(message)
  ) {
    return {
      title: t("documentsview.ServiceOfflineTitle", {
        defaultValue: "Knowledge is offline",
      }),
      description: t("documentsview.ServiceOfflineHint", {
        defaultValue: "Reconnect to Eliza to see your library.",
      }),
      retryable: true,
    };
  }

  return {
    title: t("documentsview.FailedToLoadTitle", {
      defaultValue: "Knowledge couldn't load",
    }),
    description: t("documentsview.FailedToLoadHint", {
      defaultValue: "Try again. If this keeps happening, reconnect your agent.",
    }),
    retryable: true,
  };
}

/* ── Search Result Item ─────────────────────────────────────────────── */

const SearchResultListItem = memo(function SearchResultListItem({
  result,
  onSelect,
}: {
  result: DocumentSearchResult;
  onSelect: (documentId: string, startMs?: number) => void;
}) {
  const { t } = useTranslation();
  const documentId = result.documentId || result.id;
  const title =
    result.documentTitle ||
    t("documentsview.UnknownDocument", {
      defaultValue: "Unknown Document",
    });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `result-${result.id}`,
    role: "list-item",
    label: title,
    group: "documents-results",
    description: `Open search result "${title}"`,
    onActivate: () => onSelect(documentId, result.startMs),
  });

  return (
    <Button
      ref={ref}
      {...agentProps}
      onClick={() => onSelect(documentId, result.startMs)}
      variant="sectionToggle"
      size="row"
      align="start"
      data-slot="settings-row"
      className="group"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--settings-fill)] text-xs font-semibold text-[color:var(--settings-muted)]">
        {(result.similarity * 100).toFixed(0)}%
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium leading-6 text-[color:var(--settings-foreground)]">
          {title}
        </div>
        <div className="line-clamp-2 text-[13px] leading-5 text-[color:var(--settings-muted)]">
          {result.text}
        </div>
      </div>
      <ChevronRight
        className="size-4 shrink-0 text-[color:var(--settings-muted)]"
        aria-hidden
      />
    </Button>
  );
});

/* ── Knowledge Row ──────────────────────────────────────────────────── */

const KnowledgeListItem = memo(function KnowledgeListItem({
  doc,
  onSelect,
  onDelete,
  deleting,
}: {
  doc: DocumentRecord;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  // Row leading icon follows the media format so the list reads as mixed media
  // at a glance (audio/video/image/transcript are distinct from a plain doc).
  const FormatIcon = knowledgeFacetIcon(documentMediaFormat(doc));
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `document-${doc.id}`,
    role: "list-item",
    label: doc.filename,
    group: "documents-list",
    description: `Open "${doc.filename}"`,
    onActivate: () => onSelect(doc.id),
  });
  return (
    <div
      data-slot="settings-row"
      className="group relative flex min-h-16 w-full items-stretch"
    >
      <Button
        ref={ref}
        {...agentProps}
        onClick={() => onSelect(doc.id)}
        aria-label={t("documentsview.OpenDocument", {
          defaultValue: "Open {{filename}}",
          filename: doc.filename,
        })}
        title={doc.filename}
        variant="sectionToggle"
        size="row"
        align="start"
        className="min-w-0 flex-1"
      >
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--settings-fill)] text-accent"
        >
          <FormatIcon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium leading-6 text-[color:var(--settings-foreground)]">
            {doc.filename}
          </div>
          <div className="truncate text-[13px] leading-5 text-[color:var(--settings-muted)]">
            {getDocumentSummary(doc, t)}
          </div>
        </div>
        <ChevronRight
          className="size-4 shrink-0 text-[color:var(--settings-muted)]"
          aria-hidden
        />
      </Button>
      {doc.canDelete ? (
        <span className="flex shrink-0 items-center gap-1 bg-[var(--settings-panel)] px-2">
          <ConfirmDeleteControl
            triggerLabel={<Trash2 className="size-4" aria-hidden />}
            triggerTitle={t("documentsview.DeleteDocument", {
              defaultValue: "Delete {{filename}}",
              filename: doc.filename,
            })}
            triggerVariant="ghost"
            triggerClassName="size-11 rounded-[10px] !bg-transparent p-0 text-[color:var(--settings-muted)] transition-colors hover:!bg-danger/10 hover:text-danger"
            confirmClassName="h-9 rounded-[10px] border border-danger/25 bg-danger/12 px-3 text-xs font-semibold text-danger transition-colors hover:bg-danger/18"
            cancelClassName="h-9 rounded-[10px] border border-[color:var(--settings-border)] bg-[var(--settings-secondary)] px-3 text-xs font-semibold text-[color:var(--settings-foreground)] transition-colors hover:bg-[var(--settings-fill-strong)]"
            promptClassName="sr-only"
            disabled={deleting}
            busyLabel="..."
            onConfirm={() => onDelete(doc.id)}
          />
        </span>
      ) : null}
    </div>
  );
});

/* ── Main hub component ─────────────────────────────────────────────── */

interface KnowledgeDocumentsViewProps {
  fileInputId?: string;
  inModal?: boolean;
  /** Own the top-level "Knowledge" header in list state (the canonical
   *  `/character/documents` route). Off when embedded under other chrome. */
  standalone?: boolean;
  onDocumentsChange?: (documents: DocumentRecord[]) => void;
  onSelectedDocumentIdChange?: (documentId: string | null) => void;
  selectedDocumentId?: string | null;
}

export function KnowledgeDocumentsView(
  props: KnowledgeDocumentsViewProps = {},
) {
  const authority = useActiveAgentAuthority();
  return (
    <KnowledgeDocumentsViewForAuthority
      key={authority}
      {...props}
      authority={authority}
    />
  );
}

function KnowledgeDocumentsViewForAuthority({
  fileInputId,
  inModal,
  standalone = false,
  onDocumentsChange,
  onSelectedDocumentIdChange,
  selectedDocumentId,
  authority,
}: KnowledgeDocumentsViewProps & { authority: string }) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const chatSending = useAppSelector((s) => s.chatSending);
  const wasChatSending = useRef(chatSending);
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const runCapabilityWarmup = useAbortableCapabilityWarmup();
  const tRef = useRef(t);
  tRef.current = t;
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<DocumentScopeFilter>("all");
  const [facet, setFacet] = useState<KnowledgeFacet>("all");
  // The active view drives the one floating chat composer as its search box:
  // each keystroke flows in via onQuery, filtering documents in place.
  const handleSearchQuery = useCallback((value: string) => {
    setSearchQuery(value);
    // Clearing the draft drops out of any live search-results view.
    setSearchResults((prev) => (prev !== null ? null : prev));
  }, []);
  const searchBinding = useMemo(
    () => ({
      placeholder: t("documents.ui.searchPlaceholder"),
      onQuery: handleSearchQuery,
    }),
    [t, handleSearchQuery],
  );
  useRegisterViewChatBinding(searchBinding);
  // Seed from the shared cache so a revisit paints the last-known documents
  // instantly and revalidates silently, instead of flashing a spinner. Keyed by
  // scope AND facet (#13594): the server now draws the list per facet from the
  // whole store, so each facet's page is cached independently.
  const cacheNamespace = `documents:${authority}`;
  const documentsCacheKey = `${cacheNamespace}:list:${scopeFilter}:${facet}`;
  const cachedDocuments = getCached<DocumentRecord[]>(documentsCacheKey);
  const [documents, setDocuments] = useState<DocumentRecord[]>(
    cachedDocuments?.data ?? [],
  );
  // Whole-store per-facet counts for the segmented control (#13594). Fetched
  // server-side so a facet is never missing/miscounted once its records fall
  // outside the list page (the review blocker); seeded from the local slice as
  // a first-paint estimate, then overwritten by the server truth.
  const [serverFacetCounts, setServerFacetCounts] = useState<Record<
    KnowledgeFacet,
    number
  > | null>(
    getCached<Record<KnowledgeFacet, number>>(
      `${cacheNamespace}:facets:${scopeFilter}`,
    )?.data ?? null,
  );
  // Mirror the latest server counts into a ref so loadData (a stable callback)
  // can tell "never had server counts" from "have stale server counts" without
  // re-binding on every count change.
  const serverFacetCountsRef = useRef(serverFacetCounts);
  serverFacetCountsRef.current = serverFacetCounts;
  // True when the segmented control is showing first-page-derived counts
  // because the whole-store count fetch failed and no server truth exists yet
  // (codex P2). Rendered as an approximate marker so the numbers aren't passed
  // off as authoritative.
  const [facetCountsApproximate, setFacetCountsApproximate] = useState(false);
  // Counts are scope-specific: on a scope change, drop the previous scope's
  // server counts and reseed from THAT scope's cache (or null) so a subsequent
  // count-fetch failure can never leave the control showing another scope's
  // stale counts as authoritative (codex P2). Skips the first render since the
  // initial state already seeded from the mount scope's cache.
  const previousScopeRef = useRef(`${authority}:${scopeFilter}`);
  useEffect(() => {
    const scopeAuthority = `${authority}:${scopeFilter}`;
    if (previousScopeRef.current === scopeAuthority) return;
    previousScopeRef.current = scopeAuthority;
    const cached = getCached<Record<KnowledgeFacet, number>>(
      `${cacheNamespace}:facets:${scopeFilter}`,
    )?.data;
    setServerFacetCounts(cached ?? null);
    setFacetCountsApproximate(false);
  }, [authority, cacheNamespace, scopeFilter]);
  const [searchResults, setSearchResults] = useState<
    DocumentSearchResult[] | null
  >(null);
  const [loading, setLoading] = useState(!cachedDocuments);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [internalSelectedDocId, setInternalSelectedDocId] = useState<
    string | null
  >(null);
  const [selectedAnchor, setSelectedAnchor] = useState<
    { documentId: string; startMs: number } | undefined
  >();
  const [loadIssue, setLoadIssue] = useState<KnowledgeLoadIssue | null>(null);
  // Set only when a native mobile agent omits the documents route. Web and
  // desktop treat the same 404 as a service failure because Knowledge is a
  // supported surface there.
  const [documentsUnavailable, setDocumentsUnavailable] = useState<
    "device" | "runtime" | null
  >(null);
  const [isServiceLoading, setIsServiceLoading] = useState(false);
  const serviceRetryRef = useRef(0);
  const selectedDocId = selectedDocumentId ?? internalSelectedDocId;
  const selectedSeekMs =
    selectedAnchor?.documentId === selectedDocId
      ? selectedAnchor.startMs
      : undefined;
  const setSelectedDocId = useCallback(
    (documentId: string | null, initialSeekMs?: number) => {
      setSelectedAnchor(
        documentId !== null && initialSeekMs !== undefined
          ? { documentId, startMs: initialSeekMs }
          : undefined,
      );
      if (selectedDocumentId === undefined) {
        setInternalSelectedDocId(documentId);
      }
      onSelectedDocumentIdChange?.(documentId);
    },
    [onSelectedDocumentIdChange, selectedDocumentId],
  );

  const loadData = useCallback(
    async (options?: { silent?: boolean }) => {
      let lifecycleAborted = false;
      if (!options?.silent) setLoading(true);
      setLoadIssue(null);
      try {
        const scopeParam = scopeFilter !== "all" ? { scope: scopeFilter } : {};
        // Drive the list off the server facet so its rows come from the whole
        // store, not the client's first page (#13594 review blocker). The
        // facet-count fetch runs in parallel and describes the whole store
        // under the current scope, so counts stay correct across pages.
        const facetParam = facet !== "all" ? { knowledgeFacet: facet } : {};
        const loadDocuments = () =>
          client.listDocuments({
            limit: 100,
            ...scopeParam,
            ...facetParam,
          });
        const loadFacetCounts = () => client.getDocumentFacetCounts(scopeParam);
        // Native exposes a stable route table, so it gets one cancellable
        // attempt; web/desktop retain the bounded deferred-startup warm-up.
        const warmupOptions = isNative ? { delaysMs: [] } : undefined;
        const [docsRes, facetsRes] = await Promise.all([
          runCapabilityWarmup(loadDocuments, warmupOptions),
          runCapabilityWarmup(loadFacetCounts, warmupOptions).catch((error) => {
            if (isCapabilityWarmupAbort(error)) throw error;
            return null;
          }),
        ]);
        if (authorityRef.current !== authority) return;
        setDocuments(docsRes.documents);
        setCached(documentsCacheKey, docsRes.documents);
        if (facetsRes?.counts) {
          setServerFacetCounts(facetsRes.counts);
          setFacetCountsApproximate(false);
          setCached(
            `${cacheNamespace}:facets:${scopeFilter}`,
            facetsRes.counts,
          );
        } else {
          // The whole-store count fetch failed while the list succeeded
          // (codex P2). Rather than silently pass off first-page counts as the
          // truth, mark them approximate so the segmented control can flag it;
          // any prior server counts stay on screen (never reset to null).
          setFacetCountsApproximate(serverFacetCountsRef.current === null);
        }
        // Only surface the WHOLE list to an embedder's shared cache (e.g.
        // CharacterHubView). When a facet is active the rows are server-filtered
        // to that facet, so publishing them would overwrite the embedder's full
        // list with a partial one (codex P2). The `all` facet holds the whole
        // store, so the embedder stays whole across facet switches.
        if (facet === "all") {
          onDocumentsChange?.(docsRes.documents);
        }
        setIsServiceLoading(false);
        setDocumentsUnavailable(null);
        serviceRetryRef.current = 0;
      } catch (err) {
        if (authorityRef.current !== authority) return;
        if (isCapabilityWarmupAbort(err)) {
          lifecycleAborted = true;
          return;
        }
        // error-policy:J4 — native mobile intentionally omits the documents
        // route, so only that platform gets the device-unavailable state.
        if (isApiError(err) && err.code === "documents_runtime_unavailable") {
          setIsServiceLoading(false);
          setDocumentsUnavailable("runtime");
          return;
        }
        if (isApiError(err) && err.status === 404 && isNative) {
          setIsServiceLoading(false);
          setDocumentsUnavailable("device");
          return;
        }
        setDocumentsUnavailable(null);
        const status = (err as { status?: number }).status;
        if (status === 503) {
          setIsServiceLoading(true);
        } else {
          setIsServiceLoading(false);
          setLoadIssue(knowledgeLoadIssue(err, tRef.current));
        }
      } finally {
        if (!lifecycleAborted && authorityRef.current === authority) {
          setLoading(false);
        }
      }
    },
    [
      authority,
      cacheNamespace,
      documentsCacheKey,
      facet,
      onDocumentsChange,
      runCapabilityWarmup,
      scopeFilter,
    ],
  );

  useEffect(() => {
    setDocuments(getCached<DocumentRecord[]>(documentsCacheKey)?.data ?? []);
    setSearchResults(null);
    setInternalSelectedDocId(null);
    setSelectedAnchor(undefined);
    setLoadIssue(null);
    setDocumentsUnavailable(null);
    setIsServiceLoading(false);
    serviceRetryRef.current = 0;
  }, [documentsCacheKey]);

  useEffect(() => {
    // Revalidate silently when cached documents are already on screen.
    loadData({
      silent: getCached<DocumentRecord[]>(documentsCacheKey) != null,
    }).catch(() => {
      setLoading(false);
    });
  }, [documentsCacheKey, loadData]);
  // Agent document actions write through the runtime store, outside this view.
  // Revalidate after an overlay turn so their effects appear without a reload.
  useEffect(() => {
    const completed = wasChatSending.current && !chatSending;
    wasChatSending.current = chatSending;
    if (completed) void loadData({ silent: true });
  }, [chatSending, loadData]);

  useEffect(() => {
    if (!isServiceLoading) {
      serviceRetryRef.current = 0;
      return;
    }
    const attempt = serviceRetryRef.current;
    if (attempt >= 5) {
      setIsServiceLoading(false);
      setLoadIssue({
        title: t("documentsview.ServiceOfflineTitle", {
          defaultValue: "Knowledge is temporarily unavailable",
        }),
        description: t("documentsview.ServiceDidNotBecomeAvailable", {
          defaultValue: "Reconnect to Eliza, then try again.",
        }),
        retryable: true,
      });
      return;
    }
    const delayMs = 2000 * 1.5 ** attempt; // 2s, 3s, 4.5s, 6.75s, ~10s
    const timer = setTimeout(() => {
      serviceRetryRef.current = attempt + 1;
      loadData();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [isServiceLoading, loadData, t]);

  const readDocumentFile = useCallback(
    async (file: DocumentUploadFile) => {
      const reader = new FileReader();
      return new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") {
            resolve(result);
            return;
          }

          if (result instanceof ArrayBuffer) {
            const bytes = new Uint8Array(result);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            resolve(btoa(binary));
            return;
          }

          reject(
            new Error(
              t("documentsview.FailedToReadFile", {
                defaultValue: "Failed to read file",
              }),
            ),
          );
        };

        reader.onerror = () => reject(reader.error);

        if (shouldReadDocumentFileAsText(file)) {
          reader.readAsText(file);
        } else {
          reader.readAsArrayBuffer(file);
        }
      });
    },
    [t],
  );

  const buildDocumentUploadRequest = useCallback(
    async (file: DocumentUploadFile, options: DocumentUploadOptions) => {
      const optimizedImage = await maybeCompressDocumentUploadImage(file);
      const uploadFile = optimizedImage.file as DocumentUploadFile;
      if (
        isDocumentImageFile(uploadFile) &&
        uploadFile.size > MAX_DOCUMENT_IMAGE_PROCESSING_BYTES
      ) {
        throw new Error(
          t("documentsview.ImageCouldNotBeCompressed", {
            defaultValue:
              "Image could not be compressed below {{limit}} for processing.",
            limit: formatByteSize(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES),
          }),
        );
      }

      const uploadFilename = getDocumentUploadFilename(uploadFile);
      const content = await readDocumentFile(uploadFile);

      const request = {
        content,
        filename: uploadFilename,
        contentType: uploadFile.type || "application/octet-stream",
        scope: options.scope,
        metadata: {
          includeImageDescriptions: options.includeImageDescriptions,
          relativePath: uploadFile.webkitRelativePath || undefined,
        },
      };
      const requestBytes = new TextEncoder().encode(
        JSON.stringify(request),
      ).length;
      if (requestBytes > MAX_UPLOAD_REQUEST_BYTES) {
        throw new Error(
          t("documentsview.UploadPayloadExceedsLimit", {
            defaultValue:
              "Upload payload is {{size}}, which exceeds the current limit ({{limit}}).",
            size: formatByteSize(requestBytes),
            limit: formatByteSize(MAX_UPLOAD_REQUEST_BYTES),
          }),
        );
      }

      return {
        filename: uploadFilename,
        request,
        requestBytes,
      };
    },
    [readDocumentFile, t],
  );

  const handleFilesUpload = useCallback(
    async (files: DocumentUploadFile[], options: DocumentUploadOptions) => {
      const unsupportedFiles = files.filter(
        (file) => !isSupportedDocumentFile(file),
      );
      const uploadQueue = files.filter(
        (file) => file.size > 0 && isSupportedDocumentFile(file),
      );
      if (uploadQueue.length === 0) {
        setActionNotice(
          unsupportedFiles.length > 0
            ? t("documentsview.NoSupportedNonEmptyFiles", {
                defaultValue: "No supported non-empty files were selected.",
              })
            : t("documentsview.NoNonEmptyFiles", {
                defaultValue: "No non-empty files were selected.",
              }),
          "info",
          3000,
        );
        return;
      }

      const largeFiles = uploadQueue.filter(
        (file) => file.size >= LARGE_FILE_WARNING_BYTES,
      );
      if (largeFiles.length > 0) {
        const shouldContinue =
          typeof window === "undefined"
            ? true
            : await confirmDesktopAction({
                title: t("documentsview.UploadLargeFiles", {
                  defaultValue: "Upload Large Files",
                }),
                message: t("documentsview.LargeFilesDetected", {
                  defaultValue: "{{count}} large file(s) detected.",
                  count: largeFiles.length,
                }),
                detail: t("documentsview.UploadLargeFilesDetail", {
                  defaultValue:
                    "Uploading can take longer and may increase embedding or vision costs.",
                }),
                confirmLabel: t("common.continue", {
                  defaultValue: "Continue",
                }),
                cancelLabel: t("common.cancel", {
                  defaultValue: "Cancel",
                }),
                type: "warning",
              });
        if (!shouldContinue) return;
      }

      const failures: string[] = [];
      const warnings: string[] = [];
      let successful = 0;

      const normalizeUploadError = (err: unknown): string => {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownUploadError", {
                defaultValue: "Unknown upload error",
              });
        const status = (err as Error & { status?: number })?.status;
        return status === 413 || /maximum size|payload is/i.test(message)
          ? t("documentsview.UploadTooLarge", {
              defaultValue: "Upload too large. Try splitting this file.",
            })
          : message;
      };

      setUploading(true);

      try {
        type PreparedUpload = {
          filename: string;
          request: {
            content: string;
            filename: string;
            contentType: string;
            scope: DocumentScope;
            metadata: {
              includeImageDescriptions: boolean;
              relativePath: string | undefined;
            };
          };
          requestBytes: number;
        };

        let currentBatch: PreparedUpload[] = [];
        let currentBatchBytes = 0;

        const flushBatch = async () => {
          if (currentBatch.length === 0) return;

          const batchToUpload = currentBatch;
          currentBatch = [];
          currentBatchBytes = 0;

          try {
            const result = await client.uploadDocumentsBulk({
              documents: batchToUpload.map((item) => item.request),
            });

            for (const item of result.results) {
              const batchItem = batchToUpload[item.index];
              const filename =
                item.filename ||
                batchItem?.filename ||
                t("documentsview.Document", {
                  defaultValue: "document",
                });
              if (item.ok) {
                successful += 1;
                if (item.warnings?.[0]) {
                  warnings.push(`${filename}: ${item.warnings[0]}`);
                }
              } else {
                failures.push(
                  `${filename}: ${
                    item.error ||
                    t("documentsview.UploadFailed", {
                      defaultValue: "Upload failed",
                    })
                  }`,
                );
              }
            }
          } catch (err) {
            const message = normalizeUploadError(err);
            for (const batchItem of batchToUpload) {
              failures.push(`${batchItem.filename}: ${message}`);
            }
          }
        };

        for (const file of uploadQueue) {
          const uploadFilename = getDocumentUploadFilename(file);
          try {
            const prepared = await buildDocumentUploadRequest(file, options);
            if (
              currentBatch.length > 0 &&
              (currentBatchBytes + prepared.requestBytes >
                BULK_UPLOAD_TARGET_BYTES ||
                currentBatch.length >= MAX_BULK_REQUEST_DOCUMENTS)
            ) {
              await flushBatch();
            }
            currentBatch.push(prepared);
            currentBatchBytes += prepared.requestBytes;
          } catch (err) {
            failures.push(`${uploadFilename}: ${normalizeUploadError(err)}`);
          }
        }

        await flushBatch();

        let refreshFailed = false;
        try {
          await loadData();
        } catch {
          refreshFailed = true;
        }

        const skippedSummary =
          unsupportedFiles.length > 0
            ? ` Skipped ${unsupportedFiles.length} unsupported file(s).`
            : "";
        const refreshSummary = refreshFailed
          ? " Uploaded, but failed to refresh document list."
          : "";

        if (
          uploadQueue.length === 1 &&
          successful === 1 &&
          failures.length === 0
        ) {
          const onlyFile = getDocumentUploadFilename(uploadQueue[0]);
          const baseMessage = `Uploaded "${onlyFile}"`;
          if (warnings.length > 0) {
            setActionNotice(`${baseMessage}. ${warnings[0]}`, "info", 6000);
          } else if (refreshFailed) {
            setActionNotice(
              `${baseMessage}. Uploaded, but failed to refresh document list.`,
              "info",
              6000,
            );
          } else {
            setActionNotice(baseMessage, "success", 3000);
          }
          return;
        }

        if (failures.length === 0) {
          setActionNotice(
            `Uploaded ${successful}/${uploadQueue.length} files.${warnings.length > 0 ? ` ${warnings[0]}` : ""}${skippedSummary}${refreshSummary}`,
            warnings.length > 0 || refreshFailed || unsupportedFiles.length > 0
              ? "info"
              : "success",
            7000,
          );
          return;
        }

        setActionNotice(
          `Uploaded ${successful}/${uploadQueue.length} files. ${failures.length} failed.${failures.length > 0 ? ` ${failures[0]}` : ""}${skippedSummary}${refreshSummary}`,
          successful > 0 ? "info" : "error",
          7000,
        );
      } finally {
        setUploading(false);
      }
    },
    [buildDocumentUploadRequest, loadData, setActionNotice, t],
  );

  const handleExternalFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && !uploading) {
        void handleFilesUpload(Array.from(files) as DocumentUploadFile[], {
          includeImageDescriptions: true,
          scope: DEFAULT_DOCUMENT_UPLOAD_SCOPE,
        });
      }
      event.target.value = "";
    },
    [handleFilesUpload, uploading],
  );

  // Root-level file-drop intake (#10722): accepting file drops on the whole
  // view root is the hub's only drag-drop upload affordance — no CTA cluster,
  // just quiet intake. The keyboard-accessible path is the "Add" file input.
  const handleRootDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const handleRootDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // preventDefault BEFORE the uploading gate: dragover advertised
      // droppability, so bailing without it hands the drop to the browser
      // default — navigating the SPA to the local file.
      event.preventDefault();
      if (uploading) return;
      void handleFilesUpload(Array.from(files) as DocumentUploadFile[], {
        includeImageDescriptions: true,
        scope: DEFAULT_DOCUMENT_UPLOAD_SCOPE,
      });
    },
    [handleFilesUpload, uploading],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      try {
        const result = await client.searchDocuments(query, {
          threshold: 0.3,
          limit: 20,
          ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
          ...(facet !== "all" ? { knowledgeFacet: facet } : {}),
        });
        // A runtime without semantic embeddings can legitimately return no
        // ranked hits. Preserve the immediate filename/type filter in that
        // case so search stays useful instead of replacing a visible local
        // match with a misleading empty state.
        return result.results.length > 0 ? result.results : null;
      } catch {
        // error-policy:J4 semantic search is an enrichment. The local
        // filename/type filter remains authoritative and needs no alarm.
        return null;
      }
    },
    [facet, scopeFilter],
  );

  const handleDelete = useCallback(
    async (documentId: string) => {
      setDeleting(documentId);

      try {
        const result = await client.deleteDocument(documentId);

        if (result.ok) {
          setActionNotice(
            t("documentsview.DeletedDocument", {
              defaultValue: "Deleted document ({{count}} fragments removed)",
              count: result.deletedFragments,
            }),
            "success",
            3000,
          );
          if (selectedDocId === documentId) setSelectedDocId(null);
          await loadData();
        } else {
          setActionNotice(
            t("documentsview.FailedToDeleteDocument", {
              defaultValue: "Failed to delete document",
            }),
            "error",
            4000,
          );
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownDeleteError", {
                defaultValue: "Unknown delete error",
              });
        setActionNotice(
          t("documentsview.FailedToDeleteDocumentWithMessage", {
            defaultValue: "Failed to delete document: {{message}}",
            message,
          }),
          "error",
          5000,
        );
      } finally {
        setDeleting(null);
      }
    },
    [loadData, selectedDocId, setActionNotice, setSelectedDocId, t],
  );

  const isShowingSearchResults = searchResults !== null;
  const hasSearchQuery = searchQuery.trim().length > 0;
  const visibleSearchResults = searchResults ?? [];
  // The segmented control shows the whole-store counts the server returns; the
  // local slice is only a first-paint estimate until they arrive (#13594). When
  // a facet is active the list is already narrowed server-side, so the local
  // slice can't recount the other facets — the server counts are the truth.
  const localFacetCounts = useMemo(
    () => knowledgeFacetCounts(documents),
    [documents],
  );
  const facetCounts = serverFacetCounts ?? localFacetCounts;
  // Only the fall-through-to-local case is approximate; once server counts land
  // they're exact and the marker drops.
  const facetCountsAreApproximate =
    facetCountsApproximate && serverFacetCounts === null;
  // Facet + free-text narrowing over the plain list (semantic search results
  // are cross-format by relevance, so the facet control hides while they show).
  const filteredDocuments = useMemo(() => {
    // The facet is applied server-side now (#13594): `documents` already holds
    // the whole-store rows for the active facet, so only the instant free-text
    // narrowing runs here. `documentMatchesFacet` stays a cheap belt-and-braces
    // guard so a stale cached slice from another facet can't leak through on
    // first paint before the revalidation lands.
    const query = searchQuery.trim().toLowerCase();
    return documents.filter((doc) => {
      if (!documentMatchesFacet(doc, facet)) return false;
      if (!query) return true;
      return (
        doc.filename.toLowerCase().includes(query) ||
        doc.contentType?.toLowerCase().includes(query)
      );
    });
  }, [documents, facet, searchQuery]);

  // Reader-as-pushed-sub-view: a selected id replaces the list with the reader
  // rather than a side pane (#13594). Persisting a selection across an empty
  // list would strand the user in a reader for a deleted item, so clear it.
  useEffect(() => {
    if (
      selectedDocId &&
      documents.length > 0 &&
      !documents.some((doc) => doc.id === selectedDocId)
    ) {
      setSelectedDocId(null);
    }
  }, [documents, selectedDocId, setSelectedDocId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults(null);
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void handleSearch(query).then((results) => {
        // Ignore a slower response from an older draft or filter. The local
        // filename filter already reflects the latest input immediately.
        if (active) setSearchResults(results);
      });
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [handleSearch, searchQuery]);

  const visibleFacets = KNOWLEDGE_FACETS.filter(
    (value) => value === "all" || value === facet || facetCounts[value] > 0,
  );
  const facetStrip = (
    <SectionTabStrip
      testId="knowledge-facets"
      agentIdPrefix="facet"
      ariaLabel={t("knowledgehub.facetsLabel", {
        defaultValue: "Filter knowledge by media type",
      })}
      activeId={facet}
      onSelect={(id) => setFacet(id as KnowledgeFacet)}
      className="!gap-0.5 !px-0 !py-0"
      entries={visibleFacets.map((value) => {
        const Icon = knowledgeFacetIcon(value);
        return {
          id: value,
          agentLabel: knowledgeFacetLabel(value, t),
          label: (
            <span
              className="inline-flex items-center gap-1.5"
              data-testid={`knowledge-facet-${value}`}
            >
              <Icon className="size-3.5" aria-hidden />
              {knowledgeFacetLabel(value, t)}
              <span
                className="text-muted"
                title={
                  facetCountsAreApproximate
                    ? t("knowledgehub.approxCountHint", {
                        defaultValue:
                          "Approximate. Whole-store counts are unavailable.",
                      })
                    : undefined
                }
              >
                {facetCountsAreApproximate ? "~" : ""}
                {facetCounts[value]}
              </span>
            </span>
          ),
        };
      })}
    />
  );

  const showScopeFilter =
    scopeFilter !== "all" ||
    documents.some((doc) => doc.scope && doc.scope !== "global");
  const scopeControl = showScopeFilter ? (
    <FormSelect
      aria-label={t("knowledgehub.scopeLabel", {
        defaultValue: "Filter knowledge by access",
      })}
      value={scopeFilter}
      onValueChange={(value) => setScopeFilter(value as DocumentScopeFilter)}
      triggerClassName="h-10 w-[9.5rem] rounded-[10px] border-[color:var(--settings-border)] bg-[var(--settings-secondary)] px-3 text-[13px] text-[color:var(--settings-foreground)]"
      contentClassName="min-w-52 [&_[data-radix-select-viewport]]:min-w-full [&_[data-radix-select-viewport]]:max-w-none"
    >
      {SCOPE_FILTER_OPTIONS.map(({ value, labelKey, defaultLabel }) => (
        <FormSelectItem key={value} value={value}>
          {t(labelKey, { defaultValue: defaultLabel })}
        </FormSelectItem>
      ))}
    </FormSelect>
  ) : null;

  const hiddenFileInput = fileInputId ? (
    <Input
      id={fileInputId}
      type="file"
      className="hidden"
      multiple
      accept={DOCUMENT_UPLOAD_ACCEPT}
      onChange={handleExternalFileInputChange}
    />
  ) : null;

  let listBody: ReactNode;
  if (documentsUnavailable) {
    listBody = null;
  } else if (isServiceLoading) {
    listBody = (
      <PagePanel.ContentState
        state="loading"
        placement="panel"
        heading={t("documentsview.DocumentServiceIs", {
          defaultValue: "Preparing Knowledge",
        })}
        description={t("documentsview.DocumentServiceIsHint", {
          defaultValue: "Connecting to your library.",
        })}
      />
    );
  } else if (loadIssue) {
    listBody = (
      <PagePanel.ContentState
        state="error"
        placement="inset"
        icon={<AlertTriangle className="size-5" />}
        tone="warning"
        title={loadIssue.title}
        description={loadIssue.description}
        action={
          loadIssue.retryable ? (
            <Button variant="outline" size="touch" onClick={() => loadData()}>
              {t("common.retry")}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (isShowingSearchResults) {
    listBody =
      visibleSearchResults.length === 0 ? (
        <PagePanel.Empty
          variant="inset"
          className="min-h-[12rem] px-0 py-8"
          description={t("documentsview.SearchTips", {
            defaultValue:
              "Try a filename, topic, or phrase from the document body.",
          })}
          title={t("documentsview.NoResultsFound")}
        />
      ) : (
        visibleSearchResults.map((result) => (
          <SearchResultListItem
            key={result.id}
            result={result}
            onSelect={setSelectedDocId}
          />
        ))
      );
  } else if (loading && documents.length === 0) {
    listBody = (
      <PagePanel.Loading
        heading={t("common.loading", { defaultValue: "Loading…" })}
        aria-label="Loading Knowledge"
      />
    );
  } else if (documents.length === 0 && facet !== "all") {
    // Facet-empty (#13594): the list is server-filtered to this facet, so an
    // empty page here means "no items of THIS media type" — not an empty
    // store. Showing the global "No knowledge yet" would be misleading when
    // other facets are populated, so render a per-facet no-matches state.
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-10"
        title={t("knowledgehub.facetEmptyTitle", {
          defaultValue: "No {{facet}} here",
          facet: knowledgeFacetLabel(facet, t).toLowerCase(),
        })}
        description={t("knowledgehub.facetEmptyHint", {
          defaultValue: "Choose another type, or add a file.",
        })}
      />
    );
  } else if (documents.length === 0) {
    // Calm designed-empty (#13594): no recommendation chips — the agent
    // proposes next steps in chat. Quiet drag-drop/paste + the "Add" input
    // remain the only intake.
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-10"
        title={t("documentsview.NoDocumentsYet", {
          defaultValue: "No knowledge yet",
        })}
        description={t("knowledgehub.emptyHint", {
          defaultValue: "Drop a file here, or ask Eliza to save something.",
        })}
      />
    );
  } else if (filteredDocuments.length === 0) {
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-8"
        description={t("documentsview.SearchTips", {
          defaultValue:
            "Try a filename, topic, or phrase from the document body.",
        })}
        title={t("documentsview.NoMatchingDocuments", {
          defaultValue: "No matching items",
        })}
      />
    );
  } else {
    listBody = filteredDocuments.map((doc) => (
      <KnowledgeListItem
        key={doc.id}
        doc={doc}
        onSelect={setSelectedDocId}
        onDelete={handleDelete}
        deleting={deleting === doc.id}
      />
    ));
  }

  // The reader replaces the list entirely (pushed sub-view). Its own back
  // control returns to the list; the shell/character-hub header stays above.
  if (selectedDocId) {
    return (
      <div
        className={`flex min-h-0 flex-1 flex-col ${inModal ? "min-h-0" : ""}`}
        data-testid="documents-view"
      >
        <ViewHeader
          title={t("knowledgehub.readerTitle", { defaultValue: "Knowledge" })}
          onBack={() => setSelectedDocId(null)}
          backLabel={t("knowledgehub.backToList", {
            defaultValue: "Back to Knowledge",
          })}
          className="px-0"
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <DocumentViewer
            documentId={selectedDocId}
            initialSeekMs={selectedSeekMs}
            onUpdated={() => {
              void loadData();
            }}
          />
        </div>
      </div>
    );
  }

  const addControl =
    fileInputId && !documentsUnavailable && !loadIssue && !hasSearchQuery ? (
      <label
        htmlFor={fileInputId}
        data-testid="knowledge-add"
        className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted-strong transition-colors hover:text-txt-strong ${
          uploading ? "pointer-events-none opacity-60" : ""
        }`}
      >
        <Plus className="size-4" aria-hidden />
        {uploading
          ? t("documentsview.Uploading", { defaultValue: "Uploading" })
          : t("common.add", { defaultValue: "Add" })}
      </label>
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file-drop target only; the keyboard-accessible upload path is the "Add" file input.
    <div
      className={`settings-surface flex min-h-0 flex-1 flex-col gap-4 ${inModal ? "min-h-0" : ""}`}
      data-testid="documents-view"
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {standalone ? (
        <ViewHeader
          title={t("knowledgehub.title", { defaultValue: "Knowledge" })}
          className="px-0"
        />
      ) : null}
      {hiddenFileInput}
      <div className="custom-scrollbar eliza-chat-scroll min-h-0 flex-1 overflow-y-auto pb-4 pt-4">
        <SettingsGroup
          title={
            hasSearchQuery
              ? t("documentsview.SearchResults", {
                  defaultValue: "Search results",
                })
              : t("knowledgehub.library", { defaultValue: "Library" })
          }
          action={addControl}
        >
          {!documentsUnavailable &&
          !loadIssue &&
          !hasSearchQuery &&
          (visibleFacets.length > 1 || showScopeFilter) ? (
            <div
              data-slot="settings-row"
              className="flex min-h-14 w-full items-center justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1 overflow-hidden">{facetStrip}</div>
              {scopeControl}
            </div>
          ) : null}
          {documentsUnavailable === "device" && !isServiceLoading ? (
            <PagePanel.ContentState
              state="empty"
              placement="inset"
              icon={<FileSearch className="size-5" />}
              title={t("documentsview.DocumentsUnavailableHereTitle", {
                defaultValue: "Knowledge isn't on this device",
              })}
              description={t("documentsview.DocumentsUnavailableHere", {
                defaultValue: "Open the web or desktop app to manage it.",
              })}
            />
          ) : null}
          {documentsUnavailable === "runtime" && !isServiceLoading ? (
            <div data-testid="knowledge-runtime-unavailable">
              <PagePanel.ContentState
                state="empty"
                placement="inset"
                icon={<FileSearch className="size-5" />}
                title={t("documentsview.DedicatedRuntimeRequired", {
                  defaultValue: "Knowledge needs a Dedicated agent",
                })}
                description={t("documentsview.DedicatedRuntimeRequiredHint", {
                  defaultValue:
                    "Connect a Dedicated agent to add and search files.",
                })}
              />
            </div>
          ) : null}
          {listBody}
        </SettingsGroup>
      </div>
    </div>
  );
}
