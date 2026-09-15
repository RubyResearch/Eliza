/**
 * Conversation CRUD routes extracted from server.ts.
 *
 * Handles:
 *   POST   /api/conversations            – create
 *   GET    /api/conversations             – list
 *   GET    /api/conversations/messages/search – corpus-wide message search
 *   POST   /api/conversations/dev/seed-messages – dev-only backdated corpus seed
 *   GET    /api/conversations/:id/messages – get messages
 *   POST   /api/conversations/:id/messages/truncate – truncate
 *   DELETE /api/conversations/:id/messages/:messageId – delete one message
 *   POST   /api/conversations/:id/messages/stream   – stream message
 *   POST   /api/conversations/:id/messages           – send message
 *   POST   /api/conversations/:id/greeting            – get/store greeting
 *   PATCH  /api/conversations/:id         – update/rename
 *   DELETE /api/conversations/:id         – delete
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { RouteRequestContext } from "@elizaos/core";
import {
  type ActionResult,
  type AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  authorizeOwnerExclusiveDisclosure,
  ChannelType,
  type Content,
  composeToolDiagnosticRedactor,
  createMessageMemory,
  createUniqueUuid,
  ElizaError,
  enforceTrustedDeliveryAudienceAtEgress,
  evaluatePlannedReplyEgress,
  getEntityRole,
  getInferenceTimer,
  hasAtLeastRole,
  InferenceTurnTimer,
  logger,
  MESSAGE_SOURCE_AGENT_GREETING,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  mergeEffectReceipts,
  nextInferenceTurnId,
  normalizeActionFailureProvenance,
  normalizeActionReplyFailure,
  normalizeEffectReceipts,
  projectCompleteToolValueForModel,
  type RoleGrantSource,
  type RolesWorldMetadata,
  type RoomHandlerLease,
  RoomHandlerQueueClosedError,
  RoomHandlerQueueGlobalSaturatedError,
  RoomHandlerQueueSaturatedError,
  recordOwnerGrant,
  recordRoleGrant,
  resolveAppliedUserFacingEffectReceipts,
  resolvePlannedReplyEgress,
  runWithInferenceTiming,
  shouldSkipResponseMemoryPersistence,
  stringToUuid,
  type TrustedApiPrincipal,
  timeInferenceSpan,
  type UUID,
  validateUuid,
  withStandaloneTrajectory,
} from "@elizaos/core";
import {
  getScheduledTaskRunner,
  isScheduledTask,
  type ScheduledTask,
} from "@elizaos/plugin-scheduling";
import type { ChatFailureKind, ChatTerminalFailure } from "@elizaos/shared";
import {
  isChatFailureKind,
  LOCAL_VOICE_RUNTIME_AGENT_HEADER,
  LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER,
  PatchConversationRequestSchema,
  PostConversationCleanupEmptyRequestSchema,
  PostConversationRequestSchema,
  PostConversationTruncateRequestSchema,
  PostSeedMessagesRequestSchema,
  parseChatFailureKind,
  parseChatTerminalFailure,
  parsePositiveInteger,
} from "@elizaos/shared";
import {
  parseSharedTodoCutoverSnapshot,
  TodoCutoverContractError,
} from "@elizaos/shared/todo-cutover";
import type { ElizaConfig } from "../config/config.ts";
import { resolveStateDir } from "../config/paths.ts";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import {
  deleteConversationMemories,
  deleteConversationMessage,
  truncateConversationMessages,
} from "../services/conversation-message-service.ts";
import {
  createPendantSessionRepository,
  type PendantSessionRepository,
} from "../services/pendant-session/repository.ts";
import {
  type SerializedMessageAttachment,
  selectAttachmentsForViewer,
} from "./attachment-disclosure.ts";
import type {
  AccountConnectRequest,
  ChatGenerationResult,
  ChatMessageIdOutcome,
  ChatMessageIdReservation,
  LogEntry,
} from "./chat-routes.ts";
import {
  admitChatMessageId,
  ChatIdempotencyWaitAbortedError,
  classifyChatFailure,
  createChatTokenStreamWriter,
  generateChatResponse,
  generateConversationTitle,
  getChatFailureReply,
  getChatMessageIdOutcome,
  initSse,
  isIntentionalNoResponseResult,
  normalizeAccountConnectRequest,
  normalizeChatResponseText,
  normalizeClientMessageId,
  persistAssistantConversationMemory,
  persistConversationMemory,
  persistExactConversationMemory,
  persistExactConversationMemoryResult,
  persistInterruptedAssistantReceipt,
  readChatRequestPayload,
  releaseChatMessageId,
  resolveNoResponseFallback,
  resolveTrustedApiPrincipal,
  setChatMessageIdOutcome,
  writeChatStatusSse,
  writeChatTokenSse,
  writeChatToolSse,
  writeSse,
  writeSseJson,
} from "./chat-routes.ts";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.ts";
import {
  assertConversationConnectionRuntime,
  type ConversationConnectionDescriptor,
  captureConversationConnectionDescriptor,
  isConversationConnectionError,
  prepareConversationConnectionRoom,
  scheduleConversationConnectionEnsure,
  serializeConversationConnectionRoomDeletion,
} from "./conversation-connection-readiness.ts";
import {
  buildConversationRoomMetadata,
  sanitizeConversationMetadata,
} from "./conversation-metadata.ts";
import {
  compareConversationsByRecency,
  compareMemoriesByCreatedAt,
} from "./conversation-sort.ts";
import {
  ELIZA_TRACE_ID_HEADER,
  resolveConversationTraceContext,
} from "./conversation-trace.ts";
import { resolveHttpAccessContext } from "./http-access-context.ts";
import { evictOldestConversation } from "./memory-bounds.ts";
import { generateMessageCorpus, seedMessageCorpus } from "./message-corpus.ts";
import {
  buildUserMessages,
  decodePathComponent,
  getErrorMessage,
  resolveAppUserName,
} from "./server-helpers.ts";
import { normalizeWsClientId } from "./server-helpers-auth.ts";
import type { ConversationMeta } from "./server-types.ts";
import {
  importSharedTodoCutover,
  type SharedTodoImportReceipt,
} from "./todo-cutover-import.ts";
import {
  resolveWaifuChatAccess,
  type WaifuChatAccess,
  type WaifuChatWorldRole,
  waifuChatRoleToWorldRole,
} from "./waifu-chat-role-resolver.ts";

interface DiscordProfileLike {
  avatarUrl?: string;
  displayName?: string;
  rawUserId?: string;
  username?: string;
}

// Lazy memoized loader: @elizaos/plugin-discord (and its transitive deps) loads
// only when a conversation actually contains Discord-sourced messages. A
// module-scope `await import` would load it on every agent boot.
type DiscordConversationModule = {
  cacheDiscordAvatarForRuntime: (
    runtime: AgentRuntime,
    avatarUrl: string | undefined,
    userId?: string,
  ) => Promise<string | undefined>;
  isCanonicalDiscordSource: (source: unknown) => boolean;
  resolveDiscordMessageAuthorProfile: (
    runtime: AgentRuntime,
    channelId: string,
    messageId: string,
  ) => Promise<DiscordProfileLike | null>;
  resolveDiscordUserProfile: (
    runtime: AgentRuntime,
    userId: string,
  ) => Promise<DiscordProfileLike | null>;
  resolveStoredDiscordEntityProfile: (
    runtime: AgentRuntime,
    entityId: string | undefined,
  ) => Promise<DiscordProfileLike | null>;
};

let discordConversationPromise: Promise<DiscordConversationModule> | null =
  null;
function getDiscordConversationApi(): Promise<DiscordConversationModule> {
  discordConversationPromise ??= import(
    "@elizaos/plugin-discord"
  ) as Promise<unknown> as Promise<DiscordConversationModule>;
  return discordConversationPromise;
}

function mayNeedDiscordMessageEnrichment(source: unknown): boolean {
  return typeof source === "string" && source.toLowerCase().includes("discord");
}

function chunkVisibleTextForSse(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  const targetSize = 48;
  while (cursor < text.length) {
    const limit = Math.min(text.length, cursor + targetSize);
    let end = limit;
    if (limit < text.length) {
      const boundary = text.lastIndexOf(" ", limit);
      if (boundary > cursor + 12) {
        end = boundary + 1;
      }
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Deleted-conversations state persistence
// ---------------------------------------------------------------------------

const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

function _readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (error) {
    // error-policy:J2 an existing but unreadable tombstone file cannot be
    // treated as an empty deletion history or deleted chats may reappear.
    throw new ElizaError("Failed to read deleted conversation tombstones", {
      code: "DELETED_CONVERSATION_STATE_READ_FAILED",
      cause: error,
      context: { filePath },
    });
  }
}

function persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(
    path.join(dir, DELETED_CONVERSATIONS_FILENAME),
    JSON.stringify(payload, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// State interface required by conversation routes
// ---------------------------------------------------------------------------

export interface ConversationRouteState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  agentName: string;
  adminEntityId: UUID | null;
  chatUserId: UUID | null;
  logBuffer: LogEntry[];
  conversations: Map<string, ConversationMeta>;
  activeChatTurnCount: number;
  conversationRestorePromise: Promise<void> | null;
  deletedConversationIds: Set<string>;
  broadcastWs: ((data: object) => void) | null;
  /** Wallet trade permission mode for wallet-mode guidance replies. */
  tradePermissionMode?: string;
}

export interface ConversationRouteContext extends RouteRequestContext {
  state: ConversationRouteState;
  callerAuthorization?: AgentHttpRequestAuthorization;
  todoCutoverImporter?: typeof importSharedTodoCutover;
}

interface LocalVoiceRuntimeFence {
  runtime: AgentRuntime;
}

type LocalVoiceRuntimeFenceResolution =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "valid"; fence: LocalVoiceRuntimeFence };

function readCanonicalSingleHeader(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null | "invalid" {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return null;
  if (
    Array.isArray(value) ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes(",")
  ) {
    return "invalid";
  }
  return value;
}

function resolveLocalVoiceRuntimeFence(
  req: Pick<http.IncomingMessage, "headers">,
  state: ConversationRouteState,
  conversationId: string,
): LocalVoiceRuntimeFenceResolution {
  const expectedAgentId = readCanonicalSingleHeader(
    req,
    LOCAL_VOICE_RUNTIME_AGENT_HEADER,
  );
  const expectedConversationId = readCanonicalSingleHeader(
    req,
    LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER,
  );
  if (expectedAgentId === null && expectedConversationId === null) {
    return { kind: "absent" };
  }
  if (
    expectedAgentId === null ||
    expectedConversationId === null ||
    expectedAgentId === "invalid" ||
    expectedConversationId === "invalid"
  ) {
    return {
      kind: "invalid",
      message: "Local voice runtime identity headers are invalid",
    };
  }
  if (expectedConversationId !== conversationId) {
    return {
      kind: "conflict",
      message: "Local voice conversation identity changed",
    };
  }
  const runtime = state.runtime;
  if (!runtime || String(runtime.agentId) !== expectedAgentId) {
    return {
      kind: "conflict",
      message: "Local voice agent runtime changed",
    };
  }
  return { kind: "valid", fence: { runtime } };
}

function isLocalVoiceRuntimeFenceCurrent(
  state: ConversationRouteState,
  fence: LocalVoiceRuntimeFence | null,
  conversation?: ConversationMeta,
): boolean {
  return (
    fence === null ||
    (state.runtime === fence.runtime &&
      (conversation === undefined ||
        (state.conversations.get(conversation.id) === conversation &&
          !state.deletedConversationIds.has(conversation.id))))
  );
}

function assertLocalVoiceTurnFenceCurrent(
  state: ConversationRouteState,
  fence: LocalVoiceRuntimeFence | null,
  conversation: ConversationMeta,
): void {
  if (fence === null) return;
  if (state.runtime !== fence.runtime) {
    throw new ElizaError("Local voice agent runtime changed", {
      code: "LOCAL_VOICE_RUNTIME_FENCE_CHANGED",
      context: { conversationId: conversation.id },
    });
  }
  if (
    state.conversations.get(conversation.id) !== conversation ||
    state.deletedConversationIds.has(conversation.id)
  ) {
    throw new ElizaError("Local voice conversation changed", {
      code: "LOCAL_VOICE_CONVERSATION_FENCE_CHANGED",
      context: { conversationId: conversation.id },
    });
  }
}

function readViewInteractionClientId(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  for (const name of ["x-elizaos-client-id", "x-eliza-client-id"] as const) {
    const value = req.headers[name];
    const candidate = Array.isArray(value) ? value[0] : value;
    const clientId = normalizeWsClientId(candidate);
    if (clientId) return clientId;
  }
  return null;
}

function withViewInteractionClient(
  message: Memory,
  req: Pick<http.IncomingMessage, "headers">,
): Memory {
  const viewClientId = readViewInteractionClientId(req);
  if (!viewClientId) return message;
  const contentMetadata =
    message.content.metadata &&
    typeof message.content.metadata === "object" &&
    !Array.isArray(message.content.metadata)
      ? message.content.metadata
      : {};

  // The routing identity is request-scoped rather than persisted chat content:
  // a device capability must return to the shell that initiated this turn,
  // while history remains portable across reconnects and devices.
  return {
    ...message,
    content: {
      ...message.content,
      metadata: {
        ...contentMetadata,
        viewClientId,
      },
    },
  };
}

function beginActiveChatTurn(state: ConversationRouteState): () => void {
  state.activeChatTurnCount = Math.max(0, state.activeChatTurnCount) + 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.activeChatTurnCount = Math.max(0, state.activeChatTurnCount - 1);
  };
}

type ConversationChatAdmission =
  | { kind: "owner"; reservation: ChatMessageIdReservation | null }
  | { kind: "settled"; outcome: ChatMessageIdOutcome }
  | { kind: "conflict"; error: ElizaError }
  | { kind: "aborted" };

function canonicalChatFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalChatFingerprintValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Code-unit order, not localeCompare: ICU collation is locale-dependent
        // and ranks canonically equivalent distinct keys as equal, so two
        // replicas would fingerprint one turn differently and admit a duplicate.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalChatFingerprintValue(entry)]),
    );
  }
  return value;
}

/**
 * Idempotency identity for one chat turn. Exported so the canonical key
 * ordering it depends on can be pinned by test.
 */
export function buildConversationChatFingerprint(input: {
  prompt: string;
  images: unknown;
  source: unknown;
  channelType: unknown;
  preferredLanguage: unknown;
  metadata: unknown;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalChatFingerprintValue(input)))
    .digest("hex");
}

function buildConversationChatIdempotencyScope(
  runtime: AgentRuntime,
  roomId: UUID,
  principalId: UUID,
): string {
  return `${runtime.agentId}:${roomId}:${principalId}`;
}

function isRoomQueueBackpressureError(error: unknown): boolean {
  return (
    error instanceof RoomHandlerQueueSaturatedError ||
    error instanceof RoomHandlerQueueGlobalSaturatedError
  );
}

function roomQueueAdmissionStatus(error: unknown): number {
  if (isRoomQueueBackpressureError(error)) return 429;
  if (error instanceof RoomHandlerQueueClosedError) return 503;
  return 500;
}

async function awaitConversationChatAdmission(
  scope: string,
  clientMessageId: string | null,
  fingerprint: string,
  signal: AbortSignal,
): Promise<ConversationChatAdmission> {
  while (true) {
    const admission = admitChatMessageId(scope, clientMessageId, {
      fingerprint,
    });
    if (admission.kind === "unkeyed") {
      return { kind: "owner", reservation: null };
    }
    if (admission.kind === "owner") {
      return { kind: "owner", reservation: admission.reservation };
    }
    if (admission.kind === "settled") {
      return { kind: "settled", outcome: admission.outcome };
    }
    if (admission.kind === "conflict") return admission;
    try {
      const result = await admission.wait(signal);
      if (result.kind === "settled") {
        return result;
      }
    } catch (error) {
      if (error instanceof ChatIdempotencyWaitAbortedError) {
        return { kind: "aborted" };
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Closure-lifted helpers
// ---------------------------------------------------------------------------

export function resolveConversationAdminEntityId(
  state: ConversationRouteState,
): UUID {
  return resolveClientChatAdminEntityId(state);
}

type StreamEventListener = (...args: unknown[]) => void;

interface StreamEventSource {
  on?: (event: string, listener: StreamEventListener) => unknown;
  off?: (event: string, listener: StreamEventListener) => unknown;
}

type StreamSocketLike = StreamEventSource & {
  destroyed?: boolean;
  writable?: boolean;
};

interface ConversationStreamDisconnectTracker {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  checkConnectionClosed: () => boolean;
  dispose: () => void;
  isAborted: () => boolean;
  markCompleted: () => void;
}

interface RequestDisconnectAbortTracker {
  signal: AbortSignal;
  dispose: () => void;
  isAborted: () => boolean;
  markCompleted: () => void;
}

function isStreamEventSource(value: unknown): value is StreamEventSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StreamEventSource).on === "function"
  );
}

function isStreamSocketLike(value: unknown): value is StreamSocketLike {
  return typeof value === "object" && value !== null;
}

function createRequestDisconnectAbortTracker({
  req,
  res,
  operation,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  operation: string;
}): RequestDisconnectAbortTracker {
  const abortController = new AbortController();
  const registrations: Array<{
    source: StreamEventSource;
    event: string;
    listener: StreamEventListener;
  }> = [];
  let aborted = false;
  let completed = false;

  const abort = (reason?: unknown) => {
    if (completed || aborted) return;
    aborted = true;
    abortController.abort(
      reason instanceof Error ? reason : new Error(`${operation} aborted`),
    );
  };

  const register = (
    source: unknown,
    event: string,
    listener: StreamEventListener,
  ) => {
    if (!isStreamEventSource(source)) return;
    source.on?.(event, listener);
    registrations.push({ source, event, listener });
  };

  const onClientGone = () =>
    abort(new Error(`${operation} client disconnected`));
  const onResponseClose = () => {
    const ended = Boolean(
      (res as http.ServerResponse & { writableEnded?: boolean }).writableEnded,
    );
    if (!ended) onClientGone();
  };

  register(req, "aborted", onClientGone);
  register(req, "error", onClientGone);
  register(res, "close", onResponseClose);
  register(res, "error", onClientGone);

  return {
    signal: abortController.signal,
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
    isAborted: () => aborted,
    markCompleted: () => {
      completed = true;
    },
  };
}

function createConversationStreamDisconnectTracker({
  req,
  res,
  conversationId,
  roomId,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  conversationId: string;
  roomId: UUID;
}): ConversationStreamDisconnectTracker {
  const abortController = new AbortController();
  const registrations: Array<{
    source: StreamEventSource;
    event: string;
    listener: StreamEventListener;
  }> = [];
  let aborted = false;
  let completed = false;

  const requestSocket = isStreamSocketLike(
    (req as http.IncomingMessage & { socket?: unknown }).socket,
  )
    ? ((req as http.IncomingMessage & { socket?: StreamSocketLike }).socket ??
      null)
    : null;
  const responseSocket = isStreamSocketLike(
    (res as http.ServerResponse & { socket?: unknown }).socket,
  )
    ? ((res as http.ServerResponse & { socket?: StreamSocketLike }).socket ??
      null)
    : null;

  const responseEnded = () =>
    Boolean(
      (res as http.ServerResponse & { writableEnded?: boolean }).writableEnded,
    );

  const abort = (reason?: unknown) => {
    if (completed || aborted) return;
    aborted = true;
    logger.info(
      { conversationId, roomId },
      "[ConversationStream] client disconnected; aborting generation",
    );
    abortController.abort(reason ?? new Error("Client disconnected"));
  };

  const checkConnectionClosed = () => {
    const socketClosed =
      requestSocket?.destroyed === true ||
      responseSocket?.destroyed === true ||
      (requestSocket?.writable === false && !responseEnded()) ||
      (responseSocket?.writable === false && !responseEnded());
    const responseClosed =
      (res as http.ServerResponse & { destroyed?: boolean }).destroyed ===
        true && !responseEnded();
    if (socketClosed || responseClosed) {
      abort(new Error("Client disconnected"));
      return true;
    }
    return false;
  };

  const register = (
    source: unknown,
    event: string,
    listener: StreamEventListener,
  ) => {
    if (!isStreamEventSource(source)) return;
    source.on?.(event, listener);
    registrations.push({ source, event, listener });
  };

  const onRequestClose = () => {
    checkConnectionClosed();
  };
  const onClientGone = () => {
    abort(new Error("Client disconnected"));
  };

  // Bun's node:http shim emits req.close when the POST body finishes, before
  // the SSE response is complete. Socket events must be attached before that
  // point; listeners added after body parsing can miss later client exits.
  register(req, "aborted", onClientGone);
  register(req, "close", onRequestClose);
  register(req, "error", onClientGone);
  register(res, "close", onClientGone);
  register(res, "error", onClientGone);
  register(requestSocket, "close", onClientGone);
  register(requestSocket, "error", onClientGone);
  if (responseSocket && responseSocket !== requestSocket) {
    register(responseSocket, "close", onClientGone);
    register(responseSocket, "error", onClientGone);
  }

  return {
    signal: abortController.signal,
    abort,
    checkConnectionClosed,
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
    isAborted: () => aborted,
    markCompleted: () => {
      completed = true;
    },
  };
}

function writeConversationStreamHeartbeat(
  res: http.ServerResponse,
  disconnectTracker: ConversationStreamDisconnectTracker,
): void {
  if (disconnectTracker.isAborted() || res.writableEnded) return;
  try {
    res.write(": heartbeat\n\n");
  } catch {
    disconnectTracker.abort(new Error("Client disconnected"));
  }
}

function isTurnAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return (
    code === "TURN_ABORTED" ||
    err.name === "TurnAbortedError" ||
    err.message.startsWith("Turn aborted:")
  );
}

function ensureAdminEntityIdForRuntime(
  state: ConversationRouteState,
  runtime: AgentRuntime | null,
): UUID {
  const resolutionState = {
    runtime,
    adminEntityId: state.adminEntityId,
    chatUserId: state.chatUserId,
    config: state.config,
    agentName: state.agentName,
  };
  const ownerId = resolveClientChatAdminEntityId(resolutionState);
  if (state.runtime === runtime) {
    state.adminEntityId = ownerId;
    state.chatUserId = ownerId;
  }
  return ownerId;
}

function ensureAdminEntityId(state: ConversationRouteState): UUID {
  return ensureAdminEntityIdForRuntime(state, state.runtime);
}

/**
 * The identity a conversation turn acts as: the minted/mapped entity, the
 * boundary role its world grant records, the display name, and the audit
 * source that non-owner grant is written with.
 */
export interface ConversationCaller {
  entityId: UUID;
  role: WaifuChatWorldRole;
  userName: string;
  grantSource: RoleGrantSource;
}

/**
 * Exported for the machine-session conversation-attribution regression suite;
 * runtime callers are the conversation route handlers in this module.
 */
export function resolveConversationCaller(
  req: http.IncomingMessage,
  state: ConversationRouteState,
  principal: TrustedApiPrincipal,
  runtime: AgentRuntime | null = state.runtime,
): ConversationCaller {
  const access = resolveWaifuChatAccess(req);
  if (access) {
    return {
      entityId: stringToUuid(
        `waifu-wallet:${access.walletAddress.toLowerCase()}`,
      ),
      role: waifuChatRoleToWorldRole(access.role),
      userName: access.walletAddress,
      grantSource: "connector_admin",
    };
  }

  if (
    principal.kind === "owner_session" ||
    principal.kind === "owner_api_token"
  ) {
    return {
      entityId: ensureAdminEntityIdForRuntime(state, runtime),
      role: "OWNER",
      userName: resolveAppUserName(state.config),
      grantSource: "owner",
    };
  }

  if (principal.kind === "service_gateway" && principal.sessionRole) {
    // A paired device's machine session authenticates at boundary role USER.
    // Mirror the compat chat ingress grant (grantSessionUserWorldRole in
    // chat-routes.ts) on the conversation surface so checkSenderRole resolves
    // the session's boundary role here too: sessionRole is the literal "USER"
    // by construction and the grant is recorded with audit source "session".
    return {
      entityId: stringToUuid(`conversation-external:${principal.principalId}`),
      role: principal.sessionRole,
      userName: "External API caller",
      grantSource: "session",
    };
  }

  return {
    entityId: stringToUuid(`conversation-external:${principal.principalId}`),
    role: "GUEST",
    userName: "External API caller",
    grantSource: "connector_admin",
  };
}

function normalizeWaifuWallet(address: string | undefined): string | null {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return address.toLowerCase();
}

function getWaifuChatOwnerWallet(conv: ConversationMeta): string | null {
  return normalizeWaifuWallet(conv.metadata?.waifuChatOwnerWallet);
}

function addWaifuConversationOwnerMetadata(
  req: http.IncomingMessage,
  metadata: ConversationMeta["metadata"],
): ConversationMeta["metadata"] {
  const access = resolveWaifuChatAccess(req);
  if (!access) return metadata;
  return {
    ...(metadata ?? {}),
    waifuChatOwnerWallet: access.walletAddress.toLowerCase(),
    waifuChatRole: access.role,
  };
}

function canWaifuAccessConversation(
  access: WaifuChatAccess | null,
  conv: ConversationMeta,
): boolean {
  if (!access || access.role === "admin") return true;
  return getWaifuChatOwnerWallet(conv) === access.walletAddress.toLowerCase();
}

function rejectWaifuConversationAccessIfNeeded(
  req: http.IncomingMessage,
  conv: ConversationMeta,
  error: ConversationRouteContext["error"],
  res: http.ServerResponse,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (canWaifuAccessConversation(access, conv)) return false;
  error(res, "Conversation not found", 404);
  return true;
}

function rejectWaifuNonAdminMutationIfNeeded(
  req: http.IncomingMessage,
  error: ConversationRouteContext["error"],
  res: http.ServerResponse,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (!access || access.role === "admin") return false;
  error(res, "Forbidden", 403);
  return true;
}

async function ensureWorldOwnershipAndRoles(
  runtime: AgentRuntime,
  worldId: UUID,
  ownerId: UUID,
  callerId: UUID,
  callerRole: WaifuChatWorldRole,
  callerGrantSource: RoleGrantSource,
  assertCurrent?: () => void,
): Promise<void> {
  const world = await runtime.getWorld(worldId);
  assertCurrent?.();
  if (!world) {
    throw new ElizaError(
      "Conversation world is missing after connection initialization",
      {
        code: "CONVERSATION_WORLD_MISSING",
        context: {
          agentId: runtime.agentId,
          worldId,
          ownerId,
          callerId,
        },
        severity: "fatal",
      },
    );
  }
  let needsUpdate = false;
  if (!world.metadata) {
    world.metadata = {};
    needsUpdate = true;
  }
  if (
    !world.metadata.ownership ||
    typeof world.metadata.ownership !== "object" ||
    (world.metadata.ownership as { ownerId?: string }).ownerId !== ownerId
  ) {
    world.metadata.ownership = { ownerId };
    needsUpdate = true;
  }
  // #12087 Item 11: route role writes through the auditable grant helpers so each
  // grant pairs roles[id] with a roleSources[id] entry (the #9948 invariant),
  // instead of mutating metadata.roles directly with raw literals. The owner grant
  // is recorded as source "owner"; the caller's connector-derived role is recorded
  // as "connector_admin" (revocable/demotable), and never overwrites the owner's
  // grant when the caller IS the owner.
  const metadata = world.metadata as RolesWorldMetadata;
  if (recordOwnerGrant(metadata, ownerId)) {
    needsUpdate = true;
  }
  if (callerId !== ownerId) {
    if (callerGrantSource === "session") {
      // Session-sourced grants mirror grantSessionUserWorldRole in
      // chat-routes.ts: clamped to the session's boundary role and never
      // downgrading an existing USER-or-higher grant (e.g. a manual ADMIN
      // grant by the owner).
      if (
        !hasAtLeastRole(getEntityRole(metadata, callerId), callerRole) &&
        recordRoleGrant(metadata, callerId, callerRole, "session")
      ) {
        needsUpdate = true;
      }
    } else if (
      recordRoleGrant(metadata, callerId, callerRole, callerGrantSource)
    ) {
      needsUpdate = true;
    }
  }
  if (needsUpdate) {
    assertCurrent?.();
    await runtime.updateWorld(world);
    assertCurrent?.();
  }
}

type PersistedAssistantMemory = Memory & { id: UUID };

function findPersistedGeneratedAssistantTurn(
  runtime: AgentRuntime,
  roomId: UUID,
  result: ChatGenerationResult,
): PersistedAssistantMemory | null {
  if (
    !Array.isArray(result.persistedResponseMessageIds) ||
    !Array.isArray(result.responseMessages)
  ) {
    return null;
  }
  const persistedIds = new Set(result.persistedResponseMessageIds);
  const candidate = result.responseMessages.at(-1);
  if (
    typeof candidate?.id !== "string" ||
    candidate.id.length === 0 ||
    !persistedIds.has(candidate.id) ||
    candidate.entityId !== runtime.agentId ||
    candidate.agentId !== runtime.agentId ||
    candidate.roomId !== roomId
  ) {
    return null;
  }
  return { ...candidate, id: candidate.id as UUID };
}

class AssistantReplyPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AssistantReplyPersistenceError";
  }
}

async function resolvePersistedAssistantTurn(
  runtime: AgentRuntime,
  roomId: UUID,
  turnStartedAt: number,
  result: ChatGenerationResult,
  text: string,
  channelType: ChannelType,
  roomHandlerLease: RoomHandlerLease,
  userMessageId?: UUID,
  assertCurrent?: () => void,
): Promise<
  | { kind: "durable"; id: UUID; text: string }
  | { kind: "ephemeral"; text: string }
> {
  const generatedTurn = findPersistedGeneratedAssistantTurn(
    runtime,
    roomId,
    result,
  );
  if (generatedTurn) {
    const generatedText =
      typeof generatedTurn.content.text === "string"
        ? generatedTurn.content.text
        : "";
    const persistedContent = buildPersistedAssistantContent(
      text,
      result,
      userMessageId,
    );
    const generatedTerminalFailure = parseChatTerminalFailure(
      generatedTurn.content.terminalFailure,
    );
    const terminalFailureNeedsReconciliation =
      result.terminalFailure !== undefined &&
      (generatedTerminalFailure?.kind !== result.terminalFailure.kind ||
        generatedTerminalFailure?.message !== result.terminalFailure.message ||
        generatedTerminalFailure?.transient !==
          result.terminalFailure.transient ||
        generatedTerminalFailure?.code !== result.terminalFailure.code);
    if (
      generatedText !== text ||
      (userMessageId !== undefined &&
        generatedTurn.content.inReplyTo !== userMessageId) ||
      terminalFailureNeedsReconciliation
    ) {
      try {
        await runtime.roomHandlerQueue.runInLease(
          roomId,
          roomHandlerLease,
          () => {
            assertCurrent?.();
            return runtime.updateMemory({
              ...generatedTurn,
              content: persistedContent,
            });
          },
        );
        assertCurrent?.();
      } catch (cause) {
        throw new AssistantReplyPersistenceError(
          "Failed to reconcile the persisted assistant reply",
          cause,
        );
      }
    }
    return { kind: "durable", id: generatedTurn.id as UUID, text };
  }

  const content = buildPersistedAssistantContent(text, result, userMessageId);
  if (
    shouldSkipResponseMemoryPersistence({
      content,
      roomId,
      entityId: runtime.agentId,
    } as Memory)
  ) {
    return { kind: "ephemeral", text };
  }

  let persisted: Memory | null;
  try {
    persisted = await persistAssistantConversationMemory(
      runtime,
      roomId,
      content,
      channelType,
      turnStartedAt,
      crypto.randomUUID() as UUID,
      roomHandlerLease,
      assertCurrent,
    );
  } catch (cause) {
    // error-policy:J2 attach the durable-turn boundary before the route
    // translates this into a terminal SSE error.
    throw new AssistantReplyPersistenceError(
      "Failed to persist the assistant reply",
      cause,
    );
  }
  if (!persisted?.id) {
    throw new AssistantReplyPersistenceError(
      "Assistant reply persistence returned no durable message id",
    );
  }
  return { kind: "durable", id: persisted.id as UUID, text };
}

function markConversationDeleted(
  state: ConversationRouteState,
  conversationId: string,
): void {
  const normalizedId = conversationId.trim();
  if (!normalizedId) return;
  if (state.deletedConversationIds.has(normalizedId)) return;

  state.deletedConversationIds.add(normalizedId);
  while (state.deletedConversationIds.size > MAX_DELETED_CONVERSATION_IDS) {
    const oldest = state.deletedConversationIds.values().next().value;
    if (!oldest) break;
    state.deletedConversationIds.delete(oldest);
  }

  persistDeletedConversationIdsToState(state.deletedConversationIds);
}

async function deleteConversationRoomData(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<void> {
  await serializeConversationConnectionRoomDeletion(
    runtime,
    roomId,
    async () => {
      const runtimeWithDelete = runtime as AgentRuntime & {
        deleteRoom?: (id: UUID) => Promise<unknown>;
        adapter?: {
          db?: {
            deleteRoom?: (id: UUID) => Promise<unknown>;
          };
        };
      };

      if (typeof runtimeWithDelete.deleteRoom === "function") {
        await runtimeWithDelete.deleteRoom(roomId);
        return;
      }

      const dbDeleteRoom = runtimeWithDelete.adapter.db.deleteRoom;
      if (typeof dbDeleteRoom === "function") {
        await dbDeleteRoom.call(runtimeWithDelete.adapter.db, roomId);
      }
    },
  );
}

function captureConversationConnection(
  state: ConversationRouteState,
  runtime: AgentRuntime,
  conv: ConversationMeta,
  caller: ConversationCaller,
  requestFence?: () => void,
): ConversationConnectionDescriptor {
  const agentName = runtime.character.name ?? "Eliza";
  const ownerId = ensureAdminEntityIdForRuntime(state, runtime);
  const worldId = stringToUuid(`${agentName}-web-chat-world`);
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
  return captureConversationConnectionDescriptor({
    runtime,
    conversationId: conv.id,
    roomId: conv.roomId,
    agentName,
    worldId,
    messageServerId,
    channelId: `web-conv-${conv.id}`,
    ownerId,
    callerEntityId: caller.entityId,
    callerRole: caller.role,
    callerGrantSource: caller.grantSource,
    callerUserName: caller.userName,
    requestFence,
  });
}

async function establishConversationConnection(
  descriptor: ConversationConnectionDescriptor,
): Promise<void> {
  await descriptor.runtime.ensureConnection({
    entityId: descriptor.callerEntityId,
    roomId: descriptor.roomId,
    worldId: descriptor.worldId,
    userName: descriptor.callerUserName,
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: descriptor.channelId,
    type: ChannelType.DM,
    messageServerId: descriptor.messageServerId,
    metadata: {
      ownership: { ownerId: descriptor.ownerId },
      waifuRole: descriptor.callerRole,
    },
  });
  descriptor.requestFence?.();
  await ensureWorldOwnershipAndRoles(
    descriptor.runtime,
    descriptor.worldId,
    descriptor.ownerId,
    descriptor.callerEntityId,
    descriptor.callerRole,
    descriptor.callerGrantSource,
    descriptor.requestFence,
  );
  descriptor.requestFence?.();
}

/**
 * Exported for the machine-session conversation-attribution regression suite;
 * runtime callers are the conversation route handlers in this module.
 */
export async function ensureConversationRoom(
  state: ConversationRouteState,
  runtime: AgentRuntime,
  conv: ConversationMeta,
  caller: ConversationCaller,
): Promise<ConversationConnectionDescriptor> {
  const descriptor = captureConversationConnection(
    state,
    runtime,
    conv,
    caller,
  );
  await scheduleConversationConnectionEnsure(descriptor, () =>
    establishConversationConnection(descriptor),
  );
  assertConversationConnectionRuntime(state.runtime, descriptor);
  return descriptor;
}

async function syncConversationRoomState(
  state: ConversationRouteState,
  conv: ConversationMeta,
): Promise<void> {
  if (!state.runtime) return;
  const runtime = state.runtime;
  const room = await runtime.getRoom(conv.roomId);
  if (!room) return;

  const ownerId = ensureAdminEntityId(state);
  const nextMetadata = buildConversationRoomMetadata(
    conv,
    ownerId,
    room.metadata,
  );
  const nextName = conv.title;
  const metadataChanged =
    JSON.stringify(room.metadata ?? null) !== JSON.stringify(nextMetadata);

  if (room.name === nextName && !metadataChanged) {
    return;
  }

  const adapter = runtime.adapter as {
    updateRoom?: (nextRoom: typeof room) => Promise<void>;
  };
  if (typeof adapter.updateRoom !== "function") {
    return;
  }

  await adapter.updateRoom({
    ...room,
    name: nextName,
    metadata: nextMetadata,
  });
}

async function waitForConversationRestore(
  state: ConversationRouteState,
): Promise<void> {
  const pending = state.conversationRestorePromise;
  if (!pending) return;
  await pending;
}

export function normalizeActionCallbackHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    if (history.at(-1) === normalized) {
      continue;
    }
    history.push(normalized);
  }

  return history;
}

function mergeActionCallbackHistory(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return normalizeActionCallbackHistory([...existing, ...incoming]);
}

export function formatConversationMessageText(
  text: string,
  actionCallbackHistory: readonly string[] = [],
): string {
  const history = normalizeActionCallbackHistory(actionCallbackHistory);
  if (history.length === 0) {
    return text;
  }

  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    return text;
  }

  return history.join("\n");
}

export function buildPersistedAssistantContent(
  text: string,
  result:
    | {
        actionCallbackHistory?: string[];
        responseContent?: Content | null;
        responseMessages?: Array<{ id?: string; content?: Content }>;
        transcriptVisibility?: "internal";
      }
    | null
    | undefined,
  userMessageId?: UUID,
): Content {
  const responseContent =
    result?.responseContent && typeof result.responseContent === "object"
      ? result.responseContent
      : null;
  const responseMessageContent = Array.isArray(result?.responseMessages)
    ? (result.responseMessages
        .map((entry) =>
          entry.content && typeof entry.content === "object"
            ? entry.content
            : null,
        )
        .filter((content): content is Content => content !== null)
        .at(-1) ?? null)
    : null;
  const actionCallbackHistory = normalizeActionCallbackHistory(
    result?.actionCallbackHistory,
  );
  const transcriptVisibility =
    result?.transcriptVisibility === "internal"
      ? ("internal" as const)
      : undefined;
  const persistedResponseMessageContent = responseMessageContent
    ? { ...responseMessageContent }
    : {};
  const persistedResponseContent = responseContent
    ? { ...responseContent }
    : {};
  delete persistedResponseMessageContent.transcriptVisibility;
  delete persistedResponseContent.transcriptVisibility;
  const inReplyTo =
    userMessageId ??
    persistedResponseContent.inReplyTo ??
    persistedResponseMessageContent.inReplyTo ??
    undefined;

  return responseContent || responseMessageContent
    ? {
        ...persistedResponseMessageContent,
        ...persistedResponseContent,
        text,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(transcriptVisibility ? { transcriptVisibility } : {}),
        ...(actionCallbackHistory.length > 0 ? { actionCallbackHistory } : {}),
      }
    : {
        text,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(transcriptVisibility ? { transcriptVisibility } : {}),
        ...(actionCallbackHistory.length > 0 ? { actionCallbackHistory } : {}),
      };
}

function conversationClientUserMemoryId(
  scope: string,
  clientMessageId: string,
): UUID {
  return stringToUuid(`conversation-user:${scope}:${clientMessageId}`) as UUID;
}

interface DurableConversationChatMarker {
  version: 1;
  scope: string;
  clientMessageId: string;
  fingerprint: string;
  outcomeJson?: string;
  /** Private evidence owned by this exact user turn, never a public outcome. */
  replyRecoveryJson?: string;
}

type DurableConversationReplyRecovery = NonNullable<
  ChatGenerationResult["replyRecovery"]
> & {
  assistantMessageId: UUID;
  userContentHash: string;
  assistantContentHash: string;
  /** Prepared before updating the assistant row so a restart reuses this prose. */
  reply?: { text: string; effectReceiptIds: string[]; contentHash: string };
};

function conversationReplyContentHash(content: Content): string {
  const request = { ...content };
  delete request.chatIdempotency;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalChatFingerprintValue(request)))
    .digest("hex");
}

/** A grounded successful reply replaces only the original failure markers. */
function clearRecoveredReplyFailureMarkers<T extends object>(record: T): T {
  const recovered = { ...record } as T & Record<string, unknown>;
  for (const key of ["elizaSyntheticFailure", "syntheticChatFailure"] as const)
    if (recovered[key] === true) delete recovered[key];
  for (const key of ["failureKind", "chatFailureKind"] as const)
    if (
      isChatFailureKind(recovered[key]) ||
      recovered[key] === "no_response" ||
      recovered[key] === "transient_failure"
    )
      delete recovered[key];
  return recovered;
}

function parseDurableConversationReplyRecovery(
  serialized: string,
): DurableConversationReplyRecovery | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !validateUuid(value.assistantMessageId) ||
      typeof value.userContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.userContentHash) ||
      typeof value.assistantContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.assistantContentHash) ||
      typeof value.context !== "string" ||
      !value.context.trim() ||
      !Array.isArray(value.pendingToolCalls) ||
      !Array.isArray(value.evaluatorOutputs) ||
      typeof value.ownerExclusiveDisclosureUsed !== "boolean" ||
      !Array.isArray(value.actionResults) ||
      value.actionResults.length === 0
    )
      return null;
    for (const result of value.actionResults) {
      if (
        !isRecord(result) ||
        typeof result.success !== "boolean" ||
        (result.text !== undefined && typeof result.text !== "string") ||
        (result.error !== undefined && typeof result.error !== "string") ||
        (result.data !== undefined && !isRecord(result.data)) ||
        (result.values !== undefined && !isRecord(result.values))
      )
        return null;
      if (result.effectReceipts !== undefined)
        result.effectReceipts = normalizeEffectReceipts(result.effectReceipts);
      if (result.replyFailure !== undefined)
        result.replyFailure = normalizeActionReplyFailure(result.replyFailure);
      if (result.failureProvenance !== undefined)
        result.failureProvenance = normalizeActionFailureProvenance(
          result.failureProvenance,
        );
      if (result.success && result.failureProvenance !== undefined) return null;
    }
    if (
      value.reply !== undefined &&
      (!isRecord(value.reply) ||
        typeof value.reply.text !== "string" ||
        !value.reply.text.trim() ||
        typeof value.reply.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.reply.contentHash) ||
        !Array.isArray(value.reply.effectReceiptIds) ||
        !value.reply.effectReceiptIds.every(
          (id) => typeof id === "string" && id.length > 0,
        ))
    )
      return null;
    return {
      context: value.context,
      pendingToolCalls: value.pendingToolCalls,
      evaluatorOutputs: value.evaluatorOutputs,
      ownerExclusiveDisclosureUsed: value.ownerExclusiveDisclosureUsed,
      actionResults: value.actionResults as ActionResult[],
      assistantMessageId: value.assistantMessageId as UUID,
      userContentHash: value.userContentHash,
      assistantContentHash: value.assistantContentHash,
      ...(value.reply !== undefined
        ? {
            reply: value.reply as NonNullable<
              DurableConversationReplyRecovery["reply"]
            >,
          }
        : {}),
    };
  } catch {
    // error-policy:J3 malformed persisted evidence never authorizes recovery.
    return null;
  }
}

function conversationReplyRecoveryIsEligible(
  recovery: DurableConversationReplyRecovery,
): boolean {
  const receipts = mergeEffectReceipts(
    ...recovery.actionResults.map((result) => result.effectReceipts),
  );
  const unknownCommit =
    recovery.actionResults.some(
      (result) =>
        result.data?.reconciliationRequired === true ||
        result.data?.committed === "unknown" ||
        result.values?.committed === "unknown",
    ) ||
    receipts.some(
      (receipt) =>
        receipt.outcome === "failed" &&
        receipt.failure.acceptance === "unknown",
    );
  return (
    !unknownCommit &&
    receipts.some(
      (receipt) =>
        resolveAppliedUserFacingEffectReceipts(
          {
            verifiedUserFacing: true,
            userFacingText: "Receipt eligibility",
            userFacingEffectReceiptIds: [receipt.receiptId],
          },
          receipts,
        ) !== null,
    )
  );
}

async function persistConversationReplyRecovery(
  runtime: AgentRuntime,
  roomId: UUID,
  userMessageId: UUID | undefined,
  assistantMessageId: UUID | undefined,
  result: ChatGenerationResult,
  lease: RoomHandlerLease,
  assertCurrent?: () => void,
): Promise<boolean> {
  if (!result.replyRecovery || !userMessageId || !assistantMessageId)
    return false;
  try {
    const [user] = await runtime.getMemoriesByIds([userMessageId], "messages");
    assertCurrent?.();
    const marker = readDurableConversationChatMarker(
      user?.content.chatIdempotency,
    );
    if (
      !user ||
      user.roomId !== roomId ||
      !marker ||
      conversationClientUserMemoryId(marker.scope, marker.clientMessageId) !==
        userMessageId
    )
      return false;
    const [assistant] = await runtime.getMemoriesByIds(
      [assistantMessageId],
      "messages",
    );
    if (
      !assistant ||
      assistant.roomId !== roomId ||
      assistant.entityId !== runtime.agentId ||
      assistant.agentId !== runtime.agentId ||
      assistant.content.inReplyTo !== userMessageId
    )
      throw new TypeError(
        "Reply recovery assistant does not match the original turn",
      );
    const projected = projectCompleteToolValueForModel(
      {
        ...result.replyRecovery,
        assistantMessageId,
        userContentHash: conversationReplyContentHash(user.content),
        assistantContentHash: conversationReplyContentHash({
          ...assistant.content,
          replyRecoveryAvailable: true,
        }),
        actionResults: result.replyRecovery.actionResults.map((action) => ({
          ...action,
          ...(action.error instanceof Error
            ? { error: action.error.stack ?? action.error.message }
            : {}),
        })),
      },
      composeToolDiagnosticRedactor(runtime),
    );
    const serialized = JSON.stringify(projected, (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new TypeError(
          "Reply recovery evidence contains a non-finite number",
        );
      if (
        typeof value === "bigint" ||
        typeof value === "function" ||
        typeof value === "symbol"
      )
        throw new TypeError("Reply recovery evidence is not JSON serializable");
      return value;
    });
    const recovery = parseDurableConversationReplyRecovery(serialized);
    if (!recovery) throw new TypeError("Reply recovery evidence is invalid");
    await runtime.roomHandlerQueue.runInLease(roomId, lease, () => {
      assertCurrent?.();
      return runtime.updateMemory({
        id: userMessageId,
        content: {
          ...user.content,
          chatIdempotency: { ...marker, replyRecoveryJson: serialized },
        },
      });
    });
    assertCurrent?.();
    if (!conversationReplyRecoveryIsEligible(recovery)) return false;
    await runtime.roomHandlerQueue.runInLease(roomId, lease, () => {
      assertCurrent?.();
      return runtime.updateMemory({
        id: assistantMessageId,
        content: { ...assistant.content, replyRecoveryAvailable: true },
      });
    });
    assertCurrent?.();
    return true;
  } catch (cause) {
    // error-policy:J4 the original non-replayable failure remains visible when
    // complete recovery evidence cannot be durably retained.
    runtime.reportError("Conversation.replyRecoveryPersistence", cause, {
      roomId,
      userMessageId,
      assistantMessageId,
    });
    return false;
  }
}

type DurableConversationChatRecovery =
  | { kind: "none" }
  | { kind: "conflict"; error: ElizaError }
  | { kind: "settled"; outcome: ChatMessageIdOutcome };

const INCOMPLETE_CHAT_RECOVERY_TEXT =
  "The previous attempt ended before its final response was saved. It was not run again; send a new message if you want to retry.";
const MAX_DURABLE_CHAT_OUTCOME_BYTES = 256 * 1024;
const DURABLE_CHAT_OUTCOME_KEYS = new Set([
  "text",
  "agentName",
  "messageId",
  "userMessageId",
  "assistantEphemeral",
  "historyRefreshRequired",
  "transcriptVisibility",
  "thought",
  "usage",
  "actionResults",
  "failureKind",
  "terminalFailure",
  "accountConnect",
  "localInference",
  "noResponseReason",
  "interrupted",
  "replyRecoveryAvailable",
]);

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === "string" &&
    Object.values(ChannelType).includes(value as ChannelType)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDurableChatUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const numericFields = [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "llmCalls",
  ] as const;
  if (
    numericFields.some(
      (field) =>
        typeof value[field] !== "number" ||
        !Number.isFinite(value[field] as number),
    ) ||
    typeof value.isEstimated !== "boolean"
  ) {
    return false;
  }
  for (const field of [
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "cachedInputTokens",
  ] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "number" ||
        !Number.isFinite(value[field] as number))
    ) {
      return false;
    }
  }
  return (
    (value.model === undefined || typeof value.model === "string") &&
    (value.provider === undefined || typeof value.provider === "string")
  );
}

function isDurableChatActionResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.success !== "boolean") return false;
  return (
    (value.actionName === undefined || typeof value.actionName === "string") &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.values === undefined || isRecord(value.values))
  );
}

function parseDurableConversationChatOutcome(
  serialized: string,
): ChatMessageIdOutcome | null {
  if (
    serialized.length === 0 ||
    Buffer.byteLength(serialized, "utf8") > MAX_DURABLE_CHAT_OUTCOME_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    // error-policy:J3 persisted markers are untrusted storage input.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const outcome = parsed as Record<string, unknown>;
  if (Object.keys(outcome).some((key) => !DURABLE_CHAT_OUTCOME_KEYS.has(key))) {
    return null;
  }
  if (
    typeof outcome.text !== "string" ||
    typeof outcome.agentName !== "string"
  ) {
    return null;
  }
  if (
    (outcome.messageId !== undefined && !validateUuid(outcome.messageId)) ||
    (outcome.userMessageId !== undefined &&
      !validateUuid(outcome.userMessageId)) ||
    (outcome.assistantEphemeral !== undefined &&
      typeof outcome.assistantEphemeral !== "boolean") ||
    (outcome.historyRefreshRequired !== undefined &&
      typeof outcome.historyRefreshRequired !== "boolean") ||
    (outcome.transcriptVisibility !== undefined &&
      outcome.transcriptVisibility !== "internal") ||
    (outcome.thought !== undefined && typeof outcome.thought !== "string") ||
    (outcome.usage !== undefined && !isDurableChatUsage(outcome.usage)) ||
    (outcome.actionResults !== undefined &&
      (!Array.isArray(outcome.actionResults) ||
        !outcome.actionResults.every(isDurableChatActionResult))) ||
    (outcome.failureKind !== undefined &&
      !isChatFailureKind(outcome.failureKind)) ||
    (outcome.terminalFailure !== undefined &&
      parseChatTerminalFailure(outcome.terminalFailure) === undefined) ||
    (outcome.accountConnect !== undefined &&
      normalizeAccountConnectRequest(outcome.accountConnect) === null) ||
    (outcome.localInference !== undefined &&
      !isRecord(outcome.localInference)) ||
    (outcome.noResponseReason !== undefined &&
      outcome.noResponseReason !== "ignored") ||
    (outcome.interrupted !== undefined &&
      typeof outcome.interrupted !== "boolean") ||
    (outcome.replyRecoveryAvailable !== undefined &&
      outcome.replyRecoveryAvailable !== true)
  ) {
    return null;
  }
  const accountConnect =
    outcome.accountConnect === undefined
      ? undefined
      : normalizeAccountConnectRequest(outcome.accountConnect);
  const terminalFailure = parseChatTerminalFailure(outcome.terminalFailure);
  return {
    text: outcome.text,
    agentName: outcome.agentName,
    ...(typeof outcome.messageId === "string"
      ? { messageId: outcome.messageId as UUID }
      : {}),
    ...(typeof outcome.userMessageId === "string"
      ? { userMessageId: outcome.userMessageId as UUID }
      : {}),
    ...(typeof outcome.assistantEphemeral === "boolean"
      ? { assistantEphemeral: outcome.assistantEphemeral }
      : {}),
    ...(typeof outcome.historyRefreshRequired === "boolean"
      ? { historyRefreshRequired: outcome.historyRefreshRequired }
      : {}),
    ...(outcome.transcriptVisibility === "internal"
      ? { transcriptVisibility: "internal" as const }
      : {}),
    ...(typeof outcome.thought === "string"
      ? { thought: outcome.thought }
      : {}),
    ...(outcome.usage !== undefined
      ? { usage: outcome.usage as NonNullable<ChatMessageIdOutcome["usage"]> }
      : {}),
    ...(outcome.actionResults !== undefined
      ? {
          actionResults: outcome.actionResults as NonNullable<
            ChatMessageIdOutcome["actionResults"]
          >,
        }
      : {}),
    ...(typeof outcome.failureKind === "string"
      ? { failureKind: outcome.failureKind as ChatFailureKind }
      : {}),
    ...(terminalFailure ? { terminalFailure } : {}),
    ...(accountConnect ? { accountConnect } : {}),
    ...(outcome.localInference !== undefined
      ? {
          localInference: outcome.localInference as NonNullable<
            ChatMessageIdOutcome["localInference"]
          >,
        }
      : {}),
    ...(outcome.noResponseReason === "ignored"
      ? { noResponseReason: "ignored" as const }
      : {}),
    ...(outcome.interrupted === true ? { interrupted: true } : {}),
    ...(outcome.replyRecoveryAvailable === true
      ? { replyRecoveryAvailable: true as const }
      : {}),
  };
}

function readDurableConversationChatMarker(
  value: unknown,
): DurableConversationChatMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.scope !== "string" ||
    record.scope.length === 0 ||
    typeof record.clientMessageId !== "string" ||
    normalizeClientMessageId(record.clientMessageId) !==
      record.clientMessageId ||
    typeof record.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    (record.outcomeJson !== undefined &&
      typeof record.outcomeJson !== "string") ||
    (record.replyRecoveryJson !== undefined &&
      typeof record.replyRecoveryJson !== "string")
  ) {
    return null;
  }
  return {
    version: 1,
    scope: record.scope,
    clientMessageId: record.clientMessageId,
    fingerprint: record.fingerprint,
    ...(typeof record.outcomeJson === "string"
      ? { outcomeJson: record.outcomeJson }
      : {}),
    ...(typeof record.replyRecoveryJson === "string"
      ? { replyRecoveryJson: record.replyRecoveryJson }
      : {}),
  };
}

function buildRecoveredConversationChatOutcome(
  memory: Memory & { id: UUID },
  userMessageId: UUID,
  agentName: string,
): ChatMessageIdOutcome {
  const content = memory.content as Content;
  const failureKind = parseChatFailureKind(content.failureKind);
  const terminalFailure = parseChatTerminalFailure(content.terminalFailure);
  const accountConnect = normalizeAccountConnectRequest(content.accountConnect);
  const localInference =
    content.localInference && typeof content.localInference === "object"
      ? (content.localInference as ChatMessageIdOutcome["localInference"])
      : undefined;
  return {
    text: typeof content.text === "string" ? content.text : "",
    agentName,
    messageId: memory.id,
    userMessageId,
    ...(content.transcriptVisibility === "internal"
      ? { transcriptVisibility: "internal" as const }
      : {}),
    ...(typeof content.thought === "string" && content.thought.trim()
      ? { thought: content.thought }
      : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(terminalFailure ? { terminalFailure } : {}),
    ...(accountConnect ? { accountConnect } : {}),
    ...(localInference ? { localInference } : {}),
    ...(normalizeActionCallbackHistory(content.actionCallbackHistory).length > 0
      ? { historyRefreshRequired: true }
      : {}),
    ...(content.noResponseReason === "ignored"
      ? { noResponseReason: "ignored" as const }
      : {}),
    ...(content.interrupted === true ? { interrupted: true } : {}),
    ...(content.replyRecoveryAvailable === true
      ? { replyRecoveryAvailable: true as const }
      : {}),
  };
}

async function persistDurableConversationChatOutcome(
  runtime: AgentRuntime,
  roomId: UUID,
  scope: string,
  clientMessageId: string | null | undefined,
  fingerprint: string,
  outcome: ChatMessageIdOutcome,
  roomHandlerLease: RoomHandlerLease,
  assertCurrent?: () => void,
): Promise<void> {
  if (!clientMessageId) return;
  const userMessageId = conversationClientUserMemoryId(scope, clientMessageId);
  const [userMemory] = await runtime.getMemoriesByIds(
    [userMessageId],
    "messages",
  );
  assertCurrent?.();
  if (!userMemory || userMemory.roomId !== roomId) {
    throw new ElizaError("Durable chat outcome has no matching user message", {
      code: "CHAT_IDEMPOTENCY_USER_MEMORY_MISSING",
      context: { roomId, userMessageId, clientMessageId },
    });
  }
  const existingMarker = readDurableConversationChatMarker(
    userMemory.content.chatIdempotency,
  );
  if (
    !existingMarker ||
    existingMarker.scope !== scope ||
    existingMarker.clientMessageId !== clientMessageId ||
    existingMarker.fingerprint !== fingerprint
  ) {
    throw new ElizaError(
      "Durable chat outcome does not match its original turn",
      {
        code: "CHAT_IDEMPOTENCY_CONFLICT",
        context: { roomId, userMessageId },
      },
    );
  }
  await runtime.roomHandlerQueue.runInLease(roomId, roomHandlerLease, () => {
    assertCurrent?.();
    return runtime.updateMemory({
      id: userMessageId,
      content: {
        ...userMemory.content,
        chatIdempotency: {
          ...existingMarker,
          version: 1,
          scope,
          clientMessageId,
          fingerprint,
          outcomeJson: JSON.stringify(outcome),
        } satisfies DurableConversationChatMarker,
      },
    });
  });
  assertCurrent?.();
}

async function recoverDurableConversationChatOutcome(
  runtime: AgentRuntime,
  roomId: UUID,
  scope: string,
  clientMessageId: string | null | undefined,
  fingerprint: string,
  agentName: string,
  roomHandlerLease: RoomHandlerLease,
  assertCurrent?: () => void,
): Promise<DurableConversationChatRecovery> {
  if (!clientMessageId) return { kind: "none" };
  const userMessageId = conversationClientUserMemoryId(scope, clientMessageId);
  const [userMemory] = await runtime.getMemoriesByIds(
    [userMessageId],
    "messages",
  );
  assertCurrent?.();
  if (!userMemory) return { kind: "none" };
  if (userMemory.roomId !== roomId) {
    return {
      kind: "conflict",
      error: new ElizaError("Idempotency user memory belongs to another room", {
        code: "CHAT_IDEMPOTENCY_CONFLICT",
        context: { roomId, userMessageId, actualRoomId: userMemory.roomId },
      }),
    };
  }
  const marker = readDurableConversationChatMarker(
    userMemory.content.chatIdempotency,
  );
  if (
    !marker ||
    marker.scope !== scope ||
    marker.clientMessageId !== clientMessageId ||
    marker.fingerprint !== fingerprint
  ) {
    return {
      kind: "conflict",
      error: new ElizaError(
        "Idempotency key was reused for a different durable chat request",
        {
          code: "CHAT_IDEMPOTENCY_CONFLICT",
          context: { roomId, userMessageId, clientMessageId },
        },
      ),
    };
  }
  if (marker.outcomeJson !== undefined) {
    const outcome = parseDurableConversationChatOutcome(marker.outcomeJson);
    if (!outcome) {
      return {
        kind: "conflict",
        error: new ElizaError("Durable chat outcome is invalid", {
          code: "CHAT_IDEMPOTENCY_OUTCOME_INVALID",
          context: { roomId, userMessageId, clientMessageId },
        }),
      };
    }
    return { kind: "settled", outcome };
  }

  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    start: userMemory.createdAt,
    orderBy: "createdAt",
    orderDirection: "asc",
  });
  assertCurrent?.();
  const transformedUserMessageId = createUniqueUuid(runtime, userMessageId);
  const assistant = memories
    .filter(
      (memory): memory is Memory & { id: UUID } =>
        typeof memory.id === "string" &&
        memory.entityId === runtime.agentId &&
        memory.agentId === runtime.agentId &&
        (memory.content.inReplyTo === userMessageId ||
          memory.content.inReplyTo === transformedUserMessageId),
    )
    .at(-1);
  if (!assistant) {
    const channelType = userMemory.content.channelType;
    if (!isChannelType(channelType)) {
      return {
        kind: "conflict",
        error: new ElizaError(
          "Incomplete durable chat request has no valid channel type",
          {
            code: "CHAT_IDEMPOTENCY_INCOMPLETE_INVALID",
            context: { roomId, userMessageId, clientMessageId, channelType },
          },
        ),
      };
    }
    const recoveryMessageId = stringToUuid(
      `conversation-incomplete-recovery:${userMessageId}`,
    ) as UUID;
    assertCurrent?.();
    const persisted = await persistAssistantConversationMemory(
      runtime,
      roomId,
      {
        text: INCOMPLETE_CHAT_RECOVERY_TEXT,
        inReplyTo: userMessageId,
        chatIdempotencyRecovery: "incomplete",
      },
      channelType,
      undefined,
      recoveryMessageId,
      roomHandlerLease,
      assertCurrent,
    );
    assertCurrent?.();
    if (!persisted?.id) {
      throw new ElizaError(
        "Failed to persist the incomplete chat recovery terminal",
        {
          code: "CHAT_IDEMPOTENCY_INCOMPLETE_WRITE_FAILED",
          context: { roomId, userMessageId, clientMessageId },
        },
      );
    }
    const outcome: ChatMessageIdOutcome = {
      text: INCOMPLETE_CHAT_RECOVERY_TEXT,
      agentName,
      messageId: persisted.id,
      userMessageId,
    };
    await persistDurableConversationChatOutcome(
      runtime,
      roomId,
      scope,
      clientMessageId,
      fingerprint,
      outcome,
      roomHandlerLease,
      assertCurrent,
    );
    return { kind: "settled", outcome };
  }
  if (assistant.content.inReplyTo !== userMessageId) {
    await runtime.roomHandlerQueue.runInLease(roomId, roomHandlerLease, () => {
      assertCurrent?.();
      return runtime.updateMemory({
        ...assistant,
        content: {
          ...assistant.content,
          inReplyTo: userMessageId,
        },
      });
    });
    assertCurrent?.();
    assistant.content = {
      ...assistant.content,
      inReplyTo: userMessageId,
    };
  }
  const outcome = buildRecoveredConversationChatOutcome(
    assistant,
    userMessageId,
    agentName,
  );
  await persistDurableConversationChatOutcome(
    runtime,
    roomId,
    scope,
    clientMessageId,
    fingerprint,
    outcome,
    roomHandlerLease,
    assertCurrent,
  );
  return { kind: "settled", outcome };
}

function bindClientUserMemoryId(
  clientMessageId: string | null | undefined,
  scope: string,
  fingerprint: string,
  messages: Awaited<ReturnType<typeof buildUserMessages>>,
): void {
  if (!clientMessageId) return;
  const id = conversationClientUserMemoryId(scope, clientMessageId);
  messages.userMessage.id = id;
  messages.messageToStore.id = id;
  const marker = {
    version: 1,
    scope,
    clientMessageId,
    fingerprint,
  } as const;
  messages.userMessage.content.chatIdempotency = marker;
  messages.messageToStore.content.chatIdempotency = marker;
}

async function persistClientUserMemory(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
  clientMessageId: string | null | undefined,
  roomHandlerLease: RoomHandlerLease,
  assertCurrent?: () => void,
): Promise<void> {
  if (!clientMessageId) {
    await persistConversationMemory(
      runtime,
      memory,
      roomHandlerLease,
      assertCurrent,
    );
    return;
  }
  await persistExactConversationMemory(
    runtime,
    memory,
    roomHandlerLease,
    assertCurrent,
  );
}

interface CanonicalPendantProvenance {
  ownerId: UUID;
  agentId: UUID;
  sessionId: string;
  segmentId: string;
  segmentRevision: number;
}

function readRequiredMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ElizaError(`Pendant transcript metadata is missing ${key}`, {
      code: "PENDANT_TRANSCRIPT_PROVENANCE_INVALID",
      context: { key },
    });
  }
  return value.trim();
}

export async function verifyCanonicalPendantProvenance(
  runtime: AgentRuntime,
  caller: { entityId: UUID; role: WaifuChatWorldRole },
  prompt: string,
  metadata: Record<string, unknown> | undefined,
  repository?: PendantSessionRepository,
): Promise<CanonicalPendantProvenance | null> {
  if (metadata?.voiceSource !== "pendant") return null;
  if (caller.role !== "OWNER") {
    throw new ElizaError(
      "Only the authenticated owner may submit a pendant transcript",
      {
        code: "PENDANT_TRANSCRIPT_OWNER_REQUIRED",
        context: { callerRole: caller.role },
      },
    );
  }

  const ownerId = readRequiredMetadataString(
    metadata,
    "pendantOwnerId",
  ) as UUID;
  const agentId = readRequiredMetadataString(
    metadata,
    "pendantAgentId",
  ) as UUID;
  const sessionId = readRequiredMetadataString(metadata, "pendantSessionId");
  const segmentId = readRequiredMetadataString(metadata, "pendantSegmentId");
  const segmentRevision = metadata.pendantSegmentRevision;
  if (!Number.isSafeInteger(segmentRevision) || Number(segmentRevision) < 0) {
    throw new ElizaError(
      "Pendant transcript metadata has an invalid segment revision",
      {
        code: "PENDANT_TRANSCRIPT_PROVENANCE_INVALID",
        context: { key: "pendantSegmentRevision" },
      },
    );
  }
  if (ownerId !== caller.entityId || agentId !== runtime.agentId) {
    throw new ElizaError(
      "Pendant transcript identity does not match the authenticated runtime",
      {
        code: "PENDANT_TRANSCRIPT_IDENTITY_MISMATCH",
        context: { ownerId, agentId },
      },
    );
  }

  const store = repository ?? createPendantSessionRepository(runtime);
  const stored = await store.load({
    ownerId,
    agentId,
    sessionId,
  });
  const segment = stored?.segments.find(
    (candidate) => candidate.id === segmentId,
  );
  if (
    !stored ||
    !segment ||
    segment.sessionId !== sessionId ||
    segment.status !== "resolved" ||
    segment.revision !== segmentRevision ||
    segment.text.trim() !== prompt.trim()
  ) {
    throw new ElizaError(
      "Pendant transcript does not match a canonical resolved segment",
      {
        code: "PENDANT_TRANSCRIPT_SEGMENT_MISMATCH",
        context: { sessionId, segmentId, segmentRevision },
      },
    );
  }

  return { ownerId, agentId, sessionId, segmentId, segmentRevision };
}

export function stampCanonicalPendantMemory(
  messages: Awaited<ReturnType<typeof buildUserMessages>>,
  provenance: CanonicalPendantProvenance,
): void {
  for (const memory of [messages.userMessage, messages.messageToStore]) {
    memory.metadata = {
      ...memory.metadata,
      type: "message",
      provider: "pendant",
      accountId: provenance.agentId,
      platformMessageId: provenance.segmentId,
      sourceId: provenance.segmentId,
      chatType: "dm",
      scope: "owner-private",
      scopedToEntityId: provenance.ownerId,
      addedBy: provenance.ownerId,
      addedByRole: "OWNER",
      base: {
        type: "message",
        source: "pendant",
        scope: "owner-private",
      },
      pendant: {
        userId: provenance.ownerId,
        accountId: provenance.agentId,
        messageId: provenance.segmentId,
        sessionId: provenance.sessionId,
        segmentId: provenance.segmentId,
        segmentRevision: provenance.segmentRevision,
      },
    };
  }
}

function writeConversationDoneSse(
  res: http.ServerResponse,
  outcome: ChatMessageIdOutcome,
): void {
  const { text, ...terminalMetadata } = outcome;
  writeSseJson(res, {
    ...terminalMetadata,
    type: "done",
    fullText: text,
  });
}

function buildGenerationMessageIdOutcome(
  result: ChatGenerationResult,
  text: string,
  messageId?: UUID,
  terminal?: Pick<
    ChatMessageIdOutcome,
    "userMessageId" | "assistantEphemeral" | "historyRefreshRequired"
  >,
): ChatMessageIdOutcome {
  return {
    text,
    agentName: result.agentName,
    ...(messageId ? { messageId } : {}),
    ...terminal,
    ...(result.transcriptVisibility
      ? { transcriptVisibility: result.transcriptVisibility }
      : {}),
    ...(result.thought ? { thought: result.thought } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.actionResults?.length
      ? { actionResults: result.actionResults }
      : {}),
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.terminalFailure
      ? { terminalFailure: result.terminalFailure }
      : {}),
    ...(result.accountConnect ? { accountConnect: result.accountConnect } : {}),
    ...(result.localInference ? { localInference: result.localInference } : {}),
    ...(result.noResponseReason
      ? { noResponseReason: result.noResponseReason }
      : {}),
  };
}

function buildConversationJsonOutcome(
  outcome: ChatMessageIdOutcome,
): ChatMessageIdOutcome {
  return {
    text: outcome.text,
    agentName: outcome.agentName,
    ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
    ...(outcome.userMessageId ? { userMessageId: outcome.userMessageId } : {}),
    ...(outcome.assistantEphemeral ? { assistantEphemeral: true } : {}),
    ...(outcome.historyRefreshRequired ? { historyRefreshRequired: true } : {}),
    ...(outcome.transcriptVisibility
      ? { transcriptVisibility: outcome.transcriptVisibility }
      : {}),
    ...(outcome.actionResults?.length
      ? { actionResults: outcome.actionResults }
      : {}),
    ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
    ...(outcome.terminalFailure
      ? { terminalFailure: outcome.terminalFailure }
      : {}),
    ...(outcome.replyRecoveryAvailable
      ? { replyRecoveryAvailable: true as const }
      : {}),
    ...(outcome.accountConnect
      ? { accountConnect: outcome.accountConnect }
      : {}),
    ...(outcome.localInference
      ? { localInference: outcome.localInference }
      : {}),
    ...(outcome.noResponseReason
      ? { noResponseReason: outcome.noResponseReason }
      : {}),
    ...(outcome.interrupted ? { interrupted: true } : {}),
  };
}

function isCallbackHistoryPersistenceError(
  error: unknown,
): error is ElizaError {
  return (
    error instanceof ElizaError &&
    error.code === "CONVERSATION_CALLBACK_HISTORY_WRITE_FAILED"
  );
}

export async function persistRecentAssistantActionCallbackHistory(
  runtime: AgentRuntime,
  roomId: UUID,
  actionCallbackHistory: readonly string[],
  sinceMs: number,
  targetMemoryId?: UUID,
  roomHandlerLease?: RoomHandlerLease,
  assertCurrent?: () => void,
): Promise<boolean> {
  const normalizedHistory = normalizeActionCallbackHistory(
    actionCallbackHistory,
  );
  if (normalizedHistory.length === 0) {
    return false;
  }

  const persist = async (): Promise<boolean> => {
    const recent = targetMemoryId
      ? await runtime.getMemoriesByIds([targetMemoryId], "messages")
      : await runtime.getMemories({
          roomId,
          tableName: "messages",
        });
    assertCurrent?.();

    const target = recent
      .filter(
        (memory) =>
          memory.roomId === roomId &&
          memory.agentId === runtime.agentId &&
          memory.entityId === runtime.agentId,
      )
      .filter((memory) => {
        const content = memory.content as { text?: unknown } | undefined;
        const createdAt = memory.createdAt ?? 0;
        return (
          typeof memory.id === "string" &&
          typeof content?.text === "string" &&
          content.text.trim().length > 0 &&
          (targetMemoryId
            ? memory.id === targetMemoryId
            : createdAt >= sinceMs - 2000)
        );
      })
      .sort(compareMemoriesByCreatedAt)
      .at(-1);

    if (!target || typeof target.id !== "string") {
      if (targetMemoryId) {
        throw new ElizaError(
          "Exact assistant memory for callback history was not found",
          {
            code: "CONVERSATION_CALLBACK_TARGET_NOT_FOUND",
            context: { roomId, targetMemoryId },
          },
        );
      }
      return false;
    }

    const content =
      target.content && typeof target.content === "object"
        ? (target.content as Content)
        : ({ text: "" } satisfies Content);
    const existingHistory = normalizeActionCallbackHistory(
      (content as Record<string, unknown>).actionCallbackHistory,
    );
    const mergedHistory = mergeActionCallbackHistory(
      existingHistory,
      normalizedHistory,
    );

    if (
      mergedHistory.length === existingHistory.length &&
      mergedHistory.every((entry, index) => entry === existingHistory[index])
    ) {
      return true;
    }

    assertCurrent?.();
    await runtime.updateMemory({
      id: target.id as UUID,
      content: {
        ...content,
        actionCallbackHistory: mergedHistory,
      } as Content,
    });
    assertCurrent?.();

    return true;
  };

  try {
    if (runtime.roomHandlerQueue.ownsLease(roomId, roomHandlerLease)) {
      return await runtime.roomHandlerQueue.runInLease(
        roomId,
        roomHandlerLease,
        persist,
      );
    }
    return await runtime.roomHandlerQueue.withLease(roomId, async (lease) =>
      runtime.roomHandlerQueue.runInLease(roomId, lease, persist),
    );
  } catch (cause) {
    throw new ElizaError("Failed to persist action callback history", {
      code: "CONVERSATION_CALLBACK_HISTORY_WRITE_FAILED",
      cause,
      context: { roomId, targetMemoryId },
    });
  }
}

async function getConversationWithRestore(
  state: ConversationRouteState,
  convId: string,
): Promise<ConversationMeta | undefined> {
  const existing = state.conversations.get(convId);
  if (existing) return existing;
  await waitForConversationRestore(state);
  return state.conversations.get(convId);
}

/** Default recent-window size for GET /messages (the newest N turns). */
const CONVERSATION_MESSAGE_WINDOW = 200;

/**
 * Default page size for the `?before=<cursor>` load-older path (infinite
 * upward scroll, #13532). Smaller than the initial recent window: each
 * scroll-up prepends one page, so a page that is quick to fetch and paint
 * keeps the prefetch ahead of the reader without a large single reflow.
 */
const CONVERSATION_OLDER_PAGE_SIZE = 50;

/**
 * How many messages on EACH side of an `?around=<id>` pivot to load. The
 * centered window is roughly 2× this plus the pivot itself.
 */
const CONVERSATION_AROUND_RADIUS = 100;

/**
 * Load a window of messages CENTERED on `aroundMessageId` for the jump-to-message
 * flow (#9955). The default GET /messages window is the most-recent
 * CONVERSATION_MESSAGE_WINDOW turns, so a keyword-search hit older than that is
 * never in the loaded thread and can't be scrolled to. Given the pivot's id this
 * returns the pivot's own turn plus up to CONVERSATION_AROUND_RADIUS older and
 * newer turns, ordered chronologically by the caller.
 *
 * Bounds are pushed into the store as getMemories `start`/`end` (createdAt
 * range) so there is NO in-process scan. Returns the recent window unchanged
 * when the pivot is missing or lives in another room — the latter prevents a
 * cross-room leak via a forged `around` id.
 */
async function loadConversationMessagesAround(
  runtime: AgentRuntime,
  roomId: UUID,
  aroundMessageId: UUID,
): Promise<Memory[]> {
  const [pivot] = await runtime.getMemoriesByIds([aroundMessageId], "messages");
  if (!pivot || pivot.roomId !== roomId) {
    logger.warn(
      `[conversations] around=${aroundMessageId} is not in room ${roomId}; serving the recent window instead`,
    );
    return runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: CONVERSATION_MESSAGE_WINDOW,
    });
  }
  const pivotCreatedAt = pivot.createdAt ?? 0;
  const [olderOrAt, newerOrAt] = await Promise.all([
    // The pivot and everything before it, newest-first, capped. The pivot is
    // included because `end` is inclusive of its createdAt.
    runtime.getMemories({
      roomId,
      tableName: "messages",
      end: pivotCreatedAt,
      limit: CONVERSATION_AROUND_RADIUS + 1,
      orderBy: "createdAt",
      orderDirection: "desc",
    }),
    // The pivot and everything after it, oldest-first, capped.
    runtime.getMemories({
      roomId,
      tableName: "messages",
      start: pivotCreatedAt,
      limit: CONVERSATION_AROUND_RADIUS + 1,
      orderBy: "createdAt",
      orderDirection: "asc",
    }),
  ]);
  // Merge the two half-windows, de-duping the shared pivot (and any createdAt
  // ties both bounds picked up) by id.
  const byId = new Map<UUID, Memory>();
  for (const memory of [...olderOrAt, ...newerOrAt]) {
    if (memory.id) {
      byId.set(memory.id, memory);
    }
  }
  return Array.from(byId.values());
}

/**
 * Parse the `?before=<createdAt>` cursor: a positive integer millisecond
 * timestamp (the createdAt of the client's current oldest message). Returns
 * null for absent / malformed / non-positive values so the handler falls back
 * to the recent window instead of paging from a bogus cursor.
 */
function parseBeforeCursor(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Clamp the `?limit=N` older-page size to a sane range. Defaults to
 * CONVERSATION_OLDER_PAGE_SIZE and caps at CONVERSATION_MESSAGE_WINDOW so a
 * client can't request an unbounded page.
 */
function clampOlderPageLimit(raw: string | null): number {
  if (raw === null) return CONVERSATION_OLDER_PAGE_SIZE;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CONVERSATION_OLDER_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), CONVERSATION_MESSAGE_WINDOW);
}

/**
 * Load one page of messages STRICTLY OLDER than the `before` cursor for the
 * infinite upward scroll (#13532). `before` is the createdAt of the oldest
 * message the client already holds; this returns up to `limit` turns with a
 * smaller createdAt, newest-first from the store, so the caller can prepend
 * them above the current top.
 *
 * The bound is pushed into the store as getMemories `end` (an inclusive
 * createdAt upper bound) with `before - 1`, so the cursor row itself is
 * excluded and there is NO in-process scan. One extra row beyond `limit` is
 * requested to compute `hasMore` without a second COUNT query; the caller
 * trims it.
 */
async function loadConversationMessagesBefore(
  runtime: AgentRuntime,
  roomId: UUID,
  before: number,
  limit: number,
): Promise<{ memories: Memory[]; hasMore: boolean }> {
  // `end` is inclusive, so subtract 1ms to make the cursor exclusive: the
  // client already holds the message at `before`, we want strictly older.
  const rows = await runtime.getMemories({
    roomId,
    tableName: "messages",
    end: before - 1,
    limit: limit + 1,
    orderBy: "createdAt",
    orderDirection: "desc",
  });
  const hasMore = rows.length > limit;
  return { memories: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

function extractConversationMetaString(
  memory: { metadata?: unknown },
  key: string,
): string | undefined {
  const meta =
    memory.metadata && typeof memory.metadata === "object"
      ? (memory.metadata as Record<string, unknown>)
      : undefined;
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Attachment DTO shaping + per-viewer disclosure selection live in the
// use-case module (#14781); the serializer is re-exported for existing
// importers of this route module.
export { serializeMessageAttachments } from "./attachment-disclosure.ts";

type ConversationRouteMessageRecord = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
  transcriptVisibility?: "internal";
  attachments?: SerializedMessageAttachment[];
  source?: string;
  actionName?: string;
  actionCallbackHistory?: string[];
  from?: string;
  fromUserName?: string;
  avatarUrl?: string;
  replyToMessageId?: string;
  replyToSenderName?: string;
  replyToSenderUserName?: string;
  rawDiscordChannelId?: string;
  rawDiscordMessageId?: string;
  rawSenderId?: string;
  senderEntityId?: string;
  /**
   * Synthetic-failure classification for this turn (provider-issue /
   * no-provider / insufficient-credits / …). Persisted on the failed
   * assistant memory as `content.failureKind` (live result) or
   * `metadata.chatFailureKind` (markSyntheticChatFailureContent). Round-tripped
   * here so the renderer's gate + Retry survive a GET /messages full-replace.
   */
  failureKind?: ChatFailureKind;
  /** Complete typed terminal failure retained across history reloads. */
  terminalFailure?: ChatTerminalFailure;
  replyRecoveryAvailable?: true;
  /**
   * Structured "connect another account" request from the CONNECT_ACCOUNT
   * action. Persisted on the assistant memory as `content.accountConnect`
   * (spread through `buildPersistedAssistantContent`). Round-tripped here so
   * the renderer's inline AddAccountDialog entry point survives a reload.
   */
  accountConnect?: AccountConnectRequest;
  /**
   * The turn ended by explicit Stop/disconnect abort. Persisted on the
   * assistant memory as `content.interrupted` by
   * `persistInterruptedAssistantReceipt`; round-tripped here so reload
   * recovery renders the interrupted terminal state (zero-token receipts
   * included) instead of a healthy reply or a missing row.
   */
  interrupted?: boolean;
};

// Greeting lookup and persistence share the room's history-writer boundary.
// This keeps concurrent hydration/create callers behind the same committed row
// without publishing a separate single-flight promise that can invert ownership.
async function ensureConversationGreetingStored(
  state: ConversationRouteState,
  conv: ConversationMeta,
  lang: string,
  roomHandlerLease?: RoomHandlerLease,
): Promise<{
  text: string;
  agentName: string;
  generated: boolean;
  persisted: boolean;
}> {
  const runtime = state.runtime;
  if (!runtime) {
    return ensureConversationGreetingStoredUnlocked(state, conv, lang);
  }
  if (roomHandlerLease) {
    return runtime.roomHandlerQueue.runInLease(
      conv.roomId,
      roomHandlerLease,
      () =>
        ensureConversationGreetingStoredUnlocked(
          state,
          conv,
          lang,
          roomHandlerLease,
        ),
    );
  }
  return runtime.roomHandlerQueue.withLease(conv.roomId, (lease) =>
    ensureConversationGreetingStoredUnlocked(state, conv, lang, lease),
  );
}

async function ensureConversationGreetingStoredUnlocked(
  state: ConversationRouteState,
  conv: ConversationMeta,
  _lang: string,
  _roomHandlerLease?: RoomHandlerLease,
): Promise<{
  text: string;
  agentName: string;
  generated: boolean;
  persisted: boolean;
}> {
  const runtime = state.runtime;
  const agentName = runtime?.character.name ?? state.agentName;
  if (!runtime) {
    return {
      text: "",
      agentName,
      generated: false,
      persisted: false,
    };
  }

  let memories: Awaited<ReturnType<AgentRuntime["getMemories"]>>;
  try {
    memories = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
    });
  } catch (error) {
    // error-policy:J2 greeting setup retains the storage cause for the route
    // boundary instead of fabricating an empty conversation.
    throw new ElizaError("Failed to inspect conversation messages", {
      code: "CONVERSATION_GREETING_READ_FAILED",
      cause: error,
      context: { conversationId: conv.id },
    });
  }

  memories.sort(compareMemoriesByCreatedAt);
  const existingGreeting = memories.find((memory) => {
    const content = memory.content as Record<string, unknown> | undefined;
    return (
      memory.entityId === runtime.agentId &&
      content?.source === MESSAGE_SOURCE_AGENT_GREETING &&
      typeof content.text === "string" &&
      content.text.trim().length > 0
    );
  });
  if (existingGreeting) {
    return {
      text: String(
        (existingGreeting.content as Record<string, unknown> | undefined)
          ?.text ?? "",
      ),
      agentName,
      generated: true,
      persisted: false,
    };
  }

  if (memories.length > 0) {
    return {
      text: "",
      agentName,
      generated: false,
      persisted: false,
    };
  }

  // Character examples are prompt material, never fabricated assistant turns.
  // New conversations wait for a real turn through the Eliza pipeline.
  return { text: "", agentName, generated: false, persisted: false };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
const MESSAGE_SEARCH_MAX_LIMIT = 50;
const MESSAGE_SEARCH_SNIPPET_RADIUS = 72;

function clampMessageSearchLimit(value: string | null): number {
  const parsed = parsePositiveInteger(value, MESSAGE_SEARCH_DEFAULT_LIMIT);
  return Math.min(parsed, MESSAGE_SEARCH_MAX_LIMIT);
}

function normalizeMessageSearchQuery(value: string | null): string {
  return (value === null ? "" : value).trim().replace(/\s+/g, " ");
}

function isLegacyViewsInventoryContent(
  content: Record<string, unknown>,
): boolean {
  const text = typeof content.text === "string" ? content.text.trim() : "";
  if (!/^available_views:\s*(?:\n|$)/.test(text)) return false;

  const callbackHistory = normalizeActionCallbackHistory(
    content.actionCallbackHistory,
  );
  if (callbackHistory.length > 0 && text === callbackHistory.join("\n")) {
    return true;
  }
  return (
    /^views\[\d+\]\{id,label,type,path,available\}:/m.test(text) ||
    /^\s*count:\s*0\s*$/m.test(text)
  );
}

/**
 * Parse an optional `since`/`until` search param into epoch ms. Accepts a
 * non-negative epoch-ms integer or any `Date.parse`-able string (ISO 8601).
 * Absent → `null`; present-but-unparseable → `"invalid"` so the route can 400
 * instead of silently searching an unbounded window the caller didn't ask for.
 */
function parseMessageSearchTime(
  value: string | null,
): number | null | "invalid" {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return "invalid";
  if (/^\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    return Number.isSafeInteger(epochMs) ? epochMs : "invalid";
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? "invalid" : parsed;
}

/** A `…keyword…` excerpt around the first match, or a head-truncated fallback. */
function buildMessageSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!normalizedText) return "";
  const index = normalizedText.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return normalizedText.length <= MESSAGE_SEARCH_SNIPPET_RADIUS * 2
      ? normalizedText
      : `${normalizedText.slice(0, MESSAGE_SEARCH_SNIPPET_RADIUS * 2).trimEnd()}...`;
  }
  const start = Math.max(0, index - MESSAGE_SEARCH_SNIPPET_RADIUS);
  const end = Math.min(
    normalizedText.length,
    index + query.length + MESSAGE_SEARCH_SNIPPET_RADIUS,
  );
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedText.length ? "..." : "";
  return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

export async function handleConversationRoutes(
  ctx: ConversationRouteContext,
): Promise<boolean> {
  const requestStartedAt = Date.now();
  const { req, res, method, pathname, readJsonBody, json, error, state } = ctx;
  const trustedApiPrincipal = resolveTrustedApiPrincipal(
    req,
    ctx.callerAuthorization,
  );
  const requestUrl = new URL(
    req.url === undefined ? "" : req.url,
    `http://${req.headers.host === undefined ? "localhost" : req.headers.host}`,
  );

  if (
    !pathname.startsWith("/api/conversations") ||
    pathname.startsWith("/api/conversations/")
      ? !/^\/api\/conversations\/[^/]/.test(pathname)
      : pathname !== "/api/conversations"
  ) {
    // Quick exit: not a conversation route
    if (!pathname.startsWith("/api/conversations")) return false;
  }

  // ── GET /api/conversations ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/conversations") {
    await waitForConversationRestore(state);
    const waifuAccess = resolveWaifuChatAccess(req);
    const convos = Array.from(state.conversations.values())
      .filter((c) => !state.deletedConversationIds.has(c.id))
      .filter((c) => canWaifuAccessConversation(waifuAccess, c))
      .sort(compareConversationsByRecency);
    json(res, { conversations: convos });
    return true;
  }

  // ── GET /api/conversations/messages/search ──────────────────────────
  // Keyword search across every conversation the requester can see. The
  // predicate runs in the store (getMemories textContains → ILIKE), then
  // results are ranked + snippeted here. No vector search.
  if (method === "GET" && pathname === "/api/conversations/messages/search") {
    if (!state.runtime) {
      json(res, { results: [], count: 0 });
      return true;
    }
    const query = normalizeMessageSearchQuery(requestUrl.searchParams.get("q"));
    if (query.length < 2) {
      error(res, "Search query must be at least 2 characters", 400);
      return true;
    }
    const limit = clampMessageSearchLimit(requestUrl.searchParams.get("limit"));
    const offset = parsePositiveInteger(
      requestUrl.searchParams.get("offset"),
      0,
    );
    // Optional inclusive time window (epoch ms or ISO 8601): "messages from a
    // year ago" is `until=<9 months ago>` etc. Garbage input is a 400, never a
    // silently ignored filter.
    const since = parseMessageSearchTime(requestUrl.searchParams.get("since"));
    const until = parseMessageSearchTime(requestUrl.searchParams.get("until"));
    if (since === "invalid" || until === "invalid") {
      error(
        res,
        "since/until must be an epoch-ms timestamp or an ISO 8601 date",
        400,
      );
      return true;
    }
    if (since !== null && until !== null && since > until) {
      error(res, "since must not be later than until", 400);
      return true;
    }
    const runtime = state.runtime;
    const waifuAccess = resolveWaifuChatAccess(req);
    const conversationsByRoomId = new Map<UUID, ConversationMeta>();
    for (const conv of state.conversations.values()) {
      if (state.deletedConversationIds.has(conv.id)) continue;
      if (!canWaifuAccessConversation(waifuAccess, conv)) continue;
      conversationsByRoomId.set(conv.roomId, conv);
    }
    // Scope the keyword search to the rooms the requester can actually see, in
    // SQL. Filtering after a global LIMIT (newest-N across *all* the agent's
    // rooms — discord/telegram/inbox/deleted/…) would silently drop accessible
    // matches that fall outside that window. Pushing the room set into the store
    // applies LIMIT/OFFSET after access-scoping.
    const accessibleRoomIds = Array.from(conversationsByRoomId.keys());
    if (accessibleRoomIds.length === 0) {
      json(res, { results: [], count: 0 });
      return true;
    }
    try {
      // Corpus-wide FTS + trigram ranking in the store (#13534): the DB ranks
      // by `ts_rank_cd` over a `websearch_to_tsquery` match (multi-word,
      // non-adjacent, quoted phrases) plus a `pg_trgm` partial-word fallback,
      // applying access-scoping and LIMIT/OFFSET *after* ranking. A relevant hit
      // older than any recency window is therefore found and ordered — unlike
      // the retired `ILIKE '%whole query%'` gate that ranked only a recency-
      // truncated slice of exact-substring rows.
      const hits = await runtime.searchMessages({
        roomIds: accessibleRoomIds,
        query,
        tableName: "messages",
        limit,
        offset,
        ...(since !== null ? { since } : {}),
        ...(until !== null ? { until } : {}),
      });
      const results = hits.flatMap(({ memory, ftsRank, trigramSimilarity }) => {
        const roomId = memory.roomId;
        const conversation = roomId
          ? conversationsByRoomId.get(roomId)
          : undefined;
        if (!roomId || !conversation) return [];
        const content = memory.content as Record<string, unknown> | undefined;
        if (content?.transcriptVisibility === "internal") return [];
        if (
          content &&
          memory.entityId === runtime.agentId &&
          isLegacyViewsInventoryContent(content)
        ) {
          return [];
        }
        const text = content?.text;
        if (typeof text !== "string") return [];
        const rawText = text.trim();
        if (!rawText || !memory.id) return [];
        // A messages memory always carries a numeric createdAt; if it somehow
        // does not, drop the row rather than inject epoch-0 into the DTO.
        if (typeof memory.createdAt !== "number") return [];
        // Rows matched only by the trigram/partial branch have ftsRank 0; expose
        // the trigram similarity as the score so the client still orders them
        // meaningfully. Both are real measured signals from the store.
        const score = ftsRank > 0 ? ftsRank : trigramSimilarity;
        return [
          {
            messageId: memory.id,
            conversationId: conversation.id,
            roomId,
            role: (memory.entityId === runtime.agentId
              ? "assistant"
              : "user") as "assistant" | "user",
            text: rawText,
            snippet: buildMessageSearchSnippet(rawText, query),
            createdAt: memory.createdAt,
            score,
          },
        ];
      });
      logger.info(
        {
          queryLength: query.length,
          limit,
          offset,
          ...(since !== null ? { since } : {}),
          ...(until !== null ? { until } : {}),
          rawHits: hits.length,
          results: results.length,
        },
        "[ConversationSearch] FTS message search completed",
      );
      json(res, { results, count: results.length });
      return true;
    } catch (err) {
      logger.error(
        { error: getErrorMessage(err) },
        "[ConversationSearch] keyword message search failed",
      );
      error(res, "Failed to search conversation messages", 500);
      return true;
    }
  }

  // ── POST /api/conversations/dev/seed-messages ───────────────────────
  // Dev-only: generate a large, realistic, BACKDATED conversation history
  // (default 12 conversations × 40 messages over 13 months, plus derived
  // facts) so message search — including since/until windows like "a year
  // ago" — has a real corpus. Invoked by
  // `packages/scripts/seed-message-corpus.mjs` for manual demo prep.
  if (
    method === "POST" &&
    pathname === "/api/conversations/dev/seed-messages"
  ) {
    // 404 (not 403) in production so the route's existence isn't advertised.
    if (process.env.NODE_ENV === "production") {
      error(res, "Not found", 404);
      return true;
    }
    if (!state.runtime) {
      error(res, "Agent runtime not available", 503);
      return true;
    }
    const rawSeed = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawSeed === null) return true;
    const parsedSeed = PostSeedMessagesRequestSchema.safeParse(rawSeed);
    if (!parsedSeed.success) {
      error(
        res,
        parsedSeed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    await waitForConversationRestore(state);
    const corpus = generateMessageCorpus({
      ...(parsedSeed.data.conversations !== undefined
        ? { conversationCount: parsedSeed.data.conversations }
        : {}),
      ...(parsedSeed.data.messagesPerConversation !== undefined
        ? { messagesPerConversation: parsedSeed.data.messagesPerConversation }
        : {}),
      ...(parsedSeed.data.spanMonths !== undefined
        ? { spanMonths: parsedSeed.data.spanMonths }
        : {}),
      ...(parsedSeed.data.factsPerConversation !== undefined
        ? { factsPerConversation: parsedSeed.data.factsPerConversation }
        : {}),
      ...(parsedSeed.data.seed !== undefined
        ? { seed: parsedSeed.data.seed }
        : {}),
    });
    const summary = await seedMessageCorpus(state.runtime, corpus);
    // Register the seeded conversations in the live in-memory list so they are
    // visible + searchable immediately, without waiting for a restart-restore.
    for (const conv of summary.conversations) {
      state.conversations.set(conv.id, {
        id: conv.id,
        title: conv.title,
        roomId: conv.roomId,
        createdAt: new Date(conv.createdAt).toISOString(),
        updatedAt: new Date(conv.lastMessageAt ?? conv.createdAt).toISOString(),
      });
    }
    evictOldestConversation(state.conversations, 500);
    logger.info(
      {
        conversations: summary.conversations.length,
        messages: summary.messagesCreated,
        facts: summary.factsCreated,
        oldestMessageAt: summary.oldestMessageAt,
        newestMessageAt: summary.newestMessageAt,
      },
      "[ConversationSearch] seeded backdated message corpus",
    );
    json(res, {
      conversations: summary.conversations.length,
      messagesCreated: summary.messagesCreated,
      factsCreated: summary.factsCreated,
      oldestMessageAt: summary.oldestMessageAt,
      newestMessageAt: summary.newestMessageAt,
      sampleQueries: summary.sampleQueries,
    });
    return true;
  }

  // ── POST /api/conversations ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/conversations") {
    const rawConv = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawConv === null) return true;
    const parsedConv = PostConversationRequestSchema.safeParse(rawConv);
    if (!parsedConv.success) {
      error(
        res,
        parsedConv.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedConv.data;
    await waitForConversationRestore(state);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const roomId = stringToUuid(`web-conv-${id}`);
    const metadata = addWaifuConversationOwnerMetadata(
      req,
      sanitizeConversationMetadata(body.metadata),
    );
    const conv: ConversationMeta = {
      id,
      title: body.title?.trim() || "New Chat",
      roomId,
      ...(metadata ? { metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    state.conversations.set(id, conv);
    let greeting:
      | {
          text: string;
          agentName: string;
          generated: boolean;
          persisted: boolean;
        }
      | undefined;

    // Soft cap: evict the oldest conversation when the map exceeds 500
    evictOldestConversation(state.conversations, 500);

    const runtime = state.runtime;
    if (runtime) {
      try {
        prepareConversationConnectionRoom(runtime, conv.roomId);
        await ensureConversationRoom(
          state,
          runtime,
          conv,
          resolveConversationCaller(req, state, trustedApiPrincipal, runtime),
        );
        await syncConversationRoomState(state, conv);
        if (body.includeGreeting === true) {
          const storedGreeting = await ensureConversationGreetingStored(
            state,
            conv,
            typeof body.lang === "string" ? body.lang : "en",
          );
          if (storedGreeting.text.trim()) {
            greeting = {
              text: storedGreeting.text,
              agentName: storedGreeting.agentName,
              generated: storedGreeting.generated,
              persisted: storedGreeting.persisted,
            };
          }
        }
      } catch (err) {
        error(
          res,
          `Failed to initialize conversation: ${getErrorMessage(err)}`,
          500,
        );
        return true;
      }
    }
    json(res, { conversation: conv, ...(greeting ? { greeting } : {}) });
    return true;
  }

  // ── GET /api/conversations/:id/messages ─────────────────────────────
  if (
    method === "GET" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    if (!state.runtime) {
      error(res, "Agent runtime not available", 503);
      return true;
    }
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }
    const runtime = state.runtime;
    try {
      // `?around=<messageId>` centers the window on a specific (possibly
      // far-back) message so a keyword-search jump can scroll to a hit older
      // than the default recent window (#9955). Absent → unchanged recent window.
      const aroundParam = validateUuid(requestUrl.searchParams.get("around"));
      // `?before=<createdAt>&limit=N` loads one page STRICTLY OLDER than the
      // cursor for the infinite upward scroll (#13532): the client passes the
      // createdAt of its current oldest message and prepends the returned page.
      // Mutually exclusive with `around` — a centered jump defines its own
      // window. Returns `hasMore` so the client stops paging at the true top.
      const beforeParam = parseBeforeCursor(
        requestUrl.searchParams.get("before"),
      );
      const olderLimit = clampOlderPageLimit(
        requestUrl.searchParams.get("limit"),
      );
      let hasMore = false;
      let memories: Memory[];
      if (!aroundParam && beforeParam !== null) {
        const page = await loadConversationMessagesBefore(
          runtime,
          conv.roomId,
          beforeParam,
          olderLimit,
        );
        memories = page.memories;
        hasMore = page.hasMore;
      } else {
        memories = aroundParam
          ? await loadConversationMessagesAround(
              runtime,
              conv.roomId,
              aroundParam,
            )
          : await runtime.getMemories({
              roomId: conv.roomId,
              tableName: "messages",
              limit: CONVERSATION_MESSAGE_WINDOW,
            });
      }
      // Sort by createdAt ascending
      memories.sort(compareMemoriesByCreatedAt);
      const agentId = runtime.agentId;
      // Per-viewer attachment disclosure (#14781): a boundary-role viewer
      // token (WaifuChat, artifact share-viewer) carries a principal; trunk
      // owner tokens match no resolver, so the local dashboard resolves no
      // context and serves the full DTO unchanged.
      const viewerAccessContext = resolveHttpAccessContext(req);
      const messages = memories
        .map((m) => {
          const contentSource = (m.content as Record<string, unknown>)?.source;
          const content = m.content as Record<string, unknown>;
          const meta = m.metadata as Record<string, unknown> | undefined;
          const entityName = meta?.entityName;
          const replyToAuthor =
            meta?.replyToAuthor && typeof meta.replyToAuthor === "object"
              ? (meta.replyToAuthor as Record<string, unknown>)
              : null;
          const normalizedSource =
            typeof contentSource === "string" &&
            contentSource.length > 0 &&
            contentSource !== MESSAGE_SOURCE_CLIENT_CHAT
              ? contentSource
              : undefined;
          const actionName =
            typeof content.action === "string" && content.action.length > 0
              ? content.action
              : undefined;
          const actionCallbackHistory = normalizeActionCallbackHistory(
            content.actionCallbackHistory,
          );
          const transcriptVisibility =
            content.transcriptVisibility === "internal"
              ? ("internal" as const)
              : undefined;
          // The failed assistant turn carries its classification on the live
          // result (`content.failureKind`) or, for synthetic fallbacks, on
          // `metadata.chatFailureKind` (markSyntheticChatFailureContent). Round
          // it back so the renderer's provider/credits gate + Retry survive the
          // GET /messages full-replace instead of vanishing.
          const rawFailureKind =
            typeof content.failureKind === "string"
              ? content.failureKind
              : typeof meta?.chatFailureKind === "string"
                ? meta.chatFailureKind
                : undefined;
          const failureKind = parseChatFailureKind(rawFailureKind);
          const terminalFailure = parseChatTerminalFailure(
            content.terminalFailure,
          );
          // The CONNECT_ACCOUNT action stamps `content.accountConnect` on the
          // assistant memory. Validate + round-trip it so the inline
          // AddAccountDialog entry point survives the GET /messages replace.
          const accountConnect = normalizeAccountConnectRequest(
            content.accountConnect,
          );
          const role = m.entityId === agentId ? "assistant" : "user";
          const interrupted = content.interrupted === true;
          const rawText = formatConversationMessageText(
            (m.content as { text?: string })?.text ?? "",
            actionCallbackHistory,
          );
          // An interrupted receipt may intentionally have no model text. Keep
          // its exact partial reply; the interruption metadata owns its status.
          const text =
            transcriptVisibility === "internal" ||
            (role === "assistant" &&
              isIntentionalNoResponseResult(
                { responseContent: m.content },
                rawText,
              ))
              ? ""
              : role === "assistant" && !interrupted
                ? normalizeChatResponseText(rawText, state.logBuffer, runtime)
                : rawText;
          const attachments = selectAttachmentsForViewer(
            m,
            viewerAccessContext,
            agentId,
          );
          const topics =
            Array.isArray(meta?.topics) && meta.topics.length > 0
              ? (meta.topics as unknown[]).filter(
                  (topic): topic is string => typeof topic === "string",
                )
              : undefined;
          return {
            id: m.id ?? "",
            role,
            text,
            timestamp: m.createdAt ?? 0,
            ...(content.replyRecoveryAvailable === true
              ? { replyRecoveryAvailable: true as const }
              : {}),
            ...(transcriptVisibility ? { transcriptVisibility } : {}),
            ...(attachments ? { attachments } : {}),
            ...(topics && topics.length > 0 ? { topics } : {}),
            source: normalizedSource,
            actionName,
            actionCallbackHistory:
              actionCallbackHistory.length > 0
                ? [...actionCallbackHistory]
                : undefined,
            from:
              typeof entityName === "string" && entityName.length > 0
                ? entityName
                : undefined,
            fromUserName:
              typeof meta?.entityUserName === "string" &&
              meta.entityUserName.length > 0
                ? meta.entityUserName
                : undefined,
            avatarUrl:
              typeof meta?.entityAvatarUrl === "string" &&
              meta.entityAvatarUrl.length > 0
                ? meta.entityAvatarUrl
                : undefined,
            replyToMessageId:
              typeof content.inReplyTo === "string" &&
              content.inReplyTo.length > 0
                ? content.inReplyTo
                : typeof meta?.replyToMessageId === "string" &&
                    meta.replyToMessageId.length > 0
                  ? meta.replyToMessageId
                  : undefined,
            replyToSenderName:
              typeof meta?.replyToSenderName === "string" &&
              meta.replyToSenderName.length > 0
                ? meta.replyToSenderName
                : typeof replyToAuthor?.displayName === "string" &&
                    replyToAuthor.displayName.length > 0
                  ? replyToAuthor.displayName
                  : typeof replyToAuthor?.username === "string" &&
                      replyToAuthor.username.length > 0
                    ? replyToAuthor.username
                    : undefined,
            replyToSenderUserName:
              typeof meta?.replyToSenderUserName === "string" &&
              meta.replyToSenderUserName.length > 0
                ? meta.replyToSenderUserName
                : typeof replyToAuthor?.username === "string" &&
                    replyToAuthor.username.length > 0
                  ? replyToAuthor.username
                  : undefined,
            rawDiscordChannelId: extractConversationMetaString(
              m,
              "discordChannelId",
            ),
            rawDiscordMessageId: extractConversationMetaString(
              m,
              "discordMessageId",
            ),
            rawSenderId: extractConversationMetaString(m, "fromId"),
            senderEntityId:
              typeof m.entityId === "string" ? m.entityId : undefined,
            ...(failureKind ? { failureKind } : {}),
            ...(terminalFailure ? { terminalFailure } : {}),
            ...(accountConnect ? { accountConnect } : {}),
            ...(interrupted ? { interrupted: true } : {}),
          } satisfies ConversationRouteMessageRecord;
        })
        // Drop action-log memories that have no visible text (e.g.
        // plugin action logs with only `thought` / `actions` fields).
        // Without this filter they appear as blank chat bubbles. Image-only
        // turns (uploaded or generated media with no caption) are kept.
        .filter(
          (m) =>
            m.text.trim().length > 0 ||
            (m.attachments?.length ?? 0) > 0 ||
            // A zero-token interrupted receipt has no text but IS the turn's
            // terminal state; dropping it would leave the user turn unanswered
            // on reload and invite regeneration.
            m.interrupted === true,
        );
      const discordMessages = messages.filter((message) =>
        mayNeedDiscordMessageEnrichment(message.source),
      );
      const discord =
        discordMessages.length > 0
          ? await getDiscordConversationApi().catch((err) => {
              logger.debug(
                `[conversations] Discord metadata enrichment unavailable: ${getErrorMessage(err)}`,
              );
              return null;
            })
          : null;
      await Promise.all(
        discordMessages.map(async (message) => {
          if (!discord) {
            return;
          }
          if (!discord.isCanonicalDiscordSource(message.source)) {
            return;
          }

          try {
            const storedSenderProfile =
              await discord.resolveStoredDiscordEntityProfile(
                runtime,
                message.senderEntityId,
              );
            if (!message.from && storedSenderProfile?.displayName) {
              message.from = storedSenderProfile.displayName;
            }
            if (!message.fromUserName && storedSenderProfile?.username) {
              message.fromUserName = storedSenderProfile.username;
            }
            if (!message.avatarUrl && storedSenderProfile?.avatarUrl) {
              message.avatarUrl = storedSenderProfile.avatarUrl;
            }

            const messageAuthorProfile =
              message.rawDiscordChannelId && message.rawDiscordMessageId
                ? await discord.resolveDiscordMessageAuthorProfile(
                    runtime,
                    message.rawDiscordChannelId,
                    message.rawDiscordMessageId,
                  )
                : null;
            if (!message.from && messageAuthorProfile?.displayName) {
              message.from = messageAuthorProfile.displayName;
            }
            if (!message.fromUserName && messageAuthorProfile?.username) {
              message.fromUserName = messageAuthorProfile.username;
            }
            if (!message.avatarUrl && messageAuthorProfile?.avatarUrl) {
              message.avatarUrl = messageAuthorProfile.avatarUrl;
            }

            const rawSenderId =
              message.rawSenderId ??
              storedSenderProfile?.rawUserId ??
              messageAuthorProfile?.rawUserId;
            if (rawSenderId) {
              const profile = await discord.resolveDiscordUserProfile(
                runtime,
                rawSenderId,
              );
              if (profile) {
                if (profile.displayName) {
                  message.from = profile.displayName;
                }
                if (profile.username) {
                  message.fromUserName = profile.username;
                }
                if (profile.avatarUrl) {
                  message.avatarUrl = profile.avatarUrl;
                }
              }
            }

            message.avatarUrl = await discord.cacheDiscordAvatarForRuntime(
              runtime,
              message.avatarUrl,
              rawSenderId,
            );
          } catch (err) {
            logger.debug(
              `[conversations] Failed to enrich Discord message metadata: ${getErrorMessage(err)}`,
            );
          }
        }),
      );
      json(res, {
        messages: messages.map(
          ({
            rawDiscordChannelId: _rawDiscordChannelId,
            rawDiscordMessageId: _rawDiscordMessageId,
            rawSenderId: _rawSenderId,
            senderEntityId: _senderEntityId,
            ...message
          }) => message,
        ),
        // Only the load-older (`before`) path advertises pagination state; the
        // recent + around windows are single fixed reads and omit it so their
        // response shape is unchanged.
        ...(beforeParam !== null && !aroundParam ? { hasMore } : {}),
      });
    } catch (err) {
      logger.warn(
        `[conversations] Failed to fetch messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, { messages: [], error: "Failed to fetch messages" }, 500);
    }
    return true;
  }

  // ── POST /api/conversations/:id/import ──────────────────────────────
  // Silent bulk-insert of prior messages into a conversation WITHOUT running
  // inference. Powers the shared→personal cloud handoff: the user's freshly
  // provisioned personal container imports the conversation they already had
  // on the shared agent so the switch is seamless. Keyed by the provided
  // conversation id (so the client re-opens the same conversation after the
  // switch) and idempotent per conversation — re-import onto an already
  // populated room is a no-op, never a duplicate.
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/import$/.test(pathname)
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const rawImport = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawImport === null) return true;
    const rawMessages = rawImport.messages;
    if (!Array.isArray(rawMessages)) {
      error(res, "Body must include a `messages` array", 400);
      return true;
    }
    const importMessages = rawMessages
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const rec = entry as Record<string, unknown>;
        const role =
          rec.role === "assistant"
            ? "assistant"
            : rec.role === "user"
              ? "user"
              : null;
        const rawText =
          typeof rec.text === "string"
            ? rec.text
            : typeof rec.content === "string"
              ? rec.content
              : "";
        const text = rawText.trim();
        if (!role || !text) return null;
        const timestamp =
          typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp)
            ? rec.timestamp
            : undefined;
        const sourceId =
          typeof rec.sourceId === "string" &&
          rec.sourceId.trim() &&
          rec.sourceId.length <= 256
            ? rec.sourceId.trim()
            : undefined;
        return { role, text, timestamp, sourceId } as const;
      })
      .filter(
        (
          m,
        ): m is {
          readonly role: "user" | "assistant";
          readonly text: string;
          readonly timestamp: number | undefined;
          readonly sourceId: string | undefined;
        } => m !== null,
      );
    const sourceIds = importMessages.map((message) => message.sourceId);
    const exactImport = sourceIds.length > 0 && sourceIds.every(Boolean);
    if (sourceIds.some(Boolean) && !exactImport) {
      error(res, "Every imported message must include a sourceId", 400);
      return true;
    }
    if (
      exactImport &&
      new Set(sourceIds as string[]).size !== sourceIds.length
    ) {
      error(res, "Imported message sourceIds must be unique", 400);
      return true;
    }
    const rawScheduledTasks = rawImport.scheduledTasks;
    if (rawScheduledTasks !== undefined && !Array.isArray(rawScheduledTasks)) {
      error(res, "`scheduledTasks` must be an array", 400);
      return true;
    }
    const cutoverToken =
      typeof rawImport.cutoverToken === "string" &&
      rawImport.cutoverToken.trim().length > 0 &&
      rawImport.cutoverToken.length <= 512
        ? rawImport.cutoverToken.trim()
        : null;
    if (rawImport.cutoverToken !== undefined && !cutoverToken) {
      error(
        res,
        "A cutoverToken must be a non-empty string of at most 512 characters",
        400,
      );
      return true;
    }
    const importTasks: ScheduledTask[] = [];
    for (const rawTask of rawScheduledTasks ?? []) {
      if (!isScheduledTask(rawTask) || rawTask.kind !== "reminder") {
        error(
          res,
          "Every imported scheduled task must be a valid reminder",
          400,
        );
        return true;
      }
      importTasks.push(rawTask);
    }
    if (importTasks.length > 0 && !cutoverToken) {
      error(res, "A cutoverToken is required to import scheduled tasks", 400);
      return true;
    }
    const activateScheduledTasks = rawImport.activateScheduledTasks;
    if (
      activateScheduledTasks !== undefined &&
      typeof activateScheduledTasks !== "boolean"
    ) {
      error(res, "`activateScheduledTasks` must be a boolean", 400);
      return true;
    }
    if (activateScheduledTasks === true && !cutoverToken) {
      error(res, "A cutoverToken is required to activate scheduled tasks", 400);
      return true;
    }
    const rawTodoSnapshot = rawImport.todoSnapshot;
    if (cutoverToken && rawTodoSnapshot === undefined) {
      error(res, "A todoSnapshot is required for an exact cutover import", 400);
      return true;
    }
    if (rawTodoSnapshot !== undefined && !cutoverToken) {
      error(res, "A cutoverToken is required to import todos", 400);
      return true;
    }
    let todoSnapshot: Awaited<
      ReturnType<typeof parseSharedTodoCutoverSnapshot>
    > | null = null;
    if (rawTodoSnapshot !== undefined) {
      try {
        todoSnapshot = await parseSharedTodoCutoverSnapshot(rawTodoSnapshot);
      } catch (err) {
        // error-policy:J3 the authenticated import boundary rejects malformed
        // or digest-mismatched Todo data without admitting any partial import.
        error(
          res,
          err instanceof TodoCutoverContractError
            ? err.message
            : `Todo snapshot validation failed: ${getErrorMessage(err)}`,
          400,
        );
        return true;
      }
      if (todoSnapshot.sourceAgentId !== convId) {
        error(res, "Todo snapshot source does not match the conversation", 400);
        return true;
      }
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    await waitForConversationRestore(state);

    let conv = state.conversations.get(convId);
    let createdConversation = false;
    if (!conv) {
      const now = new Date().toISOString();
      conv = {
        id: convId,
        title:
          typeof rawImport.title === "string" && rawImport.title.trim()
            ? rawImport.title.trim()
            : "New Chat",
        roomId: stringToUuid(`web-conv-${convId}`),
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.set(convId, conv);
      evictOldestConversation(state.conversations, 500);
      createdConversation = true;
    }

    const caller = resolveConversationCaller(
      req,
      state,
      trustedApiPrincipal,
      runtime,
    );
    const importAbortTracker = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation import admission",
    });
    let historyLease: RoomHandlerLease;
    try {
      historyLease = await runtime.roomHandlerQueue.acquire(
        conv.roomId,
        importAbortTracker.signal,
      );
    } catch (err) {
      importAbortTracker.dispose();
      if (importAbortTracker.isAborted()) return true;
      error(
        res,
        isRoomQueueBackpressureError(err)
          ? "Conversation is busy; retry import after pending turns finish"
          : `Failed to serialize conversation import: ${getErrorMessage(err)}`,
        roomQueueAdmissionStatus(err),
      );
      return true;
    }
    importAbortTracker.markCompleted();
    importAbortTracker.dispose();
    try {
      if (
        state.conversations.get(conv.id) !== conv ||
        state.deletedConversationIds.has(conv.id)
      ) {
        error(res, "Conversation was deleted", 404);
        return true;
      }
      if (createdConversation) {
        prepareConversationConnectionRoom(runtime, conv.roomId);
      }
      try {
        await ensureConversationRoom(state, runtime, conv, caller);
      } catch (err) {
        error(
          res,
          `Failed to initialize conversation room: ${getErrorMessage(err)}`,
          500,
        );
        return true;
      }

      if (!exactImport && importTasks.length === 0 && !todoSnapshot) {
        // Legacy imports predate source ids. Preserve their room-level
        // idempotency while exact cloud cutovers use per-message identities.
        const existing = await runtime.getMemories({
          roomId: conv.roomId,
          tableName: "messages",
          limit: 1,
        });
        if (existing.length > 0) {
          json(res, {
            conversationId: convId,
            complete: true,
            sourceMessageCount: importMessages.length,
            inserted: 0,
            skipped: importMessages.length,
            alreadyPopulated: true,
          });
          return true;
        }
      }

      let todoReceipt: SharedTodoImportReceipt | null = null;
      if (todoSnapshot && cutoverToken) {
        try {
          todoReceipt = await (
            ctx.todoCutoverImporter ?? importSharedTodoCutover
          )({
            runtime,
            entityId: caller.entityId,
            targetRoomId: conv.roomId,
            cutoverToken,
            snapshot: todoSnapshot,
          });
        } catch (err) {
          // error-policy:J1 the import boundary keeps Shared authoritative when
          // the Dedicated Todo transaction cannot prove the exact snapshot.
          error(res, `Todo import failed: ${getErrorMessage(err)}`, 500);
          return true;
        }
      }

      // Preserve original ordering: assign strictly increasing timestamps,
      // anchored to the provided ones when present.
      let inserted = 0;
      let skipped = 0;
      const anchor = Date.now() - importMessages.length;
      for (let i = 0; i < importMessages.length; i += 1) {
        const m = importMessages[i];
        const entityId =
          m.role === "assistant" ? runtime.agentId : caller.entityId;
        const createdAt = m.timestamp ?? anchor + i;
        try {
          const memory = createMessageMemory({
            id: m.sourceId
              ? createUniqueUuid(
                  runtime,
                  `handoff-import:${convId}:${m.sourceId}`,
                )
              : (crypto.randomUUID() as UUID),
            entityId,
            roomId: conv.roomId,
            content: {
              text: m.text,
              channelType: ChannelType.DM,
              source: "handoff_import",
            },
          }) as ReturnType<typeof createMessageMemory> & {
            createdAt?: number;
            metadata?: Record<string, unknown>;
          };
          memory.createdAt = createdAt;
          if (memory.metadata && typeof memory.metadata === "object") {
            memory.metadata.timestamp = createdAt;
            if (m.sourceId) {
              memory.metadata.sourceId = m.sourceId;
              memory.metadata.platformMessageId = m.sourceId;
            }
          }
          if (m.sourceId) {
            const result = await persistExactConversationMemoryResult(
              runtime,
              memory,
              historyLease,
            );
            if (result.created) inserted += 1;
            else skipped += 1;
          } else {
            await persistConversationMemory(runtime, memory, historyLease);
            inserted += 1;
          }
        } catch (err) {
          // error-policy:J1 the import boundary reports the exact partial-write
          // position and never returns a healthy skipped-count response.
          error(
            res,
            `Conversation import failed at message ${i}: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }
      }
      let importedScheduledTasks = 0;
      let skippedScheduledTasks = 0;
      let activatedScheduledTasks = 0;
      let skippedActivatedScheduledTasks = 0;
      if (importTasks.length > 0 && cutoverToken) {
        const runner = getScheduledTaskRunner(runtime, {
          agentId: runtime.agentId,
        });
        for (let i = 0; i < importTasks.length; i += 1) {
          try {
            const result = await runner.importTask(importTasks[i], {
              sourceAgentId: convId,
              cutoverToken,
            });
            if (result.imported) importedScheduledTasks += 1;
            else skippedScheduledTasks += 1;
          } catch (err) {
            // error-policy:J1 the conversation import boundary reports the exact failing task.
            error(
              res,
              `Scheduled task import failed at task ${i}: ${getErrorMessage(err)}`,
              500,
            );
            return true;
          }
        }
        if (activateScheduledTasks === true) {
          for (let i = 0; i < importTasks.length; i += 1) {
            try {
              const result = await runner.activateImportedTask(
                importTasks[i].taskId,
                {
                  sourceAgentId: convId,
                  cutoverToken,
                },
              );
              if (result.activated) activatedScheduledTasks += 1;
              else skippedActivatedScheduledTasks += 1;
            } catch (err) {
              // error-policy:J1 the conversation import boundary reports the exact failing task.
              error(
                res,
                `Scheduled task activation failed at task ${i}: ${getErrorMessage(err)}`,
                500,
              );
              return true;
            }
          }
        }
      }
      conv.updatedAt = new Date().toISOString();
      state.broadcastWs?.({ type: "conversation-updated", conversation: conv });
      json(res, {
        conversationId: convId,
        complete: true,
        sourceMessageCount: importMessages.length,
        inserted,
        skipped,
        sourceScheduledTaskCount: importTasks.length,
        importedScheduledTasks,
        skippedScheduledTasks,
        activatedScheduledTasks,
        skippedActivatedScheduledTasks,
        ...(todoReceipt ?? {}),
      });
      return true;
    } finally {
      await historyLease.release();
    }
  }

  // ── POST /api/conversations/:id/messages/truncate ──────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/truncate$/.test(pathname)
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;

    const rawTrunc = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawTrunc === null) return true;
    const parsedTrunc =
      PostConversationTruncateRequestSchema.safeParse(rawTrunc);
    if (!parsedTrunc.success) {
      error(
        res,
        parsedTrunc.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const { messageId, inclusive } = parsedTrunc.data;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }

    const truncateAbortTracker = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation truncation admission",
    });
    let historyLease: RoomHandlerLease;
    try {
      historyLease = await runtime.roomHandlerQueue.acquire(
        conv.roomId,
        truncateAbortTracker.signal,
      );
    } catch (err) {
      truncateAbortTracker.dispose();
      if (truncateAbortTracker.isAborted()) return true;
      error(
        res,
        isRoomQueueBackpressureError(err)
          ? "Conversation is busy; retry after the pending turns finish"
          : `Failed to serialize conversation history: ${getErrorMessage(err)}`,
        roomQueueAdmissionStatus(err),
      );
      return true;
    }
    truncateAbortTracker.markCompleted();
    truncateAbortTracker.dispose();
    try {
      if (
        state.conversations.get(conv.id) !== conv ||
        state.deletedConversationIds.has(conv.id)
      ) {
        error(res, "Conversation was deleted", 404);
        return true;
      }
      const result = await runtime.roomHandlerQueue.runInLease(
        conv.roomId,
        historyLease,
        () =>
          truncateConversationMessages(runtime, conv, messageId, {
            inclusive: inclusive === true,
          }),
      );
      conv.updatedAt = new Date().toISOString();
      state.broadcastWs?.({
        type: "conversation-updated",
        conversation: conv,
      });
      json(res, { ok: true, deletedCount: result.deletedCount });
    } catch (err) {
      const status =
        typeof (err as { status?: number }).status === "number"
          ? (err as { status: number }).status
          : 500;
      error(res, getErrorMessage(err), status);
    } finally {
      await historyLease.release();
    }
    return true;
  }

  // ── DELETE /api/conversations/:id/messages/:messageId ──────────────
  // Delete ONE message from the conversation and its backing memory row
  // (#13533). Distinct from truncate (edit-and-resend) and from the local-only
  // `removeConversationMessage` suggestion dismissal (#8792): this persists.
  if (
    method === "DELETE" &&
    /^\/api\/conversations\/[^/]+\/messages\/[^/]+$/.test(pathname)
  ) {
    const segments = pathname.split("/");
    const convId = decodePathComponent(segments[3], res, "conversation id");
    if (convId === null) return true;
    const messageId = decodePathComponent(
      segments[5],
      res,
      "conversation message id",
    );
    if (messageId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    // Non-admin waifu callers may only mutate their own conversation; the
    // access-scoped 404 keeps a foreign conv id from leaking existence.
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }

    const deleteMessageAbortTracker = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation message deletion admission",
    });
    let historyLease: RoomHandlerLease;
    try {
      historyLease = await runtime.roomHandlerQueue.acquire(
        conv.roomId,
        deleteMessageAbortTracker.signal,
      );
    } catch (err) {
      deleteMessageAbortTracker.dispose();
      if (deleteMessageAbortTracker.isAborted()) return true;
      error(
        res,
        isRoomQueueBackpressureError(err)
          ? "Conversation is busy; retry after the pending turns finish"
          : `Failed to serialize conversation history: ${getErrorMessage(err)}`,
        roomQueueAdmissionStatus(err),
      );
      return true;
    }
    deleteMessageAbortTracker.markCompleted();
    deleteMessageAbortTracker.dispose();
    try {
      if (
        state.conversations.get(conv.id) !== conv ||
        state.deletedConversationIds.has(conv.id)
      ) {
        error(res, "Conversation was deleted", 404);
        return true;
      }
      const result = await runtime.roomHandlerQueue.runInLease(
        conv.roomId,
        historyLease,
        () => deleteConversationMessage(runtime, conv, messageId),
      );
      conv.updatedAt = new Date().toISOString();
      state.broadcastWs?.({
        type: "conversation-updated",
        conversation: conv,
      });
      json(res, { ok: true, deletedCount: result.deletedCount });
    } catch (err) {
      const status =
        typeof (err as { status?: number }).status === "number"
          ? (err as { status: number }).status
          : 500;
      error(res, getErrorMessage(err), status);
    } finally {
      await historyLease.release();
    }
    return true;
  }

  // A retry owns presentation only. It reads the original user marker under
  // the same room lease as normal turns and never enters the message planner.
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/[^/]+\/retry-reply$/.test(pathname)
  ) {
    const segments = pathname.split("/");
    const convId = decodePathComponent(segments[3], res, "conversation id");
    const rawMessageId = decodePathComponent(
      segments[5],
      res,
      "conversation message id",
    );
    if (convId === null || rawMessageId === null) return true;
    const assistantId = validateUuid(rawMessageId);
    if (!assistantId) {
      error(res, "Invalid assistant message id", 400);
      return true;
    }
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (body === null) return true;
    if (!isRecord(body) || Object.keys(body).length > 0) {
      error(
        res,
        "Reply recovery does not accept replacement text or evidence",
        400,
      );
      return true;
    }
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res))
      return true;
    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const caller = resolveConversationCaller(
      req,
      state,
      trustedApiPrincipal,
      runtime,
    );
    const disconnect = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation reply recovery",
    });
    let lease: RoomHandlerLease | undefined;
    let endActive: (() => void) | undefined;
    const assertCurrent = () => {
      if (
        state.runtime !== runtime ||
        state.conversations.get(conv.id) !== conv ||
        state.deletedConversationIds.has(conv.id)
      )
        throw new ElizaError(
          "Conversation runtime changed during reply recovery",
          { code: "CHAT_REPLY_RECOVERY_CONFLICT" },
        );
    };
    try {
      lease = await runtime.roomHandlerQueue.acquire(
        conv.roomId,
        disconnect.signal,
      );
      assertCurrent();
      endActive = beginActiveChatTurn(state);
      const [assistant] = await runtime.getMemoriesByIds(
        [assistantId],
        "messages",
      );
      const userId = validateUuid(assistant?.content.inReplyTo);
      if (
        !assistant ||
        assistant.roomId !== conv.roomId ||
        assistant.agentId !== runtime.agentId ||
        assistant.entityId !== runtime.agentId ||
        !userId
      )
        throw new ElizaError("Original reply is unavailable for recovery", {
          code: "CHAT_REPLY_RECOVERY_UNAVAILABLE",
        });
      const originalAssistantHash = conversationReplyContentHash(
        assistant.content,
      );
      const [storedUser] = await runtime.getMemoriesByIds([userId], "messages");
      const scope = buildConversationChatIdempotencyScope(
        runtime,
        conv.roomId,
        caller.entityId,
      );
      const marker = readDurableConversationChatMarker(
        storedUser?.content.chatIdempotency,
      );
      if (
        !storedUser ||
        storedUser.roomId !== conv.roomId ||
        storedUser.agentId !== runtime.agentId ||
        storedUser.entityId !== caller.entityId ||
        !marker ||
        marker.scope !== scope ||
        conversationClientUserMemoryId(scope, marker.clientMessageId) !== userId
      )
        throw new ElizaError(
          "Reply recovery belongs to another authenticated turn",
          { code: "CHAT_REPLY_RECOVERY_IDENTITY" },
        );
      const recovery =
        marker.replyRecoveryJson === undefined
          ? null
          : parseDurableConversationReplyRecovery(marker.replyRecoveryJson);
      if (
        !recovery ||
        recovery.assistantMessageId !== assistantId ||
        recovery.userContentHash !==
          conversationReplyContentHash(storedUser.content) ||
        !conversationReplyRecoveryIsEligible(recovery)
      )
        throw new ElizaError(
          "Reply recovery is unavailable or requires outcome reconciliation",
          { code: "CHAT_REPLY_RECOVERY_UNAVAILABLE" },
        );
      const outcome =
        marker.outcomeJson === undefined
          ? null
          : parseDurableConversationChatOutcome(marker.outcomeJson);
      if (
        (marker.outcomeJson !== undefined && !outcome) ||
        (outcome &&
          (outcome.messageId !== assistantId ||
            outcome.userMessageId !== userId))
      )
        throw new ElizaError(
          "Stored reply outcome does not match its original turn",
          { code: "CHAT_REPLY_RECOVERY_INVALID" },
        );
      const alreadyRecovered =
        recovery.reply !== undefined &&
        outcome !== null &&
        outcome.terminalFailure === undefined &&
        outcome.replyRecoveryAvailable !== true;
      if (alreadyRecovered && outcome?.text !== recovery.reply?.text)
        throw new ElizaError(
          "Stored recovered prose does not match its outcome",
          { code: "CHAT_REPLY_RECOVERY_INVALID" },
        );
      if (
        alreadyRecovered &&
        originalAssistantHash !== recovery.reply?.contentHash
      )
        throw new ElizaError(
          "The recovered assistant reply was edited after recovery completed",
          { code: "CHAT_REPLY_RECOVERY_CONFLICT" },
        );
      if (
        !alreadyRecovered &&
        originalAssistantHash !== recovery.assistantContentHash &&
        originalAssistantHash !== recovery.reply?.contentHash
      )
        throw new ElizaError(
          "The failed assistant reply was edited after its outcomes settled",
          { code: "CHAT_REPLY_RECOVERY_CONFLICT" },
        );
      if (
        !recovery.reply &&
        (assistant.content.replyRecoveryAvailable !== true ||
          !parseChatTerminalFailure(assistant.content.terminalFailure))
      )
        throw new ElizaError(
          "The selected assistant turn does not have a missing reply",
          { code: "CHAT_REPLY_RECOVERY_UNAVAILABLE" },
        );
      const message: Memory = {
        ...storedUser,
        content: { ...storedUser.content },
      };
      // Server-owned retry evidence is not part of the user's request content.
      delete message.content.chatIdempotency;
      const authorizeRecoveryAudience = async () => {
        await attestAuthenticatedApiDeliveryAudience(
          runtime,
          message,
          trustedApiPrincipal,
        );
        assertCurrent();
        if (recovery.ownerExclusiveDisclosureUsed) {
          const disclosure = await authorizeOwnerExclusiveDisclosure(
            runtime,
            message,
          );
          if (!disclosure.allowed)
            throw new ElizaError(
              "The current conversation cannot receive this private reply",
              { code: "CHAT_REPLY_RECOVERY_IDENTITY" },
            );
        }
        for (const actionResult of recovery.actionResults) {
          if (!actionResult.data || !("disclosureSubject" in actionResult.data))
            continue;
          if (
            actionResult.data.disclosureSubject === null ||
            actionResult.data.disclosureSubject === undefined
          )
            throw new ElizaError(
              "Stored action disclosure evidence is invalid",
              { code: "CHAT_REPLY_RECOVERY_INVALID" },
            );
          const checked = await enforceTrustedDeliveryAudienceAtEgress(
            runtime,
            message,
            {
              data: {
                disclosureSubject: actionResult.data.disclosureSubject,
              } as Content,
            },
          );
          if (isRecord(checked.data) && checked.data.privacyDenied === true)
            throw new ElizaError(
              "The current audience cannot receive these action results",
              { code: "CHAT_REPLY_RECOVERY_IDENTITY" },
            );
        }
      };
      await authorizeRecoveryAudience();
      assertCurrent();
      const recoveryLease = lease;
      const recoverAttempt = async () => {
        const reply =
          recovery.reply ??
          (await resolvePlannedReplyEgress({
            runtime,
            message,
            reply: "",
            actionResults: recovery.actionResults,
            recovery,
          }));
        if (
          reply.effectReceiptIds.length > 0 &&
          !resolveAppliedUserFacingEffectReceipts(
            {
              verifiedUserFacing: true,
              userFacingText: reply.text,
              userFacingEffectReceiptIds: reply.effectReceiptIds,
            },
            mergeEffectReceipts(
              ...recovery.actionResults.map((result) => result.effectReceipts),
            ),
          )
        )
          throw new ElizaError("The saved reply has invalid effect evidence", {
            code: "CHAT_REPLY_RECOVERY_INVALID",
          });
        const replyBinding: ActionResult = {
          success: true,
          userFacingText: reply.text,
          verifiedUserFacing: true,
          userFacingEffectReceiptIds: reply.effectReceiptIds,
        };
        if (
          evaluatePlannedReplyEgress({
            reply: reply.text,
            actionResults: [...recovery.actionResults, replyBinding],
            actions: runtime.actions,
          }).verdict !== "allow"
        )
          throw new ElizaError(
            "The saved reply is not grounded in its original effects",
            { code: "CHAT_REPLY_RECOVERY_INVALID" },
          );
        await authorizeRecoveryAudience();
        assertCurrent();
        let content: Content = {
          ...assistant.content,
          text: reply.text,
          inReplyTo: userId,
          effectReceiptIds: [...reply.effectReceiptIds],
          agentVoiced: true,
        };
        delete content.terminalFailure;
        delete content.failureKind;
        delete content.replyFailure;
        delete content.replyRecoveryAvailable;
        delete content.elizaSyntheticFailure;
        delete content.interrupted;
        delete content.transcriptVisibility;
        const normalizedContent = clearRecoveredReplyFailureMarkers(content);
        if (isRecord(normalizedContent.metadata))
          normalizedContent.metadata = clearRecoveredReplyFailureMarkers(
            normalizedContent.metadata,
          );
        // New prepared prose binds its successful metadata before persistence.
        // Legacy staged/completed replies keep their exact saved revision: memory
        // evaluators may already have acknowledged that historical content hash.
        const normalizeFailureMetadata =
          !recovery.reply ||
          recovery.reply.contentHash ===
            conversationReplyContentHash(normalizedContent);
        if (normalizeFailureMetadata) content = normalizedContent;
        if (
          recovery.reply &&
          recovery.reply.contentHash !== conversationReplyContentHash(content)
        )
          throw new ElizaError(
            "Stored recovered content does not match its prepared revision",
            { code: "CHAT_REPLY_RECOVERY_INVALID" },
          );
        const checked = await enforceTrustedDeliveryAudienceAtEgress(
          runtime,
          message,
          content,
        );
        if (checked !== content)
          throw new ElizaError(
            "The current audience cannot receive the recovered reply",
            { code: "CHAT_REPLY_RECOVERY_IDENTITY" },
          );
        assertCurrent();
        if (alreadyRecovered && outcome) {
          return outcome;
        }
        // The model awaited external I/O. Re-read authority before writing so
        // an independently edited/deleted memory is never replaced from a stale
        // snapshot. Runtime memory mutation routes share this same room lease.
        const latestRows = await runtime.getMemoriesByIds(
          [userId, assistantId],
          "messages",
        );
        const latestUser = latestRows.find((memory) => memory.id === userId);
        const latestAssistant = latestRows.find(
          (memory) => memory.id === assistantId,
        );
        const latestMarker = readDurableConversationChatMarker(
          latestUser?.content.chatIdempotency,
        );
        if (
          !latestUser ||
          latestUser.roomId !== conv.roomId ||
          latestUser.entityId !== caller.entityId ||
          latestUser.agentId !== runtime.agentId ||
          conversationReplyContentHash(latestUser.content) !==
            recovery.userContentHash ||
          !latestMarker ||
          latestMarker.scope !== marker.scope ||
          latestMarker.clientMessageId !== marker.clientMessageId ||
          latestMarker.fingerprint !== marker.fingerprint ||
          latestMarker.replyRecoveryJson !== marker.replyRecoveryJson ||
          !latestAssistant ||
          latestAssistant.roomId !== conv.roomId ||
          latestAssistant.agentId !== runtime.agentId ||
          latestAssistant.entityId !== runtime.agentId ||
          conversationReplyContentHash(latestAssistant.content) !==
            originalAssistantHash
        )
          throw new ElizaError(
            "The original turn changed while its reply was recovering",
            { code: "CHAT_REPLY_RECOVERY_CONFLICT" },
          );
        assertCurrent();
        if (!recovery.reply) {
          // Commit the generated prose first. A crash between this marker and
          // the assistant row only repeats persistence, never tools or the model.
          const preparedRecovery = {
            ...recovery,
            reply: {
              text: reply.text,
              effectReceiptIds: [...reply.effectReceiptIds],
              contentHash: conversationReplyContentHash(content),
            },
          };
          await runtime.roomHandlerQueue.runInLease(
            conv.roomId,
            recoveryLease,
            () => {
              assertCurrent();
              return runtime.updateMemory({
                id: userId,
                content: {
                  ...latestUser.content,
                  chatIdempotency: {
                    ...latestMarker,
                    replyRecoveryJson: JSON.stringify(preparedRecovery),
                  },
                },
              });
            },
          );
        }
        assertCurrent();
        await runtime.roomHandlerQueue.runInLease(
          conv.roomId,
          recoveryLease,
          () => {
            assertCurrent();
            const metadata = latestAssistant.metadata
              ? normalizeFailureMetadata
                ? clearRecoveredReplyFailureMarkers(latestAssistant.metadata)
                : { ...latestAssistant.metadata }
              : undefined;
            if (
              !normalizeFailureMetadata &&
              metadata &&
              "chatFailureKind" in metadata
            )
              delete metadata.chatFailureKind;
            return runtime.updateMemory({
              id: assistantId,
              content,
              ...(metadata ? { metadata } : {}),
            });
          },
        );
        const recoveredOutcome: ChatMessageIdOutcome = {
          text: reply.text,
          agentName: state.agentName,
          messageId: assistantId,
          userMessageId: userId,
          ...(outcome?.actionResults
            ? { actionResults: outcome.actionResults }
            : {}),
        };
        await persistDurableConversationChatOutcome(
          runtime,
          conv.roomId,
          scope,
          marker.clientMessageId,
          marker.fingerprint,
          recoveredOutcome,
          recoveryLease,
          assertCurrent,
        );
        assertCurrent();
        conv.updatedAt = new Date().toISOString();
        state.broadcastWs?.({
          type: "conversation-updated",
          conversation: conv,
        });
        return recoveredOutcome;
      };
      // A prepared/cached reply only resumes persistence. Record fresh model
      // work as its own run, linked to the same original user message; never
      // append it to a completed chat trajectory or replay its tools.
      const recoveredOutcome = recovery.reply
        ? await recoverAttempt()
        : await withStandaloneTrajectory(
            runtime,
            {
              source: MESSAGE_SOURCE_CLIENT_CHAT,
              metadata: {
                roomId: conv.roomId,
                entityId: caller.entityId,
                messageId: userId,
                assistantMessageId: assistantId,
                replyRecovery: true,
              },
            },
            recoverAttempt,
          );
      disconnect.markCompleted();
      json(res, buildConversationJsonOutcome(recoveredOutcome));
    } catch (cause) {
      // error-policy:J1 transport boundary preserves the original failed turn;
      // no recovery failure grants permission to re-execute its actions.
      if (!disconnect.isAborted()) {
        const code = cause instanceof ElizaError ? cause.code : "";
        error(
          res,
          getErrorMessage(cause),
          code === "CHAT_REPLY_RECOVERY_IDENTITY"
            ? 403
            : code.startsWith("CHAT_REPLY_RECOVERY_")
              ? 409
              : 503,
        );
      }
      runtime.reportError("Conversation.replyRecovery", cause, {
        roomId: conv.roomId,
        assistantMessageId: assistantId,
      });
    } finally {
      disconnect.dispose();
      endActive?.();
      await lease?.release();
    }
    return true;
  }

  // ── POST /api/conversations/:id/messages/stream ─────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/stream$/.test(pathname)
  ) {
    const trace = resolveConversationTraceContext(req.headers);
    res.setHeader(ELIZA_TRACE_ID_HEADER, trace.traceId);
    res.setHeader("Access-Control-Expose-Headers", ELIZA_TRACE_ID_HEADER);
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const fenceResolution = resolveLocalVoiceRuntimeFence(req, state, convId);
    if (fenceResolution.kind === "invalid") {
      error(res, fenceResolution.message, 400);
      return true;
    }
    if (fenceResolution.kind === "conflict") {
      error(res, fenceResolution.message, 409);
      return true;
    }
    const localVoiceRuntimeFence =
      fenceResolution.kind === "valid" ? fenceResolution.fence : null;
    const conv = await getConversationWithRestore(state, convId);
    // Before runtime startup there may be no restore task or conversation map
    // yet. A 404 tells the client to create a replacement conversation, so only
    // report absence once the runtime can restore persisted conversations.
    if (!conv && !state.runtime) {
      error(res, "Agent runtime not available", 503);
      return true;
    }
    if (!isLocalVoiceRuntimeFenceCurrent(state, localVoiceRuntimeFence, conv)) {
      error(res, "Local voice agent runtime changed", 409);
      return true;
    }
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }

    const disconnectTracker = createConversationStreamDisconnectTracker({
      req,
      res,
      conversationId: conv.id,
      roomId: conv.roomId,
    });
    const finishStreamResponse = () => {
      disconnectTracker.markCompleted();
      disconnectTracker.dispose();
      if (!res.writableEnded) {
        res.end();
      }
    };

    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) {
      finishStreamResponse();
      return true;
    }
    if (!isLocalVoiceRuntimeFenceCurrent(state, localVoiceRuntimeFence, conv)) {
      disconnectTracker.markCompleted();
      disconnectTracker.dispose();
      error(res, "Local voice agent runtime changed", 409);
      return true;
    }
    const {
      prompt,
      channelType,
      images,
      preferredLanguage,
      source,
      metadata: chatMetadata,
      streamProtocol,
      clientMessageId,
    } = chatPayload;
    logger.info(
      { traceId: trace.traceId, traceSource: trace.source },
      "[ConversationStream] accepted validated trace context",
    );
    // Deps are the module-imported write fns so route tests that vi.mock
    // `writeChatTokenSse`/`writeSse` keep capturing frames on the legacy path.
    const tokenWriter = createChatTokenStreamWriter(
      streamProtocol ?? "legacy",
      { writeChatTokenSse, writeSse },
    );

    // The SSE channel opens as soon as the request is validated — before
    // runtime resolution, room setup, and user-message persistence — so the
    // client sees headers, an immediate `thinking` status, and heartbeats
    // during the pre-model work (runtime warming alone can take seconds; the
    // pre-model DB steps add serial round-trips). Everything past this point
    // reports failure as a structured SSE `error` event (the client maps
    // `type:"error"` data lines to StreamGenerationError); only the validation
    // above may answer with plain HTTP status codes.
    initSse(res);
    writeConversationStreamHeartbeat(res, disconnectTracker);
    const heartbeatInterval = setInterval(() => {
      if (disconnectTracker.checkConnectionClosed()) {
        return;
      }
      writeConversationStreamHeartbeat(res, disconnectTracker);
    }, 5000);
    let chatReservation: ChatMessageIdReservation | null = null;
    let chatIdempotencyScope = String(conv.roomId);
    let reservationSettled = false;
    let runtimeTurnLease: RoomHandlerLease | null = null;
    const runtime = state.runtime;
    const releaseTurnReservation = () =>
      releaseChatMessageId(
        chatIdempotencyScope,
        clientMessageId ?? null,
        chatReservation,
      );
    try {
      const failStream = (message: string): true => {
        releaseTurnReservation();
        writeSse(res, { type: "error", message });
        clearInterval(heartbeatInterval);
        finishStreamResponse();
        return true;
      };

      // Runtime readiness is a lifecycle/API boundary. A chat request must fail
      // immediately when capability is absent instead of occupying an SSE socket
      // behind a hidden boot timer.
      if (!runtime) {
        return failStream("Agent is not running");
      }

      const inferenceTimer =
        getInferenceTimer() ??
        new InferenceTurnTimer({
          turnId: nextInferenceTurnId(),
          traceId: trace.traceId,
          label: "chat-request",
          roomId: conv.roomId,
          t0EpochMs: requestStartedAt,
        });
      const caller = resolveConversationCaller(
        req,
        state,
        trustedApiPrincipal,
        runtime,
      );
      const userId = caller.entityId;
      chatIdempotencyScope = buildConversationChatIdempotencyScope(
        runtime,
        conv.roomId,
        caller.entityId,
      );
      const chatFingerprint = buildConversationChatFingerprint({
        prompt,
        images,
        source,
        channelType,
        preferredLanguage,
        metadata: chatMetadata,
      });
      const assertLocalVoiceTurnFence = () =>
        assertLocalVoiceTurnFenceCurrent(state, localVoiceRuntimeFence, conv);
      const settleTurnReservationInMemory = (
        outcome: ChatMessageIdOutcome,
      ): void => {
        setChatMessageIdOutcome(
          chatIdempotencyScope,
          clientMessageId ?? null,
          outcome,
          chatReservation,
        );
        reservationSettled = true;
      };
      const settleTurnReservation = async (
        outcome: ChatMessageIdOutcome,
      ): Promise<void> => {
        if (clientMessageId) {
          if (!runtimeTurnLease) {
            throw new ElizaError("Chat outcome has no live room ownership", {
              code: "CHAT_IDEMPOTENCY_LEASE_MISSING",
              context: { roomId: conv.roomId, clientMessageId },
            });
          }
          await persistDurableConversationChatOutcome(
            runtime,
            conv.roomId,
            chatIdempotencyScope,
            clientMessageId,
            chatFingerprint,
            outcome,
            runtimeTurnLease,
            assertLocalVoiceTurnFence,
          );
          assertLocalVoiceTurnFence();
        }
        settleTurnReservationInMemory(outcome);
      };
      const settleDurableAssistantOutcome = async (
        outcome: ChatMessageIdOutcome,
      ): Promise<void> => {
        try {
          await settleTurnReservation(outcome);
        } catch (settlementError) {
          assertLocalVoiceTurnFence();
          // error-policy:J7 the assistant reply is already durable and can be
          // reconstructed by its in-reply-to link after restart. Preserve the
          // truthful terminal locally while reporting the failed marker write.
          settleTurnReservationInMemory(outcome);
          runtime.reportError(
            "ConversationStream.durableReplySettlement",
            settlementError,
            {
              conversationId: conv.id,
              roomId: conv.roomId,
              clientMessageId,
              messageId: outcome.messageId,
            },
          );
          logger.warn(
            {
              err: getErrorMessage(settlementError),
              conversationId: conv.id,
              roomId: conv.roomId,
              messageId: outcome.messageId,
            },
            "[ConversationStream] durable assistant reply persisted but outcome marker settlement failed",
          );
        }
      };
      const idempotencyAdmission = await awaitConversationChatAdmission(
        chatIdempotencyScope,
        clientMessageId ?? null,
        chatFingerprint,
        disconnectTracker.signal,
      );
      if (
        !isLocalVoiceRuntimeFenceCurrent(state, localVoiceRuntimeFence, conv)
      ) {
        return failStream("Local voice agent runtime changed");
      }
      if (idempotencyAdmission.kind === "aborted") {
        clearInterval(heartbeatInterval);
        finishStreamResponse();
        return true;
      }
      if (
        idempotencyAdmission.kind === "settled" &&
        !idempotencyAdmission.outcome.replyRecoveryAvailable
      ) {
        writeConversationDoneSse(res, idempotencyAdmission.outcome);
        clearInterval(heartbeatInterval);
        finishStreamResponse();
        return true;
      }
      if (idempotencyAdmission.kind === "conflict") {
        writeSse(res, {
          type: "error",
          message: idempotencyAdmission.error.message,
          code: idempotencyAdmission.error.code,
        });
        clearInterval(heartbeatInterval);
        finishStreamResponse();
        return true;
      }
      chatReservation =
        idempotencyAdmission.kind === "owner"
          ? idempotencyAdmission.reservation
          : null;
      writeChatStatusSse(res, { kind: "thinking" });
      try {
        runtimeTurnLease = await runWithInferenceTiming(inferenceTimer, () =>
          timeInferenceSpan("chat:room-lease-wait", () =>
            runtime.roomHandlerQueue.acquire(
              conv.roomId,
              disconnectTracker.signal,
            ),
          ),
        );
        if (
          !isLocalVoiceRuntimeFenceCurrent(state, localVoiceRuntimeFence, conv)
        ) {
          return failStream("Local voice agent runtime changed");
        }
      } catch (err) {
        releaseTurnReservation();
        if (disconnectTracker.isAborted()) {
          clearInterval(heartbeatInterval);
          finishStreamResponse();
          return true;
        }
        return failStream(
          isRoomQueueBackpressureError(err)
            ? "Conversation is busy; retry after the pending turns finish"
            : `Failed to serialize conversation turn: ${getErrorMessage(err)}`,
        );
      }

      try {
        if (
          state.conversations.get(conv.id) !== conv ||
          state.deletedConversationIds.has(conv.id)
        ) {
          return failStream("Conversation was deleted");
        }
        let durableRecovery: DurableConversationChatRecovery;
        try {
          durableRecovery = await recoverDurableConversationChatOutcome(
            runtime,
            conv.roomId,
            chatIdempotencyScope,
            clientMessageId,
            chatFingerprint,
            state.agentName,
            runtimeTurnLease,
            assertLocalVoiceTurnFence,
          );
        } catch (err) {
          // error-policy:J1 A local voice generation-fence failure is
          // translated at the open SSE transport boundary.
          if (
            !isLocalVoiceRuntimeFenceCurrent(
              state,
              localVoiceRuntimeFence,
              conv,
            )
          ) {
            return failStream(getErrorMessage(err));
          }
          throw err;
        }
        if (
          !isLocalVoiceRuntimeFenceCurrent(state, localVoiceRuntimeFence, conv)
        ) {
          return failStream("Local voice agent runtime changed");
        }
        if (durableRecovery.kind === "conflict") {
          releaseTurnReservation();
          writeSse(res, {
            type: "error",
            message: durableRecovery.error.message,
            code: durableRecovery.error.code,
          });
          clearInterval(heartbeatInterval);
          finishStreamResponse();
          return true;
        }
        if (durableRecovery.kind === "settled") {
          try {
            await settleTurnReservation(durableRecovery.outcome);
            assertLocalVoiceTurnFence();
          } catch (err) {
            // error-policy:J1 A late settlement fence failure is translated
            // before the route can emit a successful terminal frame.
            if (
              !isLocalVoiceRuntimeFenceCurrent(
                state,
                localVoiceRuntimeFence,
                conv,
              )
            ) {
              return failStream(getErrorMessage(err));
            }
            throw err;
          }
          writeConversationDoneSse(res, durableRecovery.outcome);
          clearInterval(heartbeatInterval);
          finishStreamResponse();
          return true;
        }
        let userMessages: Awaited<ReturnType<typeof buildUserMessages>>;
        try {
          const pendantProvenance = await verifyCanonicalPendantProvenance(
            runtime,
            caller,
            prompt,
            chatMetadata,
          );
          if (
            !isLocalVoiceRuntimeFenceCurrent(
              state,
              localVoiceRuntimeFence,
              conv,
            )
          ) {
            return failStream("Local voice agent runtime changed");
          }
          userMessages = await buildUserMessages({
            images,
            prompt,
            userId,
            agentId: runtime.agentId,
            roomId: conv.roomId,
            channelType,
            messageSource: pendantProvenance ? "pendant" : source,
            metadata: chatMetadata,
          });
          if (
            !isLocalVoiceRuntimeFenceCurrent(
              state,
              localVoiceRuntimeFence,
              conv,
            )
          ) {
            return failStream("Local voice agent runtime changed");
          }
          if (pendantProvenance) {
            stampCanonicalPendantMemory(userMessages, pendantProvenance);
          }
        } catch (err) {
          const handled = failStream(
            `Failed to prepare user message: ${getErrorMessage(err)}`,
          );
          return handled;
        }
        bindClientUserMemoryId(
          clientMessageId ?? null,
          chatIdempotencyScope,
          chatFingerprint,
          userMessages,
        );
        const { userMessage, messageToStore } = userMessages;

        const connectionDescriptor = captureConversationConnection(
          state,
          runtime,
          conv,
          caller,
          assertLocalVoiceTurnFence,
        );
        try {
          await scheduleConversationConnectionEnsure(connectionDescriptor, () =>
            establishConversationConnection(connectionDescriptor),
          );
          assertConversationConnectionRuntime(
            state.runtime,
            connectionDescriptor,
          );
          await attestAuthenticatedApiDeliveryAudience(
            runtime,
            userMessage,
            trustedApiPrincipal,
          );
        } catch (err) {
          releaseTurnReservation();
          const handled = failStream(
            `Failed to initialize conversation room: ${getErrorMessage(err)}`,
          );
          return handled;
        }

        const routedUserMessage = withViewInteractionClient(userMessage, req);
        const turnStartedAt = Date.now();
        try {
          assertConversationConnectionRuntime(
            state.runtime,
            connectionDescriptor,
          );
          await persistClientUserMemory(
            runtime,
            messageToStore,
            clientMessageId ?? null,
            runtimeTurnLease,
            assertLocalVoiceTurnFence,
          );
          assertConversationConnectionRuntime(
            state.runtime,
            connectionDescriptor,
          );
        } catch (err) {
          const connectionFailed = isConversationConnectionError(err);
          if (connectionFailed) {
            releaseTurnReservation();
          }
          const handled = failStream(
            `${connectionFailed ? "Failed to refresh conversation room" : "Failed to store user message"}: ${getErrorMessage(err)}`,
          );
          return handled;
        }

        // ── Local runtime path (streaming) ───────────────────────

        const endActiveChatTurn = beginActiveChatTurn(state);

        // Completion callbacks belong to this acquired lease, not the mutable
        // cleanup slot that is cleared when the request finally releases it.
        const generationLease = runtimeTurnLease;
        let streamedText = "";
        // The route already wrote a `thinking` status when the SSE channel opened;
        // collapse the identical opening status generateChatResponse re-emits so
        // the wire carries each phase transition once. Distinct consecutive phases
        // (thinking → running_action → thinking) still pass through.
        let lastStatusSignature = "thinking::";
        // The early callback can settle a reply before generation later throws.
        // Keep that shared result readable by the terminal recovery path.
        const generation: { result: ChatGenerationResult | null } = {
          result: null,
        };
        let resolvedGenerationText: string | undefined;
        let replyReadyPublished = false;
        let generationCompletion: Promise<void> | undefined;
        let generationDelivered = false;
        try {
          const assertCurrentGenerationOwner = () =>
            assertConversationConnectionRuntime(
              state.runtime,
              connectionDescriptor,
            );
          const publishReplyReady = async (result: ChatGenerationResult) => {
            if (
              replyReadyPublished ||
              // Failure text is a typed system status, not an early model reply.
              result.terminalFailure !== undefined ||
              result.noResponseReason === "ignored" ||
              disconnectTracker.isAborted() ||
              disconnectTracker.checkConnectionClosed()
            ) {
              return;
            }
            assertCurrentGenerationOwner();
            resolvedGenerationText = normalizeChatResponseText(
              result.text,
              state.logBuffer,
              runtime,
            );
            writeSse(res, {
              type: "reply_ready",
              fullText:
                result.transcriptVisibility === "internal"
                  ? ""
                  : resolvedGenerationText,
              // Generation already copied the finalized client receipts. Expose
              // that same snapshot now; durable completion still belongs to done.
              ...(result.actionResults?.length
                ? { actionResults: result.actionResults }
                : {}),
            });
            replyReadyPublished = true;
            // Bun's node:http compatibility layer can retain a small write
            // until the handler reaches its next I/O boundary.
            await new Promise<void>((resolve) => setImmediate(resolve));
          };
          const completeGeneration = (
            result: ChatGenerationResult,
          ): Promise<void> => {
            if (generationCompletion) return generationCompletion;
            generationCompletion = (async () => {
              generation.result = result;
              assertConversationConnectionRuntime(
                state.runtime,
                connectionDescriptor,
              );

              conv.updatedAt = new Date().toISOString();
              if (result.noResponseReason !== "ignored") {
                const resolvedText =
                  resolvedGenerationText ??
                  normalizeChatResponseText(
                    result.text,
                    state.logBuffer,
                    runtime,
                  );
                const visibleResolvedText =
                  result.transcriptVisibility === "internal"
                    ? ""
                    : resolvedText;
                if (
                  !disconnectTracker.isAborted() &&
                  !result.terminalFailure &&
                  !streamedText &&
                  resolvedText &&
                  result.transcriptVisibility !== "internal"
                ) {
                  for (const chunk of chunkVisibleTextForSse(resolvedText)) {
                    if (disconnectTracker.isAborted()) break;
                    streamedText += chunk;
                    tokenWriter.writeChunk(res, chunk, streamedText);
                  }
                }
                // The reply text is now authoritative: model generation, planner
                // actions, callback replacement, and final normalization have all
                // settled. Publish that boundary before durable persistence so
                // realtime voice can synthesize while the receipt/ids are written;
                // the later `done` frame remains the sole durable completion and
                // carries view-handoff metadata.
                await publishReplyReady(result);
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                // Durable completion belongs to the turn, not to the transport. A
                // disconnected client can retry the same key and receive this exact
                // committed outcome without executing or billing another model turn.
                const persistedAssistant = await resolvePersistedAssistantTurn(
                  runtime,
                  conv.roomId,
                  turnStartedAt,
                  result,
                  resolvedText,
                  channelType,
                  generationLease,
                  messageToStore.id,
                  assertLocalVoiceTurnFence,
                );
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const persistedAssistantId =
                  persistedAssistant.kind === "durable"
                    ? persistedAssistant.id
                    : undefined;
                if (
                  result.actionCallbackHistory?.length &&
                  persistedAssistantId
                ) {
                  await persistRecentAssistantActionCallbackHistory(
                    runtime,
                    conv.roomId,
                    result.actionCallbackHistory,
                    turnStartedAt,
                    persistedAssistantId,
                    generationLease,
                    assertLocalVoiceTurnFence,
                  );
                }
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const replyRecoveryAvailable =
                  await persistConversationReplyRecovery(
                    runtime,
                    conv.roomId,
                    messageToStore.id,
                    persistedAssistantId,
                    result,
                    generationLease,
                    assertLocalVoiceTurnFence,
                  );
                const outcome = buildGenerationMessageIdOutcome(
                  result,
                  visibleResolvedText,
                  persistedAssistantId,
                  {
                    userMessageId: messageToStore.id,
                    ...(persistedAssistant.kind === "ephemeral"
                      ? { assistantEphemeral: true }
                      : {}),
                    ...(result.usedActionCallbacks
                      ? { historyRefreshRequired: true }
                      : {}),
                  },
                );
                if (replyRecoveryAvailable)
                  outcome.replyRecoveryAvailable = true;
                if (persistedAssistant.kind === "durable") {
                  await settleDurableAssistantOutcome(outcome);
                } else {
                  await settleTurnReservation(outcome);
                }
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                if (!disconnectTracker.isAborted()) {
                  writeConversationDoneSse(res, outcome);
                }
              } else {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const outcome = buildGenerationMessageIdOutcome(
                  result,
                  "",
                  undefined,
                  {
                    userMessageId: messageToStore.id,
                    assistantEphemeral: true,
                  },
                );
                await settleTurnReservation(outcome);
                if (!disconnectTracker.isAborted()) {
                  writeConversationDoneSse(res, outcome);
                }
              }
              // Delivery is durable now, independently of post-turn reflection.
              // generateChatResponse still drains room-state work, and the outer
              // route retains its lease/server activity until that barrier settles.
              clearInterval(heartbeatInterval);
              finishStreamResponse();
              generationDelivered = true;
            })();
            return generationCompletion;
          };
          const result = await generateChatResponse(
            runtime,
            routedUserMessage,
            state.agentName,
            {
              traceId: trace.traceId,
              inferenceTimer,
              abortSignal: disconnectTracker.signal,
              roomHandlerLease: runtimeTurnLease,
              onStatus: (status) => {
                assertCurrentGenerationOwner();
                if (
                  disconnectTracker.isAborted() ||
                  disconnectTracker.checkConnectionClosed()
                ) {
                  return;
                }
                // Array.join renders absent optional fields as empty segments, so
                // the dedup key is stable without nullish-coalescing each field.
                const signature = [
                  status.kind,
                  status.actionName,
                  status.toolName,
                ].join(":");
                if (signature === lastStatusSignature) {
                  return;
                }
                lastStatusSignature = signature;
                writeChatStatusSse(res, status);
              },
              onToolEvent: (event) => {
                assertCurrentGenerationOwner();
                if (
                  disconnectTracker.isAborted() ||
                  disconnectTracker.checkConnectionClosed()
                ) {
                  return;
                }
                writeChatToolSse(res, event);
              },
              onChunk: (chunk, origin) => {
                if (!chunk) return;
                assertCurrentGenerationOwner();
                if (
                  disconnectTracker.isAborted() ||
                  disconnectTracker.checkConnectionClosed()
                ) {
                  return;
                }
                streamedText += chunk;
                // Action-callback text is provisional on the wire: the final reply
                // may replace it wholesale, and a voice client must not speak text
                // it cannot retract. Text rendering remains unchanged.
                tokenWriter.writeChunk(res, chunk, streamedText, {
                  provisional: origin === "action_callback",
                });
              },
              onSnapshot: (text, origin) => {
                if (!text) return;
                assertCurrentGenerationOwner();
                if (
                  disconnectTracker.isAborted() ||
                  disconnectTracker.checkConnectionClosed()
                ) {
                  return;
                }
                // Action callbacks may be the first visible source for a turn. An
                // authoritative snapshot therefore has to be able to establish the
                // stream, not merely revise text emitted by a model-token source.
                // Structured field extractors can briefly normalize whitespace or
                // closing punctuation while the same visible field is still
                // streaming. Do not shrink the user-visible token stream for
                // prefix-equivalent snapshots; later longer snapshots/deltas still
                // advance normally.
                if (
                  text.length < streamedText.length &&
                  streamedText.startsWith(text)
                ) {
                  return;
                }
                streamedText = text;
                tokenWriter.writeSnapshot(res, streamedText, {
                  provisional: origin === "action_callback",
                });
              },
              resolveNoResponseText: () => {
                assertCurrentGenerationOwner();
                return resolveNoResponseFallback(state.logBuffer, runtime);
              },
              onReplyReady: completeGeneration,
              preferredLanguage,
            },
          );
          // Adapters that do not publish the early callback still use the same
          // durable completion path. The promise fences repeated callbacks.
          await completeGeneration(result);
        } catch (err) {
          const generationResult = generation.result;
          // Post-delivery drain failure must reach the HTTP error boundary
          // without replacing the durable outcome or writing to its closed SSE.
          if (generationDelivered) throw err;
          let terminalError = err;
          try {
            assertConversationConnectionRuntime(
              state.runtime,
              connectionDescriptor,
            );
          } catch (runtimeError) {
            terminalError = runtimeError;
          }

          if (isConversationConnectionError(terminalError)) {
            logger.warn(
              {
                err: getErrorMessage(terminalError),
                conversationId: conv.id,
                roomId: conv.roomId,
              },
              "[ConversationStream] connection prerequisite failed",
            );
            releaseTurnReservation();
            if (!disconnectTracker.isAborted()) {
              writeSse(res, {
                type: "error",
                message: `Failed to refresh conversation room: ${getErrorMessage(terminalError)}`,
              });
            }
          } else if (isTurnAbortError(terminalError)) {
            logger.info(
              {
                conversationId: conv.id,
                roomId: conv.roomId,
                streamedTextLength: streamedText.length,
              },
              "[ConversationStream] generation aborted; persisting interrupted receipt",
            );
            // Stop/disconnect is a terminal outcome of the turn, not a
            // discarded one: persist the interrupted receipt (partial text or
            // the zero-token case) and settle the idempotency key so reload
            // recovery and a retried clientMessageId adopt this durable state
            // instead of regenerating (#17216).
            if (
              !getChatMessageIdOutcome(
                chatIdempotencyScope,
                clientMessageId ?? null,
              )
            ) {
              try {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const receiptId = crypto.randomUUID() as UUID;
                const persisted = await persistInterruptedAssistantReceipt(
                  runtime,
                  conv.roomId,
                  streamedText,
                  channelType,
                  messageToStore.id,
                  receiptId,
                  runtimeTurnLease,
                  assertLocalVoiceTurnFence,
                );
                conv.updatedAt = new Date().toISOString();
                const interruptedOutcome: ChatMessageIdOutcome = {
                  text: streamedText,
                  agentName: state.agentName,
                  ...(persisted.id ? { messageId: persisted.id } : {}),
                  userMessageId: messageToStore.id,
                  interrupted: true,
                };
                try {
                  await settleTurnReservation(interruptedOutcome);
                } catch (settlementError) {
                  assertLocalVoiceTurnFence();
                  // error-policy:J7 the receipt is already durable and remains
                  // recoverable through its deterministic in-reply-to link;
                  // preserve that terminal outcome locally while reporting the
                  // failed optimization that writes it onto the user marker.
                  settleTurnReservationInMemory(interruptedOutcome);
                  runtime.reportError(
                    "ConversationStream.interruptedReceiptSettlement",
                    settlementError,
                    {
                      conversationId: conv.id,
                      roomId: conv.roomId,
                      clientMessageId,
                      receiptId: persisted.id,
                    },
                  );
                  logger.warn(
                    {
                      err: getErrorMessage(settlementError),
                      conversationId: conv.id,
                      roomId: conv.roomId,
                      receiptId: persisted.id,
                    },
                    "[ConversationStream] interrupted receipt persisted but outcome marker settlement failed",
                  );
                }
                assertLocalVoiceTurnFence();
                if (!disconnectTracker.isAborted()) {
                  writeConversationDoneSse(res, interruptedOutcome);
                }
              } catch (persistErr) {
                // error-policy:J4 the interrupted receipt is best-effort
                // terminal state for an already-severed transport; on write
                // failure the key is released so the client's next send owns a
                // fresh turn rather than replaying a half-settled outcome.
                logger.warn(
                  {
                    err: getErrorMessage(persistErr),
                    conversationId: conv.id,
                    roomId: conv.roomId,
                  },
                  "[ConversationStream] failed to persist interrupted receipt",
                );
                releaseTurnReservation();
              }
            }
          } else if (
            isCallbackHistoryPersistenceError(terminalError) ||
            terminalError instanceof AssistantReplyPersistenceError
          ) {
            releaseTurnReservation();
            if (!disconnectTracker.isAborted()) {
              writeSse(res, {
                type: "error",
                message: getErrorMessage(
                  terminalError instanceof AssistantReplyPersistenceError
                    ? (terminalError.cause ?? terminalError)
                    : terminalError,
                ),
              });
            }
          } else if (!disconnectTracker.isAborted()) {
            // If text was already streamed to the client (e.g. the initial
            // response succeeded but planner follow-up failed), use the
            // streamed text as the final reply instead of replacing it with a
            // generic fallback.
            if (streamedText) {
              logger.warn(
                {
                  err: getErrorMessage(terminalError),
                  streamedTextLength: streamedText.length,
                },
                "Post-generation error after text was already streamed — using streamed text",
              );
              try {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const routeOwnedId = crypto.randomUUID() as UUID;
                const persisted = await persistAssistantConversationMemory(
                  runtime,
                  conv.roomId,
                  { text: streamedText, inReplyTo: messageToStore.id },
                  channelType,
                  turnStartedAt,
                  routeOwnedId,
                  runtimeTurnLease,
                  assertLocalVoiceTurnFence,
                );
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                conv.updatedAt = new Date().toISOString();
                const outcome: ChatMessageIdOutcome = {
                  text: streamedText,
                  agentName: state.agentName,
                  ...(persisted?.id ? { messageId: persisted.id } : {}),
                  userMessageId: messageToStore.id,
                };
                await settleTurnReservation(outcome);
                writeConversationDoneSse(res, outcome);
              } catch (persistErr) {
                releaseTurnReservation();
                writeSse(res, {
                  type: "error",
                  message: getErrorMessage(persistErr),
                });
              }
            } else {
              logger.warn(
                {
                  err: getErrorMessage(terminalError),
                  stack:
                    terminalError instanceof Error
                      ? terminalError.stack
                      : undefined,
                },
                "Chat generation failed with no streamed text",
              );
              try {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const generationResolvedText = generationResult
                  ? normalizeChatResponseText(
                      generationResult.text,
                      state.logBuffer,
                      runtime,
                    )
                  : "";
                const exactPersistedResponse =
                  generationResult &&
                  generationResult.transcriptVisibility !== "internal" &&
                  generationResolvedText
                    ? findPersistedGeneratedAssistantTurn(
                        runtime,
                        conv.roomId,
                        generationResult,
                      )
                    : null;
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const exactPersistedId = exactPersistedResponse?.id;
                if (
                  generationResult &&
                  exactPersistedResponse &&
                  exactPersistedId
                ) {
                  if (
                    exactPersistedResponse.content.text !==
                    generationResolvedText
                  ) {
                    await runtime.roomHandlerQueue.runInLease(
                      conv.roomId,
                      runtimeTurnLease,
                      async () => {
                        assertLocalVoiceTurnFence();
                        await runtime.updateMemory({
                          ...exactPersistedResponse,
                          content: buildPersistedAssistantContent(
                            generationResolvedText,
                            generationResult,
                            messageToStore.id,
                          ),
                        });
                        assertLocalVoiceTurnFence();
                      },
                    );
                    assertLocalVoiceTurnFence();
                  }
                  logger.warn(
                    {
                      err: getErrorMessage(terminalError),
                      conversationId: conv.id,
                      roomId: conv.roomId,
                      messageId: exactPersistedId,
                    },
                    "Chat generation failed after its exact assistant reply was already durable",
                  );
                  if (generationResult.actionCallbackHistory?.length) {
                    await persistRecentAssistantActionCallbackHistory(
                      runtime,
                      conv.roomId,
                      generationResult.actionCallbackHistory,
                      turnStartedAt,
                      exactPersistedId,
                      runtimeTurnLease,
                      assertLocalVoiceTurnFence,
                    );
                  }
                  assertConversationConnectionRuntime(
                    state.runtime,
                    connectionDescriptor,
                  );
                  const outcome = buildGenerationMessageIdOutcome(
                    generationResult,
                    generationResolvedText,
                    exactPersistedId,
                    {
                      userMessageId: messageToStore.id,
                      ...(generationResult.usedActionCallbacks
                        ? { historyRefreshRequired: true }
                        : {}),
                    },
                  );
                  await settleTurnReservation(outcome);
                  assertConversationConnectionRuntime(
                    state.runtime,
                    connectionDescriptor,
                  );
                  writeConversationDoneSse(res, outcome);
                  return true;
                }
              } catch (salvageErr) {
                // error-policy:J1 route boundary — this code already runs inside
                // the generation catch, so exact-row salvage failures require
                // their own observable SSE terminal instead of escaping silently.
                releaseTurnReservation();
                writeSse(res, {
                  type: "error",
                  message: getErrorMessage(salvageErr),
                });
                return true;
              }
              const providerIssueReply = getChatFailureReply(
                terminalError,
                state.logBuffer,
              );
              const failureKind = classifyChatFailure(
                terminalError,
                state.logBuffer,
              );
              try {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const routeOwnedId = crypto.randomUUID() as UUID;
                const persisted = await persistAssistantConversationMemory(
                  runtime,
                  conv.roomId,
                  { text: providerIssueReply, inReplyTo: messageToStore.id },
                  channelType,
                  undefined,
                  routeOwnedId,
                  runtimeTurnLease,
                  assertLocalVoiceTurnFence,
                );
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                conv.updatedAt = new Date().toISOString();
                const outcome: ChatMessageIdOutcome = {
                  text: providerIssueReply,
                  agentName: state.agentName,
                  ...(persisted?.id ? { messageId: persisted.id } : {}),
                  userMessageId: messageToStore.id,
                  failureKind,
                };
                await settleTurnReservation(outcome);
                writeConversationDoneSse(res, outcome);
              } catch (persistErr) {
                releaseTurnReservation();
                writeSse(res, {
                  type: "error",
                  message: getErrorMessage(persistErr),
                });
              }
            }
          } else {
            if (
              !getChatMessageIdOutcome(
                chatIdempotencyScope,
                clientMessageId ?? null,
              )
            ) {
              releaseTurnReservation();
            }
          }
        } finally {
          if (
            clientMessageId &&
            !getChatMessageIdOutcome(chatIdempotencyScope, clientMessageId)
          ) {
            releaseTurnReservation();
          }
          clearInterval(heartbeatInterval);
          try {
            finishStreamResponse();
          } finally {
            endActiveChatTurn();
          }
        }
        return true;
      } finally {
        await runtimeTurnLease.release();
        runtimeTurnLease = null;
      }
    } catch (streamError) {
      // error-policy:J2 context-adding rethrow: the terminal SSE `error` frame
      // is emitted here, then the original failure is rethrown unchanged to the
      // J1 HTTP boundary.
      // Everything past `initSse` reports failure as a structured SSE `error`
      // event; a throw out of turn setup must not become the one silent exit.
      try {
        if (!disconnectTracker.isAborted() && !res.writableEnded) {
          writeSse(res, {
            type: "error",
            message: getErrorMessage(streamError),
          });
        }
      } catch (frameError) {
        // error-policy:J6 best-effort teardown: the terminal frame is a
        // courtesy to a socket that is already gone, and the rethrow below
        // still carries the real failure to the J1 boundary.
        logger.warn(
          `[conversation-stream] terminal error frame undeliverable: ${getErrorMessage(frameError)}`,
        );
      }
      throw streamError;
    } finally {
      if (!reservationSettled) releaseTurnReservation();
      // The heartbeat timer and the SSE socket are owned by this request, not
      // by the HTTP error boundary that catches the rethrow above, so this is
      // the only place a failed turn can release them. Both calls are
      // idempotent: the ordinary exits already cleaned up and are unchanged.
      clearInterval(heartbeatInterval);
      finishStreamResponse();
    }
  }

  // ── POST /api/conversations/:id/messages ────────────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }
    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) return true;
    const {
      prompt,
      channelType,
      images,
      preferredLanguage,
      source,
      metadata: restMetadata,
      clientMessageId,
    } = chatPayload;
    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const inferenceTimer =
      getInferenceTimer() ??
      new InferenceTurnTimer({
        turnId: nextInferenceTurnId(),
        label: "chat-request",
        roomId: conv.roomId,
        t0EpochMs: requestStartedAt,
      });
    const caller = resolveConversationCaller(
      req,
      state,
      trustedApiPrincipal,
      runtime,
    );
    const userId = caller.entityId;
    const chatIdempotencyScope = buildConversationChatIdempotencyScope(
      runtime,
      conv.roomId,
      caller.entityId,
    );
    const chatFingerprint = buildConversationChatFingerprint({
      prompt,
      images,
      source,
      channelType,
      preferredLanguage,
      metadata: restMetadata,
    });
    const admissionDisconnectTracker = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation turn admission",
    });
    const idempotencyAdmission = await awaitConversationChatAdmission(
      chatIdempotencyScope,
      clientMessageId ?? null,
      chatFingerprint,
      admissionDisconnectTracker.signal,
    );
    if (idempotencyAdmission.kind === "aborted") {
      admissionDisconnectTracker.dispose();
      return true;
    }
    if (
      idempotencyAdmission.kind === "settled" &&
      !idempotencyAdmission.outcome.replyRecoveryAvailable
    ) {
      admissionDisconnectTracker.markCompleted();
      admissionDisconnectTracker.dispose();
      json(res, buildConversationJsonOutcome(idempotencyAdmission.outcome));
      return true;
    }
    if (idempotencyAdmission.kind === "conflict") {
      admissionDisconnectTracker.markCompleted();
      admissionDisconnectTracker.dispose();
      error(res, idempotencyAdmission.error.message, 409);
      return true;
    }
    const chatReservation =
      idempotencyAdmission.kind === "owner"
        ? idempotencyAdmission.reservation
        : null;
    let reservationSettled = false;
    let runtimeTurnLease: RoomHandlerLease | null = null;
    const releaseTurnReservation = () =>
      releaseChatMessageId(
        chatIdempotencyScope,
        clientMessageId ?? null,
        chatReservation,
      );
    const settleTurnReservation = async (
      outcome: ChatMessageIdOutcome,
    ): Promise<void> => {
      if (clientMessageId) {
        if (!runtimeTurnLease) {
          throw new ElizaError("Chat outcome has no live room ownership", {
            code: "CHAT_IDEMPOTENCY_LEASE_MISSING",
            context: { roomId: conv.roomId, clientMessageId },
          });
        }
        await persistDurableConversationChatOutcome(
          runtime,
          conv.roomId,
          chatIdempotencyScope,
          clientMessageId,
          chatFingerprint,
          outcome,
          runtimeTurnLease,
        );
      }
      setChatMessageIdOutcome(
        chatIdempotencyScope,
        clientMessageId ?? null,
        outcome,
        chatReservation,
      );
      reservationSettled = true;
    };
    try {
      try {
        runtimeTurnLease = await runWithInferenceTiming(inferenceTimer, () =>
          timeInferenceSpan("chat:room-lease-wait", () =>
            runtime.roomHandlerQueue.acquire(
              conv.roomId,
              admissionDisconnectTracker.signal,
            ),
          ),
        );
      } catch (err) {
        admissionDisconnectTracker.dispose();
        releaseTurnReservation();
        if (admissionDisconnectTracker.isAborted()) {
          return true;
        }
        error(
          res,
          isRoomQueueBackpressureError(err)
            ? "Conversation is busy; retry after the pending turns finish"
            : `Failed to serialize conversation turn: ${getErrorMessage(err)}`,
          roomQueueAdmissionStatus(err),
        );
        return true;
      }
      admissionDisconnectTracker.markCompleted();
      admissionDisconnectTracker.dispose();

      try {
        if (
          state.conversations.get(conv.id) !== conv ||
          state.deletedConversationIds.has(conv.id)
        ) {
          releaseTurnReservation();
          error(res, "Conversation was deleted", 404);
          return true;
        }
        const durableRecovery = await recoverDurableConversationChatOutcome(
          runtime,
          conv.roomId,
          chatIdempotencyScope,
          clientMessageId,
          chatFingerprint,
          state.agentName,
          runtimeTurnLease,
        );
        if (durableRecovery.kind === "conflict") {
          releaseTurnReservation();
          error(res, durableRecovery.error.message, 409);
          return true;
        }
        if (durableRecovery.kind === "settled") {
          await settleTurnReservation(durableRecovery.outcome);
          json(res, buildConversationJsonOutcome(durableRecovery.outcome));
          return true;
        }
        let connectionDescriptor: ConversationConnectionDescriptor;
        try {
          connectionDescriptor = await ensureConversationRoom(
            state,
            runtime,
            conv,
            caller,
          );
        } catch (err) {
          releaseTurnReservation();
          error(
            res,
            `Failed to initialize conversation room: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }

        let userMessages: Awaited<ReturnType<typeof buildUserMessages>>;
        try {
          const pendantProvenance = await verifyCanonicalPendantProvenance(
            runtime,
            caller,
            prompt,
            restMetadata,
          );
          userMessages = await buildUserMessages({
            images,
            prompt,
            userId,
            agentId: runtime.agentId,
            roomId: conv.roomId,
            channelType,
            messageSource: pendantProvenance ? "pendant" : source,
            metadata: restMetadata,
          });
          if (pendantProvenance) {
            stampCanonicalPendantMemory(userMessages, pendantProvenance);
          }
        } catch (err) {
          releaseTurnReservation();
          error(
            res,
            `Failed to prepare user message: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }
        bindClientUserMemoryId(
          clientMessageId ?? null,
          chatIdempotencyScope,
          chatFingerprint,
          userMessages,
        );
        const { userMessage, messageToStore } = userMessages;
        try {
          await attestAuthenticatedApiDeliveryAudience(
            runtime,
            userMessage,
            trustedApiPrincipal,
          );
        } catch (err) {
          releaseTurnReservation();
          error(
            res,
            `Failed to attest conversation audience: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }

        const routedUserMessage = withViewInteractionClient(userMessage, req);
        const turnStartedAt = Date.now();

        try {
          assertConversationConnectionRuntime(
            state.runtime,
            connectionDescriptor,
          );
          await persistClientUserMemory(
            runtime,
            messageToStore,
            clientMessageId ?? null,
            runtimeTurnLease,
          );
          assertConversationConnectionRuntime(
            state.runtime,
            connectionDescriptor,
          );
        } catch (err) {
          releaseTurnReservation();
          error(
            res,
            `Failed to store user message: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }

        const endActiveChatTurn = beginActiveChatTurn(state);
        let generationDelivered = false;
        try {
          const deliveryLease = runtimeTurnLease;
          let generationCompletion: Promise<void> | undefined;
          const completeGeneration = (
            result: ChatGenerationResult,
          ): Promise<void> => {
            if (generationCompletion) return generationCompletion;
            generationCompletion = (async () => {
              assertConversationConnectionRuntime(
                state.runtime,
                connectionDescriptor,
              );

              conv.updatedAt = new Date().toISOString();
              if (result.noResponseReason !== "ignored") {
                const resolvedText = normalizeChatResponseText(
                  result.text,
                  state.logBuffer,
                  runtime,
                );
                const persistedAssistant = await resolvePersistedAssistantTurn(
                  runtime,
                  conv.roomId,
                  turnStartedAt,
                  result,
                  resolvedText,
                  channelType,
                  deliveryLease,
                  messageToStore.id,
                );
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const persistedAssistantId =
                  persistedAssistant.kind === "durable"
                    ? persistedAssistant.id
                    : undefined;
                if (
                  result.actionCallbackHistory?.length &&
                  persistedAssistantId
                ) {
                  await persistRecentAssistantActionCallbackHistory(
                    runtime,
                    conv.roomId,
                    result.actionCallbackHistory,
                    turnStartedAt,
                    persistedAssistantId,
                    deliveryLease,
                  );
                }
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const visibleResolvedText =
                  result.transcriptVisibility === "internal"
                    ? ""
                    : resolvedText;
                const replyRecoveryAvailable =
                  await persistConversationReplyRecovery(
                    runtime,
                    conv.roomId,
                    messageToStore.id,
                    persistedAssistantId,
                    result,
                    deliveryLease,
                  );
                const outcome = buildGenerationMessageIdOutcome(
                  result,
                  visibleResolvedText,
                  persistedAssistantId,
                  {
                    userMessageId: messageToStore.id,
                    ...(persistedAssistant.kind === "ephemeral"
                      ? { assistantEphemeral: true }
                      : {}),
                    ...(result.usedActionCallbacks
                      ? { historyRefreshRequired: true }
                      : {}),
                  },
                );
                if (replyRecoveryAvailable)
                  outcome.replyRecoveryAvailable = true;
                await settleTurnReservation(outcome);
                json(res, buildConversationJsonOutcome(outcome));
              } else {
                assertConversationConnectionRuntime(
                  state.runtime,
                  connectionDescriptor,
                );
                const outcome = buildGenerationMessageIdOutcome(
                  result,
                  "",
                  undefined,
                  {
                    userMessageId: messageToStore.id,
                    assistantEphemeral: true,
                  },
                );
                await settleTurnReservation(outcome);
                json(res, buildConversationJsonOutcome(outcome));
              }
              generationDelivered = true;
            })();
            return generationCompletion;
          };
          const result = await generateChatResponse(
            runtime,
            routedUserMessage,
            state.agentName,
            {
              inferenceTimer,
              roomHandlerLease: runtimeTurnLease,
              resolveNoResponseText: () =>
                resolveNoResponseFallback(state.logBuffer, runtime),
              preferredLanguage,
              onReplyReady: completeGeneration,
            },
          );
          // Compatibility adapters may omit the early callback; the promise
          // fence ensures durable completion and JSON are still emitted once.
          await completeGeneration(result);
        } catch (err) {
          if (generationDelivered) {
            // error-policy:J7 The durable reply and idempotency outcome already
            // reached the caller; report a later drain failure without replying
            // again (develop #31349 contract).
            runtime.reportError("ConversationJson.postDelivery", err, {
              conversationId: conv.id,
              roomId: conv.roomId,
              clientMessageId,
            });
            return true;
          }
          if (
            isCallbackHistoryPersistenceError(err) ||
            err instanceof AssistantReplyPersistenceError
          ) {
            releaseTurnReservation();
            error(
              res,
              getErrorMessage(
                err instanceof AssistantReplyPersistenceError
                  ? (err.cause ?? err)
                  : err,
              ),
              500,
            );
            return true;
          }
          logger.warn(
            `[conversations] POST /messages failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (isConversationConnectionError(err)) {
            releaseTurnReservation();
            error(
              res,
              `Failed to refresh conversation room: ${getErrorMessage(err)}`,
              500,
            );
            return true;
          }
          const providerIssueReply = getChatFailureReply(err, state.logBuffer);
          const failureKind = classifyChatFailure(err, state.logBuffer);
          try {
            assertConversationConnectionRuntime(
              state.runtime,
              connectionDescriptor,
            );
            const routeOwnedId = crypto.randomUUID() as UUID;
            const persisted = await persistAssistantConversationMemory(
              runtime,
              conv.roomId,
              { text: providerIssueReply, inReplyTo: messageToStore.id },
              channelType,
              undefined,
              routeOwnedId,
              runtimeTurnLease,
            );
            assertConversationConnectionRuntime(
              state.runtime,
              connectionDescriptor,
            );
            conv.updatedAt = new Date().toISOString();
            const outcome: ChatMessageIdOutcome = {
              text: providerIssueReply,
              agentName: state.agentName,
              ...(persisted?.id ? { messageId: persisted.id } : {}),
              userMessageId: messageToStore.id,
              failureKind,
            };
            await settleTurnReservation(outcome);
            json(res, buildConversationJsonOutcome(outcome));
          } catch (persistErr) {
            releaseTurnReservation();
            error(res, getErrorMessage(persistErr), 500);
          }
        } finally {
          if (
            clientMessageId &&
            !getChatMessageIdOutcome(chatIdempotencyScope, clientMessageId)
          ) {
            releaseTurnReservation();
          }
          endActiveChatTurn();
        }
        return true;
      } finally {
        await runtimeTurnLease.release();
        runtimeTurnLease = null;
      }
    } finally {
      if (!reservationSettled) releaseTurnReservation();
    }
  }

  // ── POST /api/conversations/:id/greeting ───────────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/greeting$/.test(pathname)
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const lang = url.searchParams.get("lang") ?? "en";

    const greetingAbortTracker = createRequestDisconnectAbortTracker({
      req,
      res,
      operation: "Conversation greeting admission",
    });
    let historyLease: RoomHandlerLease;
    try {
      historyLease = await runtime.roomHandlerQueue.acquire(
        conv.roomId,
        greetingAbortTracker.signal,
      );
    } catch (err) {
      greetingAbortTracker.dispose();
      if (greetingAbortTracker.isAborted()) return true;
      error(
        res,
        isRoomQueueBackpressureError(err)
          ? "Conversation is busy; retry after the pending turns finish"
          : `Failed to serialize conversation history: ${getErrorMessage(err)}`,
        roomQueueAdmissionStatus(err),
      );
      return true;
    }
    greetingAbortTracker.markCompleted();
    greetingAbortTracker.dispose();
    try {
      if (
        state.conversations.get(conv.id) !== conv ||
        state.deletedConversationIds.has(conv.id)
      ) {
        error(res, "Conversation was deleted", 404);
        return true;
      }
      try {
        await ensureConversationRoom(
          state,
          runtime,
          conv,
          resolveConversationCaller(req, state, trustedApiPrincipal, runtime),
        );
      } catch (err) {
        error(
          res,
          `Failed to initialize conversation room: ${getErrorMessage(err)}`,
          500,
        );
        return true;
      }
      const greeting = await ensureConversationGreetingStored(
        state,
        conv,
        lang,
        historyLease,
      );
      json(res, {
        text: greeting.text,
        agentName: greeting.agentName,
        generated: greeting.generated,
        persisted: greeting.persisted,
      });
    } catch (err) {
      error(res, getErrorMessage(err), 500);
    } finally {
      await historyLease.release();
    }
    return true;
  }

  // ── PATCH /api/conversations/:id ────────────────────────────────────
  if (
    method === "PATCH" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
    const rawPatch = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawPatch === null) return true;
    const parsedPatch = PatchConversationRequestSchema.safeParse(rawPatch);
    if (!parsedPatch.success) {
      error(
        res,
        parsedPatch.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedPatch.data;

    if (body.generate) {
      if (!state.runtime) {
        error(res, "Agent is not running", 503);
        return true;
      }
      // Get the last user message to use as the prompt for generation
      let prompt = "A generic conversation";
      const memories = await state.runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
      });
      const lastUserMemory = memories.find(
        (m) => m.entityId !== state.runtime?.agentId,
      );
      if (lastUserMemory?.content?.text) {
        prompt = String(lastUserMemory.content.text);
      }

      const titleAbortTracker = createRequestDisconnectAbortTracker({
        req,
        res,
        operation: "conversation title generation",
      });
      let newTitle: string | null = null;
      try {
        newTitle = await generateConversationTitle(
          state.runtime,
          prompt,
          state.agentName,
          { signal: titleAbortTracker.signal },
        );
      } finally {
        titleAbortTracker.markCompleted();
        titleAbortTracker.dispose();
      }
      if (titleAbortTracker.isAborted()) return true;

      const fallbackTitle = prompt
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 5)
        .join(" ")
        .trim();
      const resolvedTitle = newTitle ?? fallbackTitle;

      if (resolvedTitle) {
        conv.title = resolvedTitle;
        conv.updatedAt = new Date().toISOString();
        await syncConversationRoomState(state, conv);
      }
    } else if (body.title?.trim()) {
      conv.title = body.title.trim();
      conv.updatedAt = new Date().toISOString();
      await syncConversationRoomState(state, conv);
    }

    if (body.metadata !== undefined) {
      const nextMetadata = sanitizeConversationMetadata(body.metadata);
      if (nextMetadata) {
        conv.metadata = nextMetadata;
      } else {
        delete conv.metadata;
      }
      conv.updatedAt = new Date().toISOString();
      await syncConversationRoomState(state, conv);
    }
    json(res, { conversation: conv });
    return true;
  }

  // ── POST /api/conversations/cleanup-empty ───────────────────────────
  if (method === "POST" && pathname === "/api/conversations/cleanup-empty") {
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
    const rawCleanup = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawCleanup === null) return true;
    const parsedCleanup =
      PostConversationCleanupEmptyRequestSchema.safeParse(rawCleanup);
    if (!parsedCleanup.success) {
      error(
        res,
        parsedCleanup.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    await waitForConversationRestore(state);
    const runtime = state.runtime;
    if (!runtime) {
      json(res, { deleted: [] });
      return true;
    }
    const keepId = parsedCleanup.data.keepId;
    const agentId = runtime.agentId;
    const deleted: string[] = [];
    for (const conv of Array.from(state.conversations.values())) {
      if (keepId && conv.id === keepId) continue;
      if (state.deletedConversationIds.has(conv.id)) continue;
      const cleanupAbortTracker = createRequestDisconnectAbortTracker({
        req,
        res,
        operation: "Empty conversation cleanup admission",
      });
      let historyLease: RoomHandlerLease;
      try {
        historyLease = await runtime.roomHandlerQueue.acquire(
          conv.roomId,
          cleanupAbortTracker.signal,
        );
      } catch (err) {
        cleanupAbortTracker.dispose();
        if (cleanupAbortTracker.isAborted()) return true;
        error(
          res,
          isRoomQueueBackpressureError(err)
            ? "Conversation is busy; retry cleanup after pending turns finish"
            : `Failed to serialize conversation cleanup: ${getErrorMessage(err)}`,
          roomQueueAdmissionStatus(err),
        );
        return true;
      }
      cleanupAbortTracker.markCompleted();
      cleanupAbortTracker.dispose();
      try {
        if (
          state.conversations.get(conv.id) !== conv ||
          state.deletedConversationIds.has(conv.id)
        ) {
          continue;
        }
        const memories = await runtime.getMemories({
          roomId: conv.roomId,
          tableName: "messages",
        });
        const hasUserMessage = memories.some((m) => m.entityId !== agentId);
        if (hasUserMessage) continue;
        const memoryIds = memories
          .map((memory) => memory.id)
          .filter(
            (memoryId): memoryId is UUID =>
              typeof memoryId === "string" && memoryId.trim().length > 0,
          );
        if (memoryIds.length > 0) {
          await runtime.roomHandlerQueue.runInLease(
            conv.roomId,
            historyLease,
            () => deleteConversationMemories(runtime, memoryIds),
          );
        }
        await deleteConversationRoomData(runtime, conv.roomId);
        state.conversations.delete(conv.id);
        markConversationDeleted(state, conv.id);
        deleted.push(conv.id);
      } finally {
        await historyLease.release();
      }
    }
    json(res, { deleted });
    return true;
  }

  // ── DELETE /api/conversations/:id ───────────────────────────────────
  if (
    method === "DELETE" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
    const convId = decodePathComponent(
      pathname.split("/")[3],
      res,
      "conversation id",
    );
    if (convId === null) return true;
    const conv = await getConversationWithRestore(state, convId);
    const runtime = state.runtime;
    if (conv?.roomId && runtime) {
      const deleteConversationAbortTracker =
        createRequestDisconnectAbortTracker({
          req,
          res,
          operation: "Conversation deletion admission",
        });
      let historyLease: RoomHandlerLease;
      try {
        historyLease = await runtime.roomHandlerQueue.acquire(
          conv.roomId,
          deleteConversationAbortTracker.signal,
        );
      } catch (err) {
        deleteConversationAbortTracker.dispose();
        if (deleteConversationAbortTracker.isAborted()) return true;
        error(
          res,
          isRoomQueueBackpressureError(err)
            ? "Conversation is busy; retry deletion after pending turns finish"
            : `Failed to serialize conversation deletion: ${getErrorMessage(err)}`,
          roomQueueAdmissionStatus(err),
        );
        return true;
      }
      deleteConversationAbortTracker.markCompleted();
      deleteConversationAbortTracker.dispose();
      try {
        if (
          state.conversations.get(conv.id) !== conv ||
          state.deletedConversationIds.has(conv.id)
        ) {
          json(res, { ok: true });
          return true;
        }
        try {
          const memories = await runtime.getMemories({
            roomId: conv.roomId,
            tableName: "messages",
          });
          const memoryIds = memories
            .map((memory) => memory.id)
            .filter(
              (memoryId): memoryId is UUID =>
                typeof memoryId === "string" && memoryId.trim().length > 0,
            );
          if (memoryIds.length > 0) {
            await runtime.roomHandlerQueue.runInLease(
              conv.roomId,
              historyLease,
              () => deleteConversationMemories(runtime, memoryIds),
            );
          }
        } catch (err) {
          // error-policy:J1 deletion must not create a tombstone while message
          // rows remain; report the failed operation to the caller.
          error(
            res,
            `Failed to delete conversation messages: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }
        try {
          await deleteConversationRoomData(runtime, conv.roomId);
        } catch (err) {
          if (isConversationConnectionError(err)) {
            error(
              res,
              `Failed to serialize conversation deletion: ${getErrorMessage(err)}`,
              503,
            );
            return true;
          }
          // error-policy:J1 an incomplete room deletion is a route failure, not a
          // successful tombstone-only delete.
          error(
            res,
            `Failed to delete conversation room: ${getErrorMessage(err)}`,
            500,
          );
          return true;
        }
        state.conversations.delete(convId);
        markConversationDeleted(state, convId);
        json(res, { ok: true });
        return true;
      } finally {
        await historyLease.release();
      }
    }
    state.conversations.delete(convId);
    markConversationDeleted(state, convId);
    json(res, { ok: true });
    return true;
  }

  return false;
}
