/**
 * REST route handlers for the document store: list, stats, semantic/keyword
 * search, single fetch, fragment listing, single + bulk upload, URL/YouTube
 * ingestion, and delete. Persistence and search are delegated to the runtime
 * document service (resolved from `@elizaos/agent/api/documents-service-loader`);
 * this module handles HTTP shaping and access-control scoping only.
 */

import {
  actorCanManageAgentDocuments,
  actorCanManageOwnerDocuments,
  asRecord,
  asUuid,
  type DocumentReadableMemory,
  documentMediaFormat,
  documentTags,
  matchesDocumentFilter as matchesSharedDocumentFilter,
  parseDocumentScope,
  type RouteActor,
  type RouteActorRole,
  routeActorAddedByRole,
  type DocumentFilter as SharedDocumentFilter,
  trimString,
} from "@elizaos/agent/api/document-access";
import type {
  AccessContext,
  AgentRuntime,
  IFileStorageService,
  Memory,
  RouteHelpers,
  RouteRequestContext,
  UUID,
} from "@elizaos/core";
import {
  __setDocumentUrlFetchImplForTests,
  actorFromAccessContext,
  ElizaError,
  fetchDocumentFromUrl,
  isYouTubeUrl,
  normalizeDocumentContentType,
  ServiceType,
} from "@elizaos/core";
import { parseClampedFloat, parsePositiveInteger } from "@elizaos/shared";
import {
  getDocumentContentType,
  getDocumentDeleteability,
  getDocumentEditability,
  getDocumentProvenance,
  getDocumentTitleFromMetadata,
  presentDocument,
} from "./document-presenter.js";
import {
  type DocumentAddedFrom,
  type DocumentSearchMode,
  type DocumentsServiceLike,
  type DocumentVisibilityScope,
  getDocumentsService,
} from "./service-loader.js";

export type DocumentRouteHelpers = RouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
  accessContext?: AccessContext;
  decodePathComponent?: (
    raw: string,
    res: DocumentRouteContext["res"],
    label: string,
  ) => string | null;
}

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";
const DOCUMENT_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;
const DOCUMENT_CONTENT_TYPE_VALIDATION_ERROR =
  "contentType must be a valid non-empty MIME type string when provided";
const MIME_ESSENCE_PATTERN =
  /^[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]*\/[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]*$/;

function isUuidValue(value: unknown): value is UUID {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function documentGrantErrorStatus(cause: ElizaError): number {
  if (
    cause.code === "DOCUMENT_NOT_FOUND" ||
    cause.code === "DOCUMENT_GRANT_TARGET_NOT_FOUND"
  ) {
    return 404;
  }
  if (cause.code === "DOCUMENT_GRANT_MUTATION_FORBIDDEN") return 403;
  if (cause.code === "DOCUMENT_DIRECT_GRANTS_INVALID") return 400;
  if (cause.code === "DOCUMENT_GRANT_MUTATION_CONFLICT") return 409;
  return 500;
}

type DocumentFilter = SharedDocumentFilter & {
  /**
   * Hub display facet (#13594): the coarse client-facing bucket the Knowledge
   * hub's segmented control filters by: all | doc | image | audio | video |
   * transcript. Unlike {@link mediaFormat} (an exact fine-grained match), `doc`
   * groups the pdf/text/file document subtypes, so the hub's facet rows and
   * counts come from the whole readable store, not just the first page.
   */
  knowledgeFacet?: KnowledgeHubFacet;
};

/** The Knowledge hub's coarse display facets (#13594); `all` is the no-op. */
type KnowledgeHubFacet =
  | "all"
  | "doc"
  | "image"
  | "audio"
  | "video"
  | "transcript";

const KNOWLEDGE_HUB_FACETS: readonly KnowledgeHubFacet[] = [
  "all",
  "doc",
  "image",
  "audio",
  "video",
  "transcript",
];

function parseKnowledgeFacet(
  value: string | null,
): KnowledgeHubFacet | undefined {
  const normalized = trimString(value)?.toLowerCase();
  if (!normalized) return undefined;
  return (KNOWLEDGE_HUB_FACETS as readonly string[]).includes(normalized)
    ? (normalized as KnowledgeHubFacet)
    : undefined;
}
type DocumentUploadBody = {
  audience?: unknown;
  content: string;
  filename: string;
  contentType?: unknown;
  metadata?: Record<string, unknown>;
  roomId?: unknown;
  worldId?: unknown;
  entityId?: string;
  scope?: string;
  scopedToEntityId?: string;
  addedFrom?: string;
};

type ValidatedDocumentContentType = {
  essence: string;
  original: string;
};

type DocumentUploadLocation = {
  roomId: UUID;
  worldId: UUID;
};

type DocumentUploadLocationResult =
  | { ok: true; value: DocumentUploadLocation }
  | { ok: false; status: number; error: string };

function validateDocumentContentType(
  contentType: unknown,
):
  | { ok: true; value: ValidatedDocumentContentType }
  | { ok: false; error: string } {
  if (contentType === undefined) {
    return {
      ok: true,
      value: { essence: "text/plain", original: "text/plain" },
    };
  }
  if (typeof contentType !== "string") {
    return { ok: false, error: DOCUMENT_CONTENT_TYPE_VALIDATION_ERROR };
  }

  const essence = normalizeDocumentContentType(contentType);
  if (!MIME_ESSENCE_PATTERN.test(essence)) {
    return { ok: false, error: DOCUMENT_CONTENT_TYPE_VALIDATION_ERROR };
  }

  return { ok: true, value: { essence, original: contentType } };
}

function isTextBackedContentType(contentType: string): boolean {
  // This selects the upload wire encoding, not every MIME type that can contain
  // text. Existing callers base64-encode all non-text types outside this legacy
  // set, so widening it would persist the encoded string instead of the bytes.
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript"
  );
}

function hasTextBackedFilename(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return [".md", ".mdx", ".txt", ".json", ".xml", ".csv", ".tsv"].some(
    (extension) => lowerFilename.endsWith(extension),
  );
}

function getOwnerEntityId(runtime: AgentRuntime | null): UUID | undefined {
  if (!runtime || typeof runtime.getSetting !== "function") return undefined;
  return asUuid(runtime.getSetting("ELIZA_ADMIN_ENTITY_ID"));
}

export function resolveRouteActor(
  agentId: UUID,
  ownerEntityId?: UUID,
  accessContext?: AccessContext,
): RouteActor | null {
  if (!accessContext?.requesterEntityId) return null;

  // Delegate the RoleName -> RouteActorRole mapping to core rather than
  // restating it. The local version collapsed everything that was not
  // OWNER/ADMIN into USER, which silently dropped AGENT: a request the agent
  // makes about itself (requesterEntityId === agentId) came back as USER, so
  // actorCanManageAgentDocuments — which grants on OWNER/AGENT/RUNTIME — could
  // never be satisfied and the agent lost access to its own agent-private
  // documents. actorFromAccessContext is the single definition of that mapping.
  const scopeActor = actorFromAccessContext(accessContext, agentId);
  // Preserve every explicit role. An unresolved role is not a lower role and
  // cannot be translated into authorization, so reject it.
  if (scopeActor.role === "UNRESOLVED") return null;
  const role: RouteActorRole = scopeActor.role;
  return {
    entityId: scopeActor.entityId,
    role,
    ownerEntityId,
  };
}

class DocumentsSearchModeError extends Error {
  constructor(message = "Invalid searchMode") {
    super(message);
    this.name = "DocumentsSearchModeError";
  }
}

function parseSearchMode(value: unknown): DocumentSearchMode | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value === "hybrid" || value === "vector" || value === "keyword") {
    return value;
  }
  throw new DocumentsSearchModeError();
}

function parseTimestampParam(value: unknown): number | undefined {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTagsFromSearchParams(searchParams: URLSearchParams): string[] {
  const values = [
    ...searchParams.getAll("tag"),
    ...searchParams.getAll("tags"),
  ];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is string => value.length > 0);
}

function filtersFromSearchParams(
  url: URL,
  options: { includeTextQuery?: boolean } = {},
): DocumentFilter {
  const scope = parseDocumentScope(url.searchParams.get("scope"));
  const scopedToEntityId = asUuid(url.searchParams.get("scopedToEntityId"));
  const query = options.includeTextQuery
    ? (trimString(url.searchParams.get("q")) ??
      trimString(url.searchParams.get("query")) ??
      trimString(url.searchParams.get("text")))
    : (trimString(url.searchParams.get("query")) ??
      trimString(url.searchParams.get("text")));
  const addedBy = asUuid(url.searchParams.get("addedBy"));
  const timeRangeStart = parseTimestampParam(
    url.searchParams.get("timeRangeStart") ??
      url.searchParams.get("from") ??
      url.searchParams.get("start"),
  );
  const timeRangeEnd = parseTimestampParam(
    url.searchParams.get("timeRangeEnd") ??
      url.searchParams.get("to") ??
      url.searchParams.get("end"),
  );
  const tags = parseTagsFromSearchParams(url.searchParams);
  const roomId = asUuid(url.searchParams.get("roomId"));
  const mediaFormat = trimString(
    url.searchParams.get("mediaFormat") ?? url.searchParams.get("format"),
  )?.toLowerCase();
  const knowledgeFacet = parseKnowledgeFacet(
    url.searchParams.get("knowledgeFacet") ?? url.searchParams.get("facet"),
  );
  return {
    ...(scope ? { scope } : {}),
    ...(scopedToEntityId ? { scopedToEntityId } : {}),
    ...(query ? { query } : {}),
    ...(addedBy ? { addedBy } : {}),
    ...(typeof timeRangeStart === "number" ? { timeRangeStart } : {}),
    ...(typeof timeRangeEnd === "number" ? { timeRangeEnd } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(roomId ? { roomId } : {}),
    ...(mediaFormat ? { mediaFormat } : {}),
    ...(knowledgeFacet ? { knowledgeFacet } : {}),
  };
}

function filtersFromUploadBody(
  body: {
    metadata?: Record<string, unknown>;
    scope?: string;
    scopedToEntityId?: string;
  },
  actor: RouteActor,
): { scope: DocumentVisibilityScope; scopedToEntityId?: UUID; error?: string } {
  if (actor.role === "GUEST") {
    return {
      scope: "user-private",
      error: "Guests cannot upload documents.",
    };
  }
  const metadata = asRecord(body.metadata);
  const scope =
    parseDocumentScope(body.scope) ??
    parseDocumentScope(metadata?.scope) ??
    (actor.role === "USER"
      ? "user-private"
      : actor.role === "AGENT"
        ? "agent-private"
        : "global");

  const scopedToEntityId =
    asUuid(body.scopedToEntityId) ?? asUuid(metadata?.scopedToEntityId);

  if (scope === "global" || scope === "owner-private") {
    if (!actorCanManageOwnerDocuments(actor)) {
      return {
        scope,
        error: "Only the owner can write global or owner-private documents.",
      };
    }
    return { scope };
  }

  if (scope === "agent-private") {
    if (!actorCanManageAgentDocuments(actor)) {
      return {
        scope,
        error:
          "Only the owner or agent runtime can write agent-private documents.",
      };
    }
    return { scope, scopedToEntityId: scopedToEntityId ?? actor.entityId };
  }

  const targetEntityId = scopedToEntityId ?? actor.entityId;
  if (actor.role === "USER" && targetEntityId !== actor.entityId) {
    return {
      scope,
      scopedToEntityId: targetEntityId,
      error: "Users can only write documents to their own private scope.",
    };
  }

  return { scope, scopedToEntityId: targetEntityId };
}

function hasUuidId(memory: Memory): memory is Memory & { id: UUID } {
  return typeof memory.id === "string" && memory.id.length > 0;
}

function hasUuidIdAndCreatedAt(
  memory: Memory,
): memory is Memory & { id: UUID; createdAt: number } {
  return hasUuidId(memory) && typeof memory.createdAt === "number";
}

function isDocumentMemory(memory: Memory, agentId: UUID): boolean {
  if (memory.agentId && memory.agentId !== agentId) return false;
  const metadata = asRecord(memory.metadata);
  return (
    metadata?.type === "document" ||
    metadata?.type === "custom" ||
    (typeof metadata?.documentId === "string" &&
      metadata.documentId === memory.id)
  );
}

function matchesDocumentFilter(
  memory: DocumentReadableMemory,
  filters: DocumentFilter,
): boolean {
  if (!matchesSharedDocumentFilter(memory, filters)) return false;

  const metadata = asRecord(memory.metadata);
  if (
    !filters.knowledgeFacet ||
    filters.knowledgeFacet === "all" ||
    documentHubFacet(metadata, documentTags(metadata)) ===
      filters.knowledgeFacet
  ) {
    return true;
  }

  return false;
}

/**
 * Coarse Knowledge-hub facet for a record (#13594). Collapses the fine
 * media-format vocabulary into the hub's display buckets: image/audio/video and
 * transcript pass through; pdf/text/file (and any non-media document) group as
 * `doc`. Falls back to the record's mime type when the format tag is absent, so
 * legacy/un-backfilled records still bucket correctly and the whole store is
 * counted — not just the tagged first page. Transcript-backed records
 * (`transcriptId`) are always the `transcript` bucket, mirroring the client.
 */
function documentHubFacet(
  metadata: Record<string, unknown> | undefined,
  tags: string[],
): Exclude<KnowledgeHubFacet, "all"> {
  if (trimString(metadata?.transcriptId)) return "transcript";
  const format = documentMediaFormat(metadata, tags);
  switch (format) {
    case "image":
    case "audio":
    case "video":
    case "transcript":
      return format;
    case "pdf":
    case "text":
    case "file":
      return "doc";
    default:
      break;
  }
  const mime = getDocumentContentType(metadata).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "doc";
}
function buildRouteMessage({
  agentId,
  text,
  filters,
  actor,
}: {
  agentId: UUID;
  text: string;
  filters?: DocumentFilter;
  actor: RouteActor;
}): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: actor.entityId,
    agentId,
    roomId: agentId,
    worldId: agentId,
    content: { text },
    metadata: {
      ...(filters?.scope ? { scope: filters.scope } : {}),
      ...(filters?.scopedToEntityId
        ? { scopedToEntityId: filters.scopedToEntityId }
        : {}),
    },
    createdAt: Date.now(),
  };
}

function serviceSearchScope(
  filters: DocumentFilter,
): { entityId?: UUID; roomId?: UUID } | undefined {
  // Push room scoping into the service BEFORE ranking/capping so a room-filtered
  // search isn't starved by higher-ranked matches from other rooms filling the
  // capped result set (the service filters on the document memory's roomId,
  // which the attachment-ingest writer sets to the source room). scopedToEntityId
  // continues to narrow to a user's private space.
  const scope: { entityId?: UUID; roomId?: UUID } = {};
  if (filters.scopedToEntityId) scope.entityId = filters.scopedToEntityId;
  if (filters.roomId) scope.roomId = filters.roomId;
  return scope.entityId || scope.roomId ? scope : undefined;
}

function decodeMatchedPathComponent(
  ctx: DocumentRouteContext,
  raw: string,
  label: string,
): string | null {
  if (ctx.decodePathComponent) {
    return ctx.decodePathComponent(raw, ctx.res, label);
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    ctx.error(ctx.res, `Invalid ${label}: malformed URL encoding`, 400);
    return null;
  }
}

async function listDocumentMemories({
  documentsService,
  agentId,
  accessContext,
  filters,
  limit,
  offset,
}: {
  documentsService: DocumentsServiceLike;
  agentId: UUID;
  accessContext: AccessContext;
  filters: DocumentFilter;
  limit: number;
  offset: number;
}): Promise<{ documents: Memory[]; total: number }> {
  if (!documentsService.listAllDocumentsWithAccessContext) {
    throw new Error("Canonical document listing is unavailable");
  }
  const matching = (
    await documentsService.listAllDocumentsWithAccessContext(accessContext)
  ).filter(
    (memory) =>
      isDocumentMemory(memory, agentId) &&
      matchesDocumentFilter(memory, filters),
  );
  return {
    documents: matching.slice(offset, offset + limit),
    total: matching.length,
  };
}

/**
 * Per-facet counts for the Knowledge hub (#13594), computed over the WHOLE
 * readable store in one scan — not a page slice — so the hub's segmented control
 * shows true totals and no facet goes missing/miscounted once its records fall
 * outside the first page (the review blocker). Honors every filter EXCEPT the
 * hub facet itself (so the counts describe what each facet would show under the
 * current scope/room/tag/search narrowing).
 */
async function countDocumentFacets({
  documentsService,
  agentId,
  accessContext,
  filters,
}: {
  documentsService: DocumentsServiceLike;
  agentId: UUID;
  accessContext: AccessContext;
  filters: DocumentFilter;
}): Promise<Record<KnowledgeHubFacet, number>> {
  const counts: Record<KnowledgeHubFacet, number> = {
    all: 0,
    doc: 0,
    image: 0,
    audio: 0,
    video: 0,
    transcript: 0,
  };
  // Drop the hub facet so the scan sees every bucket; keep the rest of the
  // narrowing (scope/room/tag/search) so counts match the visible list.
  const { knowledgeFacet: _ignored, ...baseFilters } = filters;
  if (!documentsService.listAllDocumentsWithAccessContext) {
    throw new Error("Canonical document listing is unavailable");
  }
  const authorized =
    await documentsService.listAllDocumentsWithAccessContext(accessContext);
  for (const memory of authorized) {
    if (
      !isDocumentMemory(memory, agentId) ||
      !matchesDocumentFilter(memory, baseFilters)
    ) {
      continue;
    }
    const metadata = asRecord(memory.metadata);
    const documentTags = Array.isArray(metadata?.tags)
      ? metadata.tags.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    counts[documentHubFacet(metadata, documentTags)] += 1;
    counts.all += 1;
  }

  return counts;
}

export const __setDocumentFetchImplForTests = __setDocumentUrlFetchImplForTests;

export async function handleDocumentsRoutes(
  ctx: DocumentRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    runtime,
    json,
    error,
    readJsonBody,
  } = ctx;

  if (!pathname.startsWith("/api/documents")) return false;

  if (!runtime?.agentId) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }
  const agentId = runtime.agentId as UUID;
  const ownerEntityId = getOwnerEntityId(runtime);
  const accessContext = ctx.accessContext;
  if (!accessContext) {
    error(res, "Authentication required", 401);
    return true;
  }
  const routeActor = resolveRouteActor(agentId, ownerEntityId, accessContext);

  if (!routeActor) {
    error(res, "Authentication required", 401);
    return true;
  }

  const { service: documentsService, reason } =
    await getDocumentsService(runtime);
  if (!documentsService) {
    if (reason === "timeout") {
      res.setHeader("Retry-After", "5");
      error(
        res,
        "Documents service is still loading. Please retry shortly.",
        503,
      );
    } else {
      error(
        res,
        "Documents service is not available. Agent may not be running.",
        503,
      );
    }
    return true;
  }
  // Preserve the runtime guard across the nested async location resolver.
  const uploadLocationRuntime = runtime;
  const uploadLocationActor = routeActor;

  async function resolveUploadLocation(input: {
    roomId?: unknown;
    worldId?: unknown;
  }): Promise<DocumentUploadLocationResult> {
    const roomWasProvided = input.roomId !== undefined;
    const worldWasProvided = input.worldId !== undefined;

    if (!roomWasProvided && !worldWasProvided) {
      return { ok: true, value: { roomId: agentId, worldId: agentId } };
    }
    if (!roomWasProvided) {
      return {
        ok: false,
        status: 400,
        error: "worldId requires a roomId so tenant scope can be verified",
      };
    }
    if (!isUuidValue(input.roomId)) {
      return { ok: false, status: 400, error: "roomId must be a valid UUID" };
    }
    let requestedWorldId: UUID | undefined;
    if (worldWasProvided) {
      if (!isUuidValue(input.worldId)) {
        return {
          ok: false,
          status: 400,
          error: "worldId must be a valid UUID",
        };
      }
      requestedWorldId = input.worldId.trim() as UUID;
    }

    const roomId = input.roomId.trim() as UUID;
    let room: Awaited<ReturnType<AgentRuntime["getRoom"]>>;
    try {
      room = await uploadLocationRuntime.getRoom(roomId);
    } catch (cause) {
      // error-policy:J1 The HTTP boundary reports canonical-room lookup failure as unavailable.
      uploadLocationRuntime.reportError("documents.upload-location", cause, {
        roomId,
      });
      return {
        ok: false,
        status: 503,
        error: "Document room lookup is unavailable",
      };
    }
    if (!room) {
      return { ok: false, status: 400, error: "roomId does not exist" };
    }
    if (!room.worldId) {
      uploadLocationRuntime.reportError(
        "documents.upload-location",
        new Error("Canonical document room has no worldId"),
        { roomId },
      );
      return {
        ok: false,
        status: 503,
        error: "Document room tenant scope is unavailable",
      };
    }

    const worldId = room.worldId as UUID;
    if (requestedWorldId && requestedWorldId !== worldId) {
      return {
        ok: false,
        status: 403,
        error: "worldId does not match the canonical room tenant",
      };
    }
    if (
      uploadLocationActor.role !== "OWNER" &&
      uploadLocationActor.role !== "RUNTIME" &&
      ctx.accessContext?.worldId !== worldId
    ) {
      return {
        ok: false,
        status: 403,
        error: "Requester is not authorized for the room tenant",
      };
    }

    return { ok: true, value: { roomId, worldId } };
  }

  if (method === "GET" && pathname === "/api/documents/stats") {
    if (
      !actorCanManageOwnerDocuments(routeActor) &&
      !actorCanManageAgentDocuments(routeActor)
    ) {
      error(res, "Forbidden: insufficient permissions for document stats", 403);
      return true;
    }
    const documentCount = await documentsService.countMemories({
      tableName: DOCUMENTS_TABLE,
      unique: false,
    });
    const fragmentCount = await documentsService.countMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      unique: false,
    });

    json(res, {
      documentCount,
      fragmentCount,
      agentId,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents/facets") {
    // Whole-store facet counts for the Knowledge hub segmented control
    // (#13594). The facet param itself is dropped inside countDocumentFacets so
    // every bucket is counted; the remaining scope/room/tag/search filters are
    // honored so the counts describe the current narrowing.
    const filters = filtersFromSearchParams(url, { includeTextQuery: true });
    if (!documentsService.listAllDocumentsWithAccessContext) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const counts = await countDocumentFacets({
      documentsService,
      agentId,
      accessContext,
      filters,
    });
    json(res, {
      ok: true,
      available: true,
      agentId,
      counts,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const filters = filtersFromSearchParams(url, { includeTextQuery: true });

    if (
      !documentsService.listAllDocumentsWithAccessContext ||
      !documentsService.listDocumentFragmentsWithAccessContext
    ) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const listAuthorizedFragments =
      documentsService.listDocumentFragmentsWithAccessContext.bind(
        documentsService,
      );

    const { documents, total } = await listDocumentMemories({
      documentsService,
      agentId,
      accessContext,
      filters,
      limit,
      offset,
    });
    const fragmentCountEntries = await Promise.all(
      documents
        .filter(hasUuidId)
        .map(
          async (doc) =>
            [
              doc.id,
              (await listAuthorizedFragments(doc.id, accessContext)).length,
            ] as const,
        ),
    );
    const fragmentCounts = new Map(fragmentCountEntries);
    const cleanedDocuments = documents.map((doc) =>
      presentDocument(
        doc,
        hasUuidId(doc) ? (fragmentCounts.get(doc.id) ?? 0) : 0,
      ),
    );

    json(res, {
      ok: true,
      available: true,
      agentId,
      documents: cleanedDocuments,
      total,
      limit,
      offset: offset > 0 ? offset : 0,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents/search") {
    const query = url.searchParams.get("q");
    if (!query?.trim()) {
      error(res, "Search query (q) is required");
      return true;
    }

    const threshold = parseClampedFloat(url.searchParams.get("threshold"), {
      fallback: 0.3,
      min: 0,
      max: 1,
    });
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);
    const filters = filtersFromSearchParams(url);
    const requestedSearchMode = url.searchParams.getAll("searchMode");
    if (requestedSearchMode.length > 1) {
      error(res, "Invalid searchMode", 400);
      return true;
    }
    let searchMode: DocumentSearchMode | undefined;
    try {
      searchMode = parseSearchMode(requestedSearchMode[0] ?? null);
      // error-policy:J1 invalid query values become an HTTP 400 response.
    } catch (searchModeError) {
      if (searchModeError instanceof DocumentsSearchModeError) {
        error(res, searchModeError.message, 400);
        return true;
      }
      throw searchModeError;
    }
    const searchMessage = buildRouteMessage({
      agentId,
      text: query.trim(),
      filters,
      actor: routeActor,
    });

    const results = await documentsService.searchDocuments(
      searchMessage,
      serviceSearchScope(filters),
      searchMode,
      accessContext,
    );

    const filteredResults = results
      .filter((result) => (result.similarity ?? 0) >= threshold)
      .filter((result) => matchesDocumentFilter(result, filters))
      .slice(0, limit)
      .map((result) => {
        const meta = asRecord(result.metadata);
        return {
          id: result.id,
          text: result.content.text || "",
          similarity: result.similarity,
          documentId: meta?.documentId,
          documentTitle: getDocumentTitleFromMetadata(
            meta,
            result.content.text,
          ),
          documentProvenance: meta ? getDocumentProvenance(meta) : undefined,
          position: meta?.position,
          transcriptId:
            typeof meta?.transcriptId === "string"
              ? meta.transcriptId
              : undefined,
          startMs: typeof meta?.startMs === "number" ? meta.startMs : undefined,
          endMs: typeof meta?.endMs === "number" ? meta.endMs : undefined,
        };
      });

    json(res, {
      query: query.trim(),
      threshold,
      results: filteredResults,
      count: filteredResults.length,
    });
    return true;
  }

  const fragmentsMatch = /^\/api\/documents\/([^/]+)\/fragments$/.exec(
    pathname,
  );
  if (method === "GET" && fragmentsMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      fragmentsMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    if (
      !documentsService.getDocumentByIdWithAccessContext ||
      !documentsService.listDocumentFragmentsWithAccessContext
    ) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const document = await documentsService.getDocumentByIdWithAccessContext(
      documentId,
      accessContext,
    );
    if (!document) {
      error(res, "Document not found", 404);
      return true;
    }

    const fragments =
      await documentsService.listDocumentFragmentsWithAccessContext(
        documentId,
        accessContext,
      );
    const documentFragments = fragments
      .filter(hasUuidIdAndCreatedAt)
      .map((fragment) => {
        const metadata = asRecord(fragment.metadata);
        return {
          id: fragment.id,
          text: (fragment.content as { text?: string })?.text || "",
          position: metadata?.position,
          createdAt: fragment.createdAt,
        };
      })
      .sort((a, b) => {
        const posA = typeof a.position === "number" ? a.position : 0;
        const posB = typeof b.position === "number" ? b.position : 0;
        return posA - posB;
      })
      .map((fragment) => ({
        id: fragment.id,
        text: fragment.text,
        position: fragment.position,
        createdAt: fragment.createdAt,
      }));

    json(res, {
      documentId,
      fragments: documentFragments,
      count: documentFragments.length,
    });
    return true;
  }

  const docPinsMatch = /^\/api\/documents\/([^/]+)\/pins$/.exec(pathname);
  if ((method === "GET" || method === "PATCH") && docPinsMatch) {
    if (accessContext.role !== "OWNER") {
      error(res, "Only the owner can manage document pins", 403);
      return true;
    }
    const id = decodeMatchedPathComponent(ctx, docPinsMatch[1], "document id");
    if (!id) return true;
    if (!isUuidValue(id)) {
      error(res, "document id must be a valid UUID");
      return true;
    }
    try {
      if (method === "GET") {
        if (!documentsService.getDocumentPinsWithAccessContext) {
          error(res, "Document pin authority is unavailable", 503);
          return true;
        }
        const state = await documentsService.getDocumentPinsWithAccessContext(
          id as UUID,
          accessContext,
        );
        json(res, { documentId: id, ...state });
      } else {
        if (!documentsService.setDocumentPinsWithAccessContext) {
          error(res, "Document pin authority is unavailable", 503);
          return true;
        }
        const body = await readJsonBody<{
          agent?: unknown;
          roomIds?: unknown;
          expectedPinRevision?: unknown;
        }>(req, res, { maxBytes: 128 * 1024 });
        if (!body) return true;
        if (
          typeof body.agent !== "boolean" ||
          !Array.isArray(body.roomIds) ||
          typeof body.expectedPinRevision !== "string" ||
          !/^dar1_[a-f0-9]{64}$/.test(body.expectedPinRevision)
        ) {
          error(
            res,
            "Provide an agent pin, chat identifiers and the reviewed pin revision",
            400,
          );
          return true;
        }
        const roomIds: UUID[] = [];
        for (const roomId of body.roomIds) {
          if (!isUuidValue(roomId)) {
            error(res, "Chat identifiers must be valid UUIDs", 400);
            return true;
          }
          roomIds.push(roomId.trim() as UUID);
        }
        await documentsService.setDocumentPinsWithAccessContext(
          id as UUID,
          { agent: body.agent, roomIds },
          accessContext,
          body.expectedPinRevision,
        );
        json(res, { ok: true, documentId: id });
      }
    } catch (cause) {
      // error-policy:J1 Translate typed pin failures at the authenticated HTTP boundary.
      if (!(cause instanceof ElizaError)) throw cause;
      const status =
        cause.code === "DOCUMENT_PIN_NOT_FOUND"
          ? 404
          : cause.code === "DOCUMENT_PIN_FORBIDDEN"
            ? 403
            : cause.code === "DOCUMENT_PIN_CONFLICT"
              ? 409
              : cause.code === "DOCUMENT_PIN_ROOM_INVALID" ||
                  cause.code === "DOCUMENT_PIN_TARGETS_INVALID"
                ? 400
                : 500;
      error(res, cause.message, status);
    }
    return true;
  }

  const docIdMatch = /^\/api\/documents\/([^/]+)$/.exec(pathname);
  const docAccessMatch = /^\/api\/documents\/([^/]+)\/access$/.exec(pathname);
  if (method === "GET" && docAccessMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docAccessMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    if (!isUuidValue(decodedDocumentId)) {
      error(res, "document id must be a valid UUID");
      return true;
    }
    if (!documentsService.getDocumentDirectGrantStateWithAccessContext) {
      error(res, "Canonical document grant authority is unavailable", 503);
      return true;
    }
    try {
      const accessState =
        await documentsService.getDocumentDirectGrantStateWithAccessContext(
          decodedDocumentId.trim() as UUID,
          accessContext,
        );
      json(res, {
        documentId: decodedDocumentId.trim(),
        ...accessState,
      });
    } catch (cause) {
      // error-policy:J1 The HTTP boundary translates typed ACL failures without exposing storage details.
      if (!(cause instanceof ElizaError)) throw cause;
      error(res, cause.message, documentGrantErrorStatus(cause));
    }
    return true;
  }

  if (method === "PATCH" && docAccessMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docAccessMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    if (!isUuidValue(decodedDocumentId)) {
      error(res, "document id must be a valid UUID");
      return true;
    }
    if (!documentsService.setDocumentDirectGrantsWithAccessContext) {
      error(res, "Canonical document grant authority is unavailable", 503);
      return true;
    }
    const body = await readJsonBody<{
      directGrantEntityIds?: unknown;
      expectedAccessRevision?: unknown;
    }>(req, res, {
      maxBytes: 128 * 1024,
    });
    if (!body) return true;
    if (
      typeof body.expectedAccessRevision !== "string" ||
      !/^dar1_[a-f0-9]{64}$/.test(body.expectedAccessRevision)
    ) {
      error(
        res,
        "Reload document access and provide its reviewed expectedAccessRevision",
        400,
      );
      return true;
    }
    if (!Array.isArray(body.directGrantEntityIds)) {
      error(res, "directGrantEntityIds must be an array of UUIDs");
      return true;
    }
    const requestedGrants: UUID[] = [];
    for (const value of body.directGrantEntityIds) {
      if (!isUuidValue(value)) {
        error(res, "directGrantEntityIds must contain only UUIDs");
        return true;
      }
      requestedGrants.push(value.trim() as UUID);
    }
    try {
      const document =
        await documentsService.setDocumentDirectGrantsWithAccessContext(
          decodedDocumentId.trim() as UUID,
          requestedGrants,
          accessContext,
          body.expectedAccessRevision,
        );
      // `metadata` is the MemoryMetadata union; only DocumentMetadata carries
      // the grants, so narrow with `in` before reading.
      const metadata = document.metadata;
      const directGrantCandidate =
        metadata &&
        "directGrantEntityIds" in metadata &&
        (metadata as { directGrantEntityIds?: unknown }).directGrantEntityIds;
      const directGrantEntityIds = Array.isArray(directGrantCandidate)
        ? directGrantCandidate
        : [];
      json(res, { ok: true, documentId: document.id, directGrantEntityIds });
    } catch (cause) {
      // error-policy:J1 The HTTP boundary translates typed ACL failures without exposing storage details.
      if (!(cause instanceof ElizaError)) throw cause;
      error(res, cause.message, documentGrantErrorStatus(cause));
    }
    return true;
  }

  if (method === "GET" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    if (!documentsService.getDocumentByIdWithAccessContext) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const document = await documentsService.getDocumentByIdWithAccessContext(
      documentId,
      accessContext,
    );
    if (!document) {
      error(res, "Document not found", 404);
      return true;
    }

    if (!documentsService.listDocumentFragmentsWithAccessContext) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const fragmentCount = (
      await documentsService.listDocumentFragmentsWithAccessContext(
        documentId,
        accessContext,
      )
    ).length;

    json(res, {
      document: presentDocument(document, fragmentCount, {
        includeContent: true,
      }),
    });
    return true;
  }

  if (method === "PATCH" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    if (!documentsService.getMutableDocumentWithAccessContext) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const document = await documentsService.getMutableDocumentWithAccessContext(
      documentId,
      accessContext,
    );
    if (!document) {
      error(res, "Document not found", 404);
      return true;
    }

    const editability = getDocumentEditability(document);
    if (!editability.canEditText) {
      error(res, editability.reason || "This document cannot be edited.", 400);
      return true;
    }

    const body = await readJsonBody<{ content?: string }>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      error(res, "content must be a non-empty string");
      return true;
    }

    const result = await documentsService.updateDocument({
      documentId,
      content: body.content,
      accessContext,
    });

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
    });
    return true;
  }

  if (method === "DELETE" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    if (
      !documentsService.getMutableDocumentWithAccessContext ||
      !documentsService.listDocumentFragmentsWithAccessContext ||
      !documentsService.deleteDocumentWithAccessContext
    ) {
      error(res, "Canonical document authorization is unavailable", 503);
      return true;
    }
    const existingDocument =
      await documentsService.getMutableDocumentWithAccessContext(
        documentId,
        accessContext,
      );
    if (!existingDocument) {
      error(res, "Document not found", 404);
      return true;
    }

    const deleteability = getDocumentDeleteability(existingDocument);
    if (!deleteability.canDelete) {
      error(
        res,
        deleteability.reason || "This document cannot be deleted.",
        400,
      );
      return true;
    }

    const fragmentCount = (
      await documentsService.listDocumentFragmentsWithAccessContext(
        documentId,
        accessContext,
      )
    ).length;
    await documentsService.deleteDocumentWithAccessContext(
      documentId,
      accessContext,
    );

    json(res, {
      ok: true,
      deletedFragments: fragmentCount,
    });
    return true;
  }

  async function addDocument(
    service: DocumentsServiceLike,
    document: DocumentUploadBody,
    validatedContentType: ValidatedDocumentContentType,
    actor: RouteActor,
    location: DocumentUploadLocation,
  ): Promise<{
    documentId: UUID;
    fragmentCount: number;
    warnings?: string[];
  }> {
    const metadata = asRecord(document.metadata);
    const requestedAddedFrom = document.addedFrom ?? metadata?.addedFrom;
    if (document.audience !== undefined && document.audience !== "chat") {
      throw new ElizaError("Unsupported document audience", {
        code: "DOCUMENT_CHAT_SHARING_INVALID",
      });
    }
    const chatAudience =
      document.audience === "chat" ||
      (requestedAddedFrom === "chat" &&
        document.scope === undefined &&
        metadata?.scope === undefined &&
        document.scopedToEntityId === undefined &&
        metadata?.scopedToEntityId === undefined);
    if (chatAudience) {
      if (
        (document.scope !== undefined && document.scope !== "global") ||
        (metadata?.scope !== undefined && metadata.scope !== "global") ||
        document.scopedToEntityId !== undefined ||
        metadata?.scopedToEntityId !== undefined
      ) {
        throw new ElizaError(
          "Choose either chat sharing or an explicit private scope",
          { code: "DOCUMENT_CHAT_SHARING_INVALID" },
        );
      }
      if (
        !runtime ||
        !["OWNER", "ADMIN", "USER"].includes(actor.role) ||
        !(await runtime.getParticipantsForRoom(location.roomId)).includes(
          actor.entityId,
        )
      ) {
        throw new ElizaError(
          "Chat sharing requires a current authorized participant",
          { code: "DOCUMENT_CHAT_SHARING_FORBIDDEN" },
        );
      }
    }
    let content = document.content;
    // Capture the bytes exactly as uploaded before any content rewrite (e.g.
    // image → description text), so the linked original-bytes file is faithful.
    const originalContent = document.content;
    const originalContentType = validatedContentType.original;
    const uploadedContentType = validatedContentType.essence;
    let contentType = uploadedContentType;
    const warnings: string[] = [];
    const originalBytesAreTextBacked =
      isTextBackedContentType(uploadedContentType) ||
      hasTextBackedFilename(document.filename);

    if (contentType.startsWith("image/")) {
      const includeDescriptions =
        asRecord(document.metadata)?.includeImageDescriptions === true;
      if (!includeDescriptions) {
        throw new Error(
          "Image uploads require metadata.includeImageDescriptions=true so the document store can persist real searchable text.",
        );
      }
      if (!runtime || typeof runtime.useModel !== "function") {
        throw new Error(
          "Image uploads require an IMAGE_DESCRIPTION model handler; no runtime model handler is available.",
        );
      }
      const { ModelType } = await import("@elizaos/core");
      const dataUri = `data:${contentType};base64,${content}`;
      let description: unknown;
      try {
        description = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
          imageUrl: dataUri,
          prompt: `Describe this image in detail for a document store. Focus on text content, data, charts, and key visual elements. Image filename: ${document.filename}`,
        });
      } catch (modelErr) {
        throw new Error(`Image description model failed: ${String(modelErr)}`);
      }
      const descText =
        typeof description === "string"
          ? description.trim()
          : typeof (description as { description?: unknown }).description ===
              "string"
            ? (description as { description: string }).description.trim()
            : "";
      if (!descText) {
        throw new Error("Image description model returned empty text.");
      }
      content = `[Image: ${document.filename}]\n\n${descText}`;
      contentType = "text/plain";
    }

    if (document.filename.endsWith(".mdx")) {
      contentType = "text/markdown";
    }

    const textBacked =
      isTextBackedContentType(contentType) ||
      hasTextBackedFilename(document.filename);

    const uploadFilters = chatAudience
      ? {
          scope: "global" as const,
          scopedToEntityId: undefined,
          error: undefined,
        }
      : filtersFromUploadBody(document, actor);
    if (uploadFilters.error) {
      throw new Error(uploadFilters.error);
    }
    const scopedToEntityId = uploadFilters.scopedToEntityId;
    const { roomId, worldId } = location;
    const entityId =
      uploadFilters.scope === "user-private"
        ? (scopedToEntityId ?? actor.entityId)
        : actor.entityId;
    const addedFrom: DocumentAddedFrom =
      requestedAddedFrom === "chat"
        ? "chat"
        : requestedAddedFrom === "import"
          ? "import"
          : "upload";
    const source = addedFrom;

    // Persist the ORIGINAL uploaded bytes (content-addressed) and link them on
    // the document record so it stays downloadable/previewable. Best-effort: a
    // missing service or storage failure must never fail the upload — we log a
    // warning and proceed without the link.
    let mediaLink:
      | { mediaUrl: string; mediaHash: string; mediaFileName: string }
      | undefined;
    if (originalContent.length > 0) {
      try {
        const fileStorage = runtime?.getService(
          ServiceType.REMOTE_FILES,
        ) as IFileStorageService | null;
        if (fileStorage) {
          // Text uploads carry UTF-8 text; binary/non-text uploads (images,
          // PDFs, …) arrive base64-encoded in `content`.
          const bytes = originalBytesAreTextBacked
            ? Buffer.from(originalContent, "utf8")
            : Buffer.from(originalContent, "base64");
          const stored = await fileStorage.store(bytes, uploadedContentType);
          mediaLink = {
            mediaUrl: stored.url,
            mediaHash: stored.hash,
            mediaFileName: stored.fileName,
          };
        }
      } catch (storageErr) {
        runtime?.logger?.warn(
          `[documents] failed to persist original bytes for "${document.filename}": ${
            storageErr instanceof Error
              ? storageErr.message
              : String(storageErr)
          }`,
        );
      }
    }

    const result = await service.addDocument({
      ...(chatAudience ? { audience: "chat" as const } : {}),
      agentId,
      worldId,
      roomId,
      entityId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: document.filename,
      content,
      scope: uploadFilters.scope,
      scopedToEntityId,
      addedBy: actor.entityId,
      addedByRole: routeActorAddedByRole(actor),
      addedFrom,
      metadata: {
        ...metadata,
        source,
        filename: document.filename,
        originalFilename: document.filename,
        fileType: originalContentType,
        contentType,
        textBacked,
        scope: uploadFilters.scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: actor.entityId,
        addedByRole: routeActorAddedByRole(actor),
        addedFrom,
        ...(mediaLink ?? {}),
      },
    });

    const warningsValue = (result as { warnings?: unknown }).warnings;
    if (Array.isArray(warningsValue)) {
      for (const warning of warningsValue) {
        if (typeof warning === "string") warnings.push(warning);
      }
    }

    return {
      documentId: result.clientDocumentId as UUID,
      fragmentCount: result.fragmentCount,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (method === "POST" && pathname === "/api/documents") {
    const body = await readJsonBody<DocumentUploadBody>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (
      typeof body.content !== "string" ||
      typeof body.filename !== "string" ||
      body.content.trim().length === 0 ||
      body.filename.trim().length === 0
    ) {
      error(res, "content and filename must be non-empty strings");
      return true;
    }

    const contentType = validateDocumentContentType(body.contentType);
    if (!contentType.ok) {
      error(res, contentType.error, 400);
      return true;
    }

    let result: {
      documentId: string;
      fragmentCount: number;
      warnings?: string[];
    };
    const location = await resolveUploadLocation(body);
    if (!location.ok) {
      error(res, location.error, location.status);
      return true;
    }
    try {
      result = await addDocument(
        documentsService,
        body,
        contentType.value,
        routeActor,
        location.value,
      );
    } catch (err) {
      // error-policy:J1 Map canonical chat audience failures at the upload boundary.
      if (
        err instanceof ElizaError &&
        err.code.startsWith("DOCUMENT_CHAT_SHARING_")
      ) {
        error(
          res,
          err.message,
          err.code === "DOCUMENT_CHAT_SHARING_CHANGED"
            ? 409
            : err.code === "DOCUMENT_CHAT_SHARING_INVALID"
              ? 400
              : 403,
        );
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      error(
        res,
        `Failed to add document: ${message}`,
        /Only the owner|Users can only/i.test(message)
          ? 403
          : /Image uploads require|Image description model/i.test(message)
            ? 400
            : 500,
      );
      return true;
    }

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
      warnings: result.warnings,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/documents/bulk") {
    const body = await readJsonBody<{
      documents?: DocumentUploadBody[];
      scope?: string;
      scopedToEntityId?: string;
    }>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      error(res, "documents array is required");
      return true;
    }

    if (body.documents.length > MAX_BULK_DOCUMENTS) {
      error(
        res,
        `documents array exceeds limit (${MAX_BULK_DOCUMENTS} per request)`,
      );
      return true;
    }

    const validatedContentTypes = new Map<
      number,
      ValidatedDocumentContentType
    >();
    for (const [index, document] of body.documents.entries()) {
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document)
      ) {
        continue;
      }
      const contentType = validateDocumentContentType(document.contentType);
      if (!contentType.ok) {
        error(res, contentType.error, 400);
        return true;
      }
      validatedContentTypes.set(index, contentType.value);
    }

    const results: Array<{
      index: number;
      ok: boolean;
      filename: string;
      documentId?: UUID;
      fragmentCount?: number;
      error?: string;
      warnings?: string[];
    }> = [];

    for (const [index, document] of body.documents.entries()) {
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document)
      ) {
        results.push({
          index,
          ok: false,
          filename: `document-${index + 1}`,
          error: "content and filename must be non-empty strings",
        });
        continue;
      }

      const contentType = validatedContentTypes.get(index);
      if (!contentType) {
        error(res, DOCUMENT_CONTENT_TYPE_VALIDATION_ERROR, 400);
        return true;
      }

      const filename = document.filename || `document-${index + 1}`;
      if (
        typeof document.content !== "string" ||
        typeof document.filename !== "string" ||
        document.content.trim().length === 0 ||
        document.filename.trim().length === 0
      ) {
        results.push({
          index,
          ok: false,
          filename,
          error: "content and filename must be non-empty strings",
        });
        continue;
      }

      const normalizedDocument: DocumentUploadBody = {
        ...document,
        content: document.content,
        filename: document.filename.trim(),
        scope: document.scope ?? body.scope,
        scopedToEntityId: document.scopedToEntityId ?? body.scopedToEntityId,
      };

      try {
        const location = await resolveUploadLocation(normalizedDocument);
        if (!location.ok) {
          results.push({
            index,
            ok: false,
            filename,
            error: location.error,
          });
          continue;
        }
        const uploadResult = await addDocument(
          documentsService,
          normalizedDocument,
          contentType,
          routeActor,
          location.value,
        );
        results.push({
          index,
          ok: true,
          filename,
          documentId: uploadResult.documentId,
          fragmentCount: uploadResult.fragmentCount,
          warnings: uploadResult.warnings,
        });
      } catch (err) {
        results.push({
          index,
          ok: false,
          filename,
          error: String(err),
        });
      }
    }

    const successCount = results.filter((item) => item.ok).length;
    const failureCount = results.length - successCount;

    json(res, {
      ok: failureCount === 0,
      total: results.length,
      successCount,
      failureCount,
      results,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/documents/url") {
    const body = await readJsonBody<{
      url: string;
      metadata?: Record<string, unknown>;
      roomId?: string;
      worldId?: string;
      entityId?: string;
      scope?: string;
      scopedToEntityId?: string;
      includeImageDescriptions?: boolean;
    }>(req, res);
    if (!body) return true;

    const urlToFetch = trimString(body.url);
    if (!urlToFetch) {
      error(res, "url is required");
      return true;
    }

    const location = await resolveUploadLocation(body);
    if (!location.ok) {
      error(res, location.error, location.status);
      return true;
    }

    let fetchedContent: Awaited<ReturnType<typeof fetchDocumentFromUrl>>;
    try {
      fetchedContent = await fetchDocumentFromUrl(urlToFetch, {
        includeImageDescriptions: body.includeImageDescriptions === true,
      });
    } catch (fetchErr) {
      error(res, `Failed to fetch URL content: ${String(fetchErr)}`, 400);
      return true;
    }

    const { content, mimeType, filename } = fetchedContent;
    const contentType = mimeType;
    const uploadFilters = filtersFromUploadBody(body, routeActor);
    if (uploadFilters.error) {
      error(res, uploadFilters.error, 403);
      return true;
    }
    const scopedToEntityId = uploadFilters.scopedToEntityId;
    const { roomId, worldId } = location.value;
    const entityId =
      uploadFilters.scope === "user-private"
        ? (scopedToEntityId ?? routeActor.entityId)
        : routeActor.entityId;
    const isYouTubeTranscript = isYouTubeUrl(urlToFetch);

    const result = await documentsService.addDocument({
      agentId,
      worldId,
      roomId,
      entityId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: filename,
      content,
      scope: uploadFilters.scope,
      scopedToEntityId,
      addedBy: routeActor.entityId,
      addedByRole: routeActorAddedByRole(routeActor),
      addedFrom: "url",
      metadata: {
        ...body.metadata,
        url: urlToFetch,
        source: isYouTubeTranscript ? "youtube" : "url",
        filename,
        originalFilename: filename,
        fileType: contentType,
        contentType,
        textBacked: fetchedContent.contentType !== "binary",
        scope: uploadFilters.scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: routeActor.entityId,
        addedByRole: routeActorAddedByRole(routeActor),
      },
    });

    json(res, {
      ok: true,
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      filename,
      contentType,
      isYouTubeTranscript,
    });
    return true;
  }

  return false;
}
