/**
 * Canonical type surface and lazy resolver for the runtime "documents" service.
 * Defines the shared vocabulary (visibility scopes, added-by roles, sources,
 * search modes, and the `DocumentsServiceLike` shape) that route helpers and
 * `@elizaos/plugin-documents` agree on, plus `getDocumentsService()`, which
 * returns the already-registered service or awaits its load promise up to an
 * env-tunable timeout (`DOCUMENTS_SERVICE_TIMEOUT_MS`, default 10s, cap 60s),
 * reporting a typed `DocumentsLoadFailReason` on miss instead of throwing.
 */
import type {
  AccessContext,
  IAgentRuntime,
  Memory,
  Service,
  UUID,
} from "@elizaos/core";

// Canonical union types for the documents service surface.
// Plugin packages (e.g. @elizaos/plugin-documents) re-export these so route
// helpers and presenters share one type vocabulary across the workspace.
export type DocumentVisibilityScope =
  | "global"
  | "owner-private"
  | "user-private"
  | "agent-private";

export type DocumentAddedByRole =
  | "OWNER"
  | "ADMIN"
  | "USER"
  | "GUEST"
  | "AGENT"
  | "RUNTIME";

export type DocumentAddedFrom =
  | "import"
  | "chat"
  | "upload"
  | "url"
  | "file"
  | "agent-autonomous"
  | "runtime-internal"
  | "lifeops"
  | "default-seed"
  | "character";

export type DocumentSearchMode = "hybrid" | "vector" | "keyword";

export interface DocumentsServiceLike {
  getDocumentPinsWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<{
    targets: { agent: boolean; roomIds: UUID[] };
    pinRevision: string;
  }>;
  setDocumentPinsWithAccessContext?(
    documentId: UUID,
    targets: { agent: boolean; roomIds: UUID[] },
    accessContext: AccessContext,
    expectedPinRevision: string,
  ): Promise<Memory>;
  addDocument(options: {
    agentId?: UUID;
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    metadata?: Record<string, unknown>;
    audience?: "chat";
    scope?: DocumentVisibilityScope;
    scopedToEntityId?: UUID;
    addedBy?: UUID;
    addedByRole?: DocumentAddedByRole;
    addedFrom?: DocumentAddedFrom;
  }): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }>;
  searchDocuments(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
    searchMode?: DocumentSearchMode,
    accessContext?: AccessContext,
    options?: { turnMessageId?: UUID },
  ): Promise<
    Array<{
      id: UUID;
      content: { text?: string };
      similarity?: number;
      metadata?: Record<string, unknown>;
      worldId?: UUID;
    }>
  >;
  listDocuments?(
    message?: Memory,
    options?: Record<string, unknown>,
  ): Promise<Memory[]>;
  listAllDocumentsWithAccessContext?(
    accessContext: AccessContext,
  ): Promise<Memory[]>;
  getDocumentById?(documentId: UUID, message?: Memory): Promise<Memory | null>;
  getDocumentByIdWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<Memory | null>;
  getMutableDocumentWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<Memory | null>;
  setDocumentDirectGrantsWithAccessContext?(
    documentId: UUID,
    directGrantEntityIds: UUID[],
    accessContext: AccessContext,
    expectedAccessRevision?: string,
  ): Promise<Memory>;
  getDocumentDirectGrantStateWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<{ directGrantEntityIds: UUID[]; accessRevision: string }>;
  getDocumentDirectGrantsWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<UUID[]>;
  listDocumentFragmentsWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<Memory[]>;
  getMemories(params: {
    tableName: string;
    roomId?: UUID;
    count?: number;
    offset?: number;
    cursor?: { createdAt: number; id: UUID };
    end?: number;
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
    includeEmbedding?: boolean;
  }): Promise<Memory[]>;
  countMemories(params: {
    tableName: string;
    roomId?: UUID;
    unique?: boolean;
  }): Promise<number>;
  updateDocument(options: {
    documentId: UUID;
    content: string;
    message?: Memory;
    accessContext?: AccessContext;
  }): Promise<{
    documentId: UUID;
    fragmentCount: number;
  }>;
  deleteDocument?(documentId: UUID, message?: Memory): Promise<void>;
  deleteDocumentWithAccessContext?(
    documentId: UUID,
    accessContext: AccessContext,
  ): Promise<void>;
  deleteMemory(memoryId: UUID): Promise<void>;
}

export type DocumentsLoadFailReason =
  | "timeout"
  | "runtime_unavailable"
  | "not_registered";

export interface DocumentsServiceResult {
  service: DocumentsServiceLike | null;
  reason?: DocumentsLoadFailReason;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export function getDocumentsServiceTimeoutMs(): number {
  const envVal = process.env.DOCUMENTS_SERVICE_TIMEOUT_MS;
  if (!envVal) return DEFAULT_TIMEOUT_MS;
  // `Number.parseInt` stops at the first non-digit, so "1junk" parsed to a
  // positive 1 and passed the guard below — a 1ms budget that makes every
  // documents-service load report `timeout`, from a value nobody set as a
  // timeout. Require the whole trimmed value to be decimal.
  const trimmed = envVal.trim();
  const parsed = /^\+?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

export async function getDocumentsService(
  runtime: IAgentRuntime | null,
): Promise<DocumentsServiceResult> {
  if (!runtime) {
    return { service: null, reason: "runtime_unavailable" };
  }

  let service = runtime.getService<Service & DocumentsServiceLike>("documents");
  if (service) return { service };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const servicePromise = runtime.getServiceLoadPromise("documents");
    const timeoutMs = getDocumentsServiceTimeoutMs();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("documents service timeout")),
        timeoutMs,
      );
    });
    await Promise.race([servicePromise, timeoutPromise]);
    service = runtime.getService<Service & DocumentsServiceLike>("documents");
    if (service) return { service };
    return { service: null, reason: "not_registered" };
  } catch {
    // error-policy:J1 Translate load timeout/rejection into the typed loader result.
    return { service: null, reason: "timeout" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
