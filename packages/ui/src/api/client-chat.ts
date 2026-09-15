/**
 * Chat domain methods — chat, conversations, documents, memory, MCP,
 * share ingest, workbench, trajectories, database.
 */

import type {
  DatabaseProviderType,
  PostInboxMessageRequest,
} from "@elizaos/shared";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { ElizaClient, isRemoteRelayRestAdapterBase } from "./client-base";
import type {
  AccountConnectRequest,
  ApiError,
  ChatActionResultSummary,
  ChatFailureKind,
  ChatTerminalFailure,
  ChatTokenUsage,
  ChatToolCallEvent,
  ChatTurnStatus,
  ConnectionTestResult,
  ContentBlock,
  Conversation,
  ConversationChannelType,
  ConversationGreeting,
  ConversationMessage,
  ConversationMessageSearchResponse,
  ConversationMetadata,
  CreateConversationOptions,
  DatabaseConfigResponse,
  DatabaseStatus,
  DocumentBulkUploadResult,
  DocumentDetail,
  DocumentFacetCountsResponse,
  DocumentFragmentsResponse,
  DocumentScope,
  DocumentSearchResponse,
  DocumentStats,
  DocumentsResponse,
  DocumentUpdateResult,
  DocumentUploadResult,
  ImageAttachment,
  LocalInferenceChatMetadata,
  McpMarketplaceResult,
  McpRegistryServerDetail,
  McpServerConfig,
  McpServerStatus,
  MemoryBrowseQuery,
  MemoryBrowseResponse,
  MemoryFeedQuery,
  MemoryFeedResponse,
  MemoryRememberResponse,
  MemorySearchResponse,
  MemoryStatsResponse,
  PostWorkbenchVfsPromoteToCloudRequest,
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
  QueryResult,
  QuickContextResponse,
  RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerResponse,
  ShareIngestItem,
  ShareIngestPayload,
  SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerResponse,
  TableInfo,
  TableRowsResponse,
  TrajectoryConfig,
  TrajectoryDetailResult,
  TrajectoryExportOptions,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectoryStats,
  WorkbenchLoadedVfsPlugin,
  WorkbenchOverview,
  WorkbenchTask,
  WorkbenchTodo,
  WorkbenchVfsCompileResult,
  WorkbenchVfsDiffEntry,
  WorkbenchVfsEntry,
  WorkbenchVfsProject,
  WorkbenchVfsQuota,
  WorkbenchVfsSnapshot,
} from "./client-types";
import { isDesktopExternalApiBaseUrl } from "./desktop-external-api-base";
import { isDesktopLocalApiBaseUrl } from "./desktop-local-api-base";

type DocumentListOptions = {
  limit?: number;
  offset?: number;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedBy?: string;
  query?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  tags?: string[];
  /** Media-format facet (#13594): image | audio | video | pdf | text |
   *  transcript | file. Matched server-side against `metadata.mediaFormat` or
   *  the `media-format:<format>` tag (#13593). */
  mediaFormat?: string;
  /** Source-room filter (#13593): scope the list to one chat/room. */
  roomId?: string;
  /** Knowledge-hub display facet (#13594): all | doc | image | audio | video |
   *  transcript. Server-side coarse bucket so the list is drawn from the whole
   *  store, not the client's first page. `doc` groups pdf/text/file. */
  knowledgeFacet?: string;
};

type DocumentUploadRequest = {
  content: string;
  filename: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  entityId?: string;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedFrom?: string;
};

type DocumentUrlUploadOptions = {
  includeImageDescriptions?: boolean;
  metadata?: Record<string, unknown>;
  entityId?: string;
  scope?: DocumentScope;
  scopedToEntityId?: string;
};

type DocumentSearchMode = "hybrid" | "vector" | "keyword";

type DocumentSearchOptions = {
  threshold?: number;
  limit?: number;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedBy?: string;
  query?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  tags?: string[];
  mediaFormat?: string;
  roomId?: string;
  knowledgeFacet?: string;
  searchMode?: DocumentSearchMode;
};

type InboxMessagesOptions = {
  limit?: number;
  sources?: string[];
  roomId?: string;
  roomSource?: string;
};

type InboxChatsOptions = { sources?: string[] };

function setPositiveNumberParam(
  params: URLSearchParams,
  key: string,
  value: number | undefined,
): void {
  if (typeof value === "number" && value > 0) params.set(key, String(value));
}

function setTruthyNumberParam(
  params: URLSearchParams,
  key: string,
  value: number | undefined,
): void {
  if (value) params.set(key, String(value));
}

function setDefinedNumberParam(
  params: URLSearchParams,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) params.set(key, String(value));
}

function setNonEmptyStringParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (typeof value === "string" && value.length > 0) params.set(key, value);
}

function setTruthyStringParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (value) params.set(key, value);
}

function appendTagsParam(
  params: URLSearchParams,
  tags: string[] | undefined,
): void {
  for (const tag of tags ?? []) params.append("tag", tag);
}

function buildSourcesParams(sources: string[] | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (sources && sources.length > 0) params.set("sources", sources.join(","));
  return params;
}

function buildInboxMessagesParams(
  options: InboxMessagesOptions | undefined,
): URLSearchParams {
  const params = buildSourcesParams(options?.sources);
  setPositiveNumberParam(params, "limit", options?.limit);
  setNonEmptyStringParam(params, "roomId", options?.roomId);
  setNonEmptyStringParam(params, "roomSource", options?.roomSource);
  return params;
}

function buildInboxMessagesRpcParams(
  options: InboxMessagesOptions | undefined,
): InboxMessagesOptions {
  const params: InboxMessagesOptions = {};
  if (typeof options?.limit === "number" && options.limit > 0) {
    params.limit = options.limit;
  }
  if (options?.sources && options.sources.length > 0) {
    params.sources = options.sources;
  }
  if (typeof options?.roomId === "string" && options.roomId.length > 0) {
    params.roomId = options.roomId;
  }
  if (
    typeof options?.roomSource === "string" &&
    options.roomSource.length > 0
  ) {
    params.roomSource = options.roomSource;
  }
  return params;
}

function buildInboxChatsRpcParams(
  options: InboxChatsOptions | undefined,
): InboxChatsOptions {
  return options?.sources && options.sources.length > 0
    ? { sources: options.sources }
    : {};
}

function appendDocumentFilterParams(
  params: URLSearchParams,
  options: DocumentListOptions | DocumentSearchOptions | undefined,
): void {
  setTruthyStringParam(params, "scope", options?.scope);
  setTruthyStringParam(params, "scopedToEntityId", options?.scopedToEntityId);
  setTruthyStringParam(params, "addedBy", options?.addedBy);
  setTruthyStringParam(params, "timeRangeStart", options?.timeRangeStart);
  setTruthyStringParam(params, "timeRangeEnd", options?.timeRangeEnd);
  setTruthyStringParam(params, "mediaFormat", options?.mediaFormat);
  setTruthyStringParam(params, "roomId", options?.roomId);
  setTruthyStringParam(params, "knowledgeFacet", options?.knowledgeFacet);
  appendTagsParam(params, options?.tags);
}

function buildDocumentListParams(
  options: DocumentListOptions | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  setTruthyNumberParam(params, "limit", options?.limit);
  setTruthyNumberParam(params, "offset", options?.offset);
  if (options?.query) params.set("q", options.query);
  appendDocumentFilterParams(params, options);
  return params;
}

function buildDocumentSearchParams(
  query: string,
  options: DocumentSearchOptions | undefined,
): URLSearchParams {
  const params = new URLSearchParams({ q: query });
  setDefinedNumberParam(params, "threshold", options?.threshold);
  setDefinedNumberParam(params, "limit", options?.limit);
  setTruthyStringParam(params, "query", options?.query);
  setTruthyStringParam(params, "searchMode", options?.searchMode);
  appendDocumentFilterParams(params, options);
  return params;
}

function buildTrajectoryParams(
  options: TrajectoryListOptions | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  setTruthyNumberParam(params, "limit", options?.limit);
  setTruthyNumberParam(params, "offset", options?.offset);
  setTruthyStringParam(params, "roomId", options?.roomId);
  setTruthyStringParam(params, "source", options?.source);
  setTruthyStringParam(params, "scenarioId", options?.scenarioId);
  setTruthyStringParam(params, "batchId", options?.batchId);
  setTruthyStringParam(params, "status", options?.status);
  setTruthyStringParam(params, "startDate", options?.startDate);
  setTruthyStringParam(params, "endDate", options?.endDate);
  setTruthyStringParam(params, "search", options?.search);
  return params;
}

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    sendChatRest(
      text: string,
      channelType?: ConversationChannelType,
    ): Promise<{
      text: string;
      agentName: string;
      noResponseReason?: "ignored";
      failureKind?: ChatFailureKind;
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
      localInference?: LocalInferenceChatMetadata;
      actionResults?: ChatActionResultSummary[];
    }>;
    sendChatMessage(text: string, channelType?: ConversationChannelType): void;
    sendChatStream(
      text: string,
      onToken: (token: string, accumulatedText?: string) => void,
      channelType?: ConversationChannelType,
      signal?: AbortSignal,
    ): Promise<{
      text: string;
      agentName: string;
      completed: boolean;
      noResponseReason?: "ignored";
      usage?: ChatTokenUsage;
      failureKind?: ChatFailureKind;
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
      localInference?: LocalInferenceChatMetadata;
      actionResults?: ChatActionResultSummary[];
    }>;
    listConversations(options?: {
      signal?: AbortSignal;
    }): Promise<{ conversations: Conversation[] }>;
    createConversation(
      title?: string,
      options?: CreateConversationOptions,
    ): Promise<{
      conversation: Conversation;
      greeting?: ConversationGreeting;
    }>;
    getConversationMessages(
      id: string,
      options?: {
        signal?: AbortSignal;
        /**
         * When set, load a window CENTERED on this message id instead of the
         * default recent window — so a keyword-search jump can scroll to a hit
         * older than the most-recent turns (#9955). Bypasses the desktop-bridge
         * RPC fast path (which only knows the recent window).
         */
        around?: string;
        /**
         * When set, load one page STRICTLY OLDER than this createdAt cursor for
         * the infinite upward scroll (#13532) — the client passes the createdAt
         * of its current oldest message and prepends the returned page. Forces
         * the HTTP path (the desktop-bridge RPC only serves the recent window)
         * and makes the response carry `hasMore`.
         */
        before?: number;
        /** Older-page size for the `before` cursor path. Server-clamped. */
        limit?: number;
      },
    ): Promise<{ messages: ConversationMessage[]; hasMore?: boolean }>;
    /**
     * Keyword search across every conversation the user can see, ranked by
     * relevance then recency. Backs the chat message-search affordance.
     * `since`/`until` (epoch ms, inclusive) scope the search to a time window
     * — e.g. "messages from about a year ago" — applied in the store before
     * ranking, so old hits are found rather than recency-truncated.
     */
    searchConversationMessages(
      query: string,
      options?: {
        limit?: number;
        offset?: number;
        since?: number;
        until?: number;
        signal?: AbortSignal;
      },
    ): Promise<ConversationMessageSearchResponse>;
    /**
     * Fetch the cross-channel inbox. Returns the most recent
     * messages across every connector room the agent participates in,
     * time-ordered newest first. Each message carries its `source`
     * tag (imessage / telegram / discord / etc.) so the UI can render
     * per-source styling without a second lookup.
     *
     * When `roomId` is provided the server scopes the query to that
     * single connector room — use this when the messages view
     * has a specific chat selected. When `roomId` is omitted the feed
     * merges every room's recent messages.
     */
    getInboxMessages(options?: {
      limit?: number;
      sources?: string[];
      roomId?: string;
      roomSource?: string;
    }): Promise<{
      messages: Array<ConversationMessage & { roomId: string; source: string }>;
      count: number;
    }>;
    /**
     * List the distinct connector source tags the agent currently has
     * inbox messages for. Used by the inbox UI to build the
     * source filter chip list dynamically.
     */
    getInboxSources(): Promise<{ sources: string[] }>;
    /**
     * List every connector chat thread the agent participates in as
     * one sidebar-friendly row per external chat room. Each row carries
     * the room id (for selection), source tag, display title,
     * last-message preview, last-message timestamp, and a total message
     * count. Used by the messages sidebar to render connector
     * chats alongside dashboard conversations.
     */
    getInboxChats(options?: { sources?: string[] }): Promise<{
      chats: Array<{
        canSend?: boolean;
        id: string;
        source: string;
        transportSource?: string;
        /** Owning server/world id when the connector exposes one. */
        worldId?: string;
        /** User-facing server/world label for selectors and section headers. */
        worldLabel: string;
        /**
         * Normalized room kind — "DM" for 1:1 direct messages. Optional
         * because not every connector tags rooms.
         */
        roomType?: string;
        muted?: boolean;
        mutedScope?: "room" | "server";
        title: string;
        avatarUrl?: string;
        lastMessageText: string;
        lastMessageAt: number;
        messageCount: number;
      }>;
      count: number;
    }>;
    setInboxChatMute(data: {
      action: "mute" | "unmute";
      durationMinutes?: number;
      roomId: string;
      scope?: "room" | "server";
    }): Promise<{
      ok: boolean;
      roomId: string;
      action: "mute" | "unmute";
      scope: "room" | "server";
      muted?: boolean;
      mutedScope?: "room" | "server";
    }>;
    sendInboxMessage(data: PostInboxMessageRequest): Promise<{
      ok: boolean;
      message?: ConversationMessage & { roomId: string; source: string };
    }>;
    truncateConversationMessages(
      id: string,
      messageId: string,
      options?: { inclusive?: boolean },
    ): Promise<{ ok: boolean; deletedCount: number }>;
    /**
     * Delete a single message from a conversation and its backing memory row
     * (#13533). Persists across reloads — distinct from the local-only
     * suggestion dismissal (#8792) and from truncate (edit-and-resend).
     */
    deleteConversationMessage(
      id: string,
      messageId: string,
    ): Promise<{ ok: boolean; deletedCount: number }>;
    retryConversationReply(
      id: string,
      messageId: string,
    ): Promise<{
      text: string;
      agentName: string;
      messageId: string;
      userMessageId: string;
      actionResults?: ChatActionResultSummary[];
    }>;
    sendConversationMessage(
      id: string,
      text: string,
      channelType?: ConversationChannelType,
      images?: ImageAttachment[],
      metadata?: Record<string, unknown>,
    ): Promise<{
      text: string;
      agentName: string;
      interrupted?: boolean;
      transcriptVisibility?: "internal";
      blocks?: ContentBlock[];
      noResponseReason?: "ignored";
      /**
       * Set when chat generation threw and the server returned a
       * fallback message in `text`. Renderer keys off
       * `failureKind === "no_provider"` to gate the chat input on a
       * "Connect a provider" CTA instead of treating the fallback
       * as a normal assistant reply.
       */
      failureKind?: ChatFailureKind;
      /** Typed terminal coding/runtime failure; authoritative over reply prose. */
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
      /** Structured "connect another account" request from CONNECT_ACCOUNT. */
      accountConnect?: AccountConnectRequest;
      localInference?: LocalInferenceChatMetadata;
      actionResults?: ChatActionResultSummary[];
    }>;
    sendConversationMessageStream(
      id: string,
      text: string,
      onToken: (
        token: string,
        accumulatedText?: string,
        /** True for in-flight action-callback text the final reply may
         *  replace — voice output must hold it until the turn completes. */
        provisional?: boolean,
      ) => void,
      channelType?: ConversationChannelType,
      signal?: AbortSignal,
      images?: ImageAttachment[],
      metadata?: Record<string, unknown>,
      /** Additive: in-flight phase changes for the rich status indicator. */
      onStatus?: (status: ChatTurnStatus) => void,
      /** Additive: inline tool-call steps (call → result/error) for the thread. */
      onToolEvent?: (event: ChatToolCallEvent) => void,
      /** Additive: caller-supplied idempotency key reused across an auto-retry. */
      clientMessageId?: string,
      /** Settled receipts before terminal bookkeeping; the stream stays open. */
      onReplyReady?: (actionResults: ChatActionResultSummary[]) => void,
    ): Promise<{
      text: string;
      agentName: string;
      completed: boolean;
      interrupted?: boolean;
      transcriptVisibility?: "internal";
      /** Agent reasoning/thought for this turn, when the model emitted one. */
      reasoning?: string;
      /**
       * Persisted assistant memory id from the terminal SSE `done` frame. The
       * client swaps its optimistic temp-resp-* bubble to this id so the
       * proactive-message WS echo reconciles by id instead of appending a
       * duplicate bubble.
       */
      messageId?: string;
      /** Persisted user-memory id from the same committed terminal turn. */
      userMessageId?: string;
      /** The assistant bubble is intentionally transient and has no DB row. */
      assistantEphemeral?: boolean;
      /** True only when action callbacks may have added extra transcript rows. */
      historyRefreshRequired?: boolean;
      noResponseReason?: "ignored";
      usage?: ChatTokenUsage;
      /** See sendConversationMessage above. */
      failureKind?: ChatFailureKind;
      /** See sendConversationMessage above. */
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
      /** See sendConversationMessage above. */
      accountConnect?: AccountConnectRequest;
      localInference?: LocalInferenceChatMetadata;
      actionResults?: ChatActionResultSummary[];
    }>;
    abortConversationTurn(
      roomId: string,
      reason?: string,
    ): Promise<{ aborted: boolean; roomId: string; reason: string }>;
    requestGreeting(
      id: string,
      lang?: string,
    ): Promise<{
      text: string;
      agentName: string;
      generated: boolean;
      persisted?: boolean;
      localInference?: LocalInferenceChatMetadata;
    }>;
    renameConversation(
      id: string,
      title: string,
      options?: { generate?: boolean },
    ): Promise<{ conversation: Conversation }>;
    updateConversation(
      id: string,
      data: {
        title?: string;
        generate?: boolean;
        metadata?: ConversationMetadata | null;
      },
    ): Promise<{ conversation: Conversation }>;
    deleteConversation(id: string): Promise<{ ok: boolean }>;
    cleanupEmptyConversations(options?: {
      keepId?: string;
    }): Promise<{ deleted: string[] }>;
    getDocumentStats(): Promise<DocumentStats>;
    getDocumentFacetCounts(
      options?: DocumentListOptions,
    ): Promise<DocumentFacetCountsResponse>;
    listDocuments(options?: DocumentListOptions): Promise<DocumentsResponse>;
    getDocument(documentId: string): Promise<{ document: DocumentDetail }>;
    getDocumentAccess(documentId: string): Promise<{
      documentId: string;
      directGrantEntityIds: string[];
      accessRevision: string;
    }>;
    getDocumentPins(documentId: string): Promise<{
      documentId: string;
      targets: { agent: boolean; roomIds: string[] };
      pinRevision: string;
    }>;
    updateDocumentPins(
      documentId: string,
      data: { agent: boolean; roomIds: string[]; expectedPinRevision: string },
    ): Promise<{ ok: true; documentId: string }>;
    updateDocumentAccess(
      documentId: string,
      data: {
        directGrantEntityIds: string[];
        expectedAccessRevision: string;
      },
    ): Promise<{
      ok: true;
      documentId: string;
      directGrantEntityIds: string[];
    }>;
    updateDocument(
      documentId: string,
      data: { content: string },
    ): Promise<DocumentUpdateResult>;
    deleteDocument(
      documentId: string,
    ): Promise<{ ok: boolean; deletedFragments: number }>;
    uploadDocument(data: DocumentUploadRequest): Promise<DocumentUploadResult>;
    uploadDocumentsBulk(data: {
      documents: DocumentUploadRequest[];
    }): Promise<DocumentBulkUploadResult>;
    uploadDocumentFromUrl(
      url: string,
      options?: DocumentUrlUploadOptions,
    ): Promise<DocumentUploadResult>;
    searchDocuments(
      query: string,
      options?: DocumentSearchOptions,
    ): Promise<DocumentSearchResponse>;
    getDocumentFragments(
      documentId: string,
    ): Promise<DocumentFragmentsResponse>;
    rememberMemory(text: string): Promise<MemoryRememberResponse>;
    searchMemory(
      query: string,
      options?: { limit?: number },
    ): Promise<MemorySearchResponse>;
    quickContext(
      query: string,
      options?: { limit?: number },
    ): Promise<QuickContextResponse>;
    getMemoryFeed(query?: MemoryFeedQuery): Promise<MemoryFeedResponse>;
    browseMemories(query?: MemoryBrowseQuery): Promise<MemoryBrowseResponse>;
    getMemoriesByEntity(
      entityId: string,
      query?: MemoryBrowseQuery,
    ): Promise<MemoryBrowseResponse>;
    getMemoryStats(): Promise<MemoryStatsResponse>;
    getMcpConfig(): Promise<{ servers: Record<string, McpServerConfig> }>;
    getMcpStatus(): Promise<{ servers: McpServerStatus[] }>;
    searchMcpMarketplace(
      query: string,
      limit: number,
    ): Promise<{ results: McpMarketplaceResult[] }>;
    getMcpServerDetails(
      name: string,
    ): Promise<{ server: McpRegistryServerDetail }>;
    addMcpServer(name: string, config: McpServerConfig): Promise<void>;
    removeMcpServer(name: string): Promise<void>;
    ingestShare(
      payload: ShareIngestPayload,
    ): Promise<{ item: ShareIngestItem }>;
    consumeShareIngest(): Promise<{ items: ShareIngestItem[] }>;
    getWorkbenchOverview(): Promise<
      WorkbenchOverview & {
        tasksAvailable?: boolean;
        triggersAvailable?: boolean;
        todosAvailable?: boolean;
      }
    >;
    listWorkbenchTasks(): Promise<{ tasks: WorkbenchTask[] }>;
    getWorkbenchTask(taskId: string): Promise<{ task: WorkbenchTask }>;
    createWorkbenchTask(data: {
      name: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }): Promise<{ task: WorkbenchTask }>;
    updateWorkbenchTask(
      taskId: string,
      data: {
        name?: string;
        description?: string;
        tags?: string[];
        isCompleted?: boolean;
      },
    ): Promise<{ task: WorkbenchTask }>;
    deleteWorkbenchTask(taskId: string): Promise<{ ok: boolean }>;
    listWorkbenchTodos(): Promise<{ todos: WorkbenchTodo[] }>;
    getWorkbenchTodo(todoId: string): Promise<{ todo: WorkbenchTodo }>;
    createWorkbenchTodo(data: {
      name: string;
      description?: string;
      priority?: number;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
    }): Promise<{ todo: WorkbenchTodo }>;
    updateWorkbenchTodo(
      todoId: string,
      data: {
        name?: string;
        description?: string;
        priority?: number;
        isUrgent?: boolean;
        type?: string;
        isCompleted?: boolean;
      },
    ): Promise<{ todo: WorkbenchTodo }>;
    setWorkbenchTodoCompleted(
      todoId: string,
      isCompleted: boolean,
    ): Promise<void>;
    deleteWorkbenchTodo(todoId: string): Promise<{ ok: boolean }>;
    createWorkbenchVfsProject(
      projectId: string,
    ): Promise<{ project: WorkbenchVfsProject; quota: WorkbenchVfsQuota }>;
    getWorkbenchVfsQuota(
      projectId: string,
    ): Promise<{ quota: WorkbenchVfsQuota }>;
    listWorkbenchVfsFiles(
      projectId: string,
      options?: { path?: string; recursive?: boolean },
    ): Promise<{ files: WorkbenchVfsEntry[] }>;
    readWorkbenchVfsFile(
      projectId: string,
      path: string,
      options?: { encoding?: "utf-8" | "base64" },
    ): Promise<{ path: string; encoding: "utf-8" | "base64"; content: string }>;
    writeWorkbenchVfsFile(
      projectId: string,
      data: { path: string; content: string; encoding?: "utf-8" | "base64" },
    ): Promise<{ file: WorkbenchVfsEntry }>;
    deleteWorkbenchVfsFile(
      projectId: string,
      path: string,
    ): Promise<{ ok: boolean }>;
    listWorkbenchVfsSnapshots(
      projectId: string,
    ): Promise<{ snapshots: WorkbenchVfsSnapshot[] }>;
    createWorkbenchVfsSnapshot(
      projectId: string,
      data?: { note?: string },
    ): Promise<{ snapshot: WorkbenchVfsSnapshot }>;
    getWorkbenchVfsDiff(
      projectId: string,
      snapshotId: string,
    ): Promise<{ diff: WorkbenchVfsDiffEntry[] }>;
    rollbackWorkbenchVfs(
      projectId: string,
      snapshotId: string,
    ): Promise<{ rollback: unknown }>;
    compileWorkbenchVfsPlugin(
      projectId: string,
      data: {
        entry: string;
        outFile?: string;
        format?: "esm" | "cjs";
        target?: string;
      },
    ): Promise<{ compile: WorkbenchVfsCompileResult }>;
    loadWorkbenchVfsPlugin(
      projectId: string,
      data: { entry: string; outFile?: string; compileFirst?: boolean },
    ): Promise<{ pluginName: string; unloaded: false }>;
    listWorkbenchVfsPlugins(): Promise<{ plugins: WorkbenchLoadedVfsPlugin[] }>;
    unloadWorkbenchVfsPlugin(
      projectId: string,
      pluginName: string,
    ): Promise<{ pluginName: string; unloaded: boolean }>;
    promoteWorkbenchVfsToCloud(
      projectId: string,
      data?: PostWorkbenchVfsPromoteToCloudRequest,
    ): Promise<PromoteVfsToCloudContainerResponse>;
    promoteVfsToCloudContainer(
      data: PromoteVfsToCloudContainerRequest,
    ): Promise<PromoteVfsToCloudContainerResponse>;
    requestCloudCodingContainer(
      data: RequestCodingAgentContainerRequest,
    ): Promise<RequestCodingAgentContainerResponse>;
    syncCloudCodingContainerChanges(
      containerId: string,
      data: SyncCloudCodingContainerRequest,
    ): Promise<SyncCloudCodingContainerResponse>;
    refreshRegistry(): Promise<void>;
    getTrajectories(
      options?: TrajectoryListOptions,
      init?: RequestInit,
    ): Promise<TrajectoryListResult>;
    getTrajectoryDetail(
      trajectoryId: string,
      options?: RequestInit & { includePayloads?: boolean },
    ): Promise<TrajectoryDetailResult>;
    getTrajectoryStats(): Promise<TrajectoryStats>;
    getTrajectoryConfig(): Promise<TrajectoryConfig>;
    updateTrajectoryConfig(
      config: Partial<TrajectoryConfig>,
    ): Promise<TrajectoryConfig>;
    exportTrajectories(options: TrajectoryExportOptions): Promise<Blob>;
    deleteTrajectories(trajectoryIds: string[]): Promise<{ deleted: number }>;
    clearAllTrajectories(): Promise<{ deleted: number }>;
    getDatabaseStatus(): Promise<DatabaseStatus>;
    getDatabaseConfig(): Promise<DatabaseConfigResponse>;
    saveDatabaseConfig(config: {
      provider?: DatabaseProviderType;
      pglite?: { dataDir?: string };
      postgres?: {
        connectionString?: string;
        host?: string;
        port?: number;
        database?: string;
        user?: string;
        password?: string;
        ssl?: boolean;
      };
    }): Promise<{ saved: boolean; needsRestart: boolean }>;
    testDatabaseConnection(creds: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      ssl?: boolean;
    }): Promise<ConnectionTestResult>;
    getDatabaseTables(): Promise<{ tables: TableInfo[] }>;
    getDatabaseRows(
      table: string,
      opts?: {
        offset?: number;
        limit?: number;
        sort?: string;
        order?: "asc" | "desc";
        search?: string;
      },
    ): Promise<TableRowsResponse>;
    insertDatabaseRow(
      table: string,
      data: Record<string, unknown>,
    ): Promise<{
      inserted: boolean;
      row: Record<string, unknown> | null;
    }>;
    updateDatabaseRow(
      table: string,
      where: Record<string, unknown>,
      data: Record<string, unknown>,
    ): Promise<{ updated: boolean; row: Record<string, unknown> }>;
    deleteDatabaseRow(
      table: string,
      where: Record<string, unknown>,
    ): Promise<{ deleted: boolean; row: Record<string, unknown> }>;
    executeDatabaseQuery(sql: string, readOnly?: boolean): Promise<QueryResult>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

const LEGACY_CHAT_COMPAT_TITLE = "Quick Chat";
const LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX = "legacy_chat_conversation";

function getLegacyChatConversationStorageKey(client: ElizaClient): string {
  const base =
    client.getBaseUrl() ||
    (typeof window !== "undefined" ? window.location.origin : "same-origin");
  return `${LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(base)}`;
}

function readLegacyChatConversationId(client: ElizaClient): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.sessionStorage.getItem(
    getLegacyChatConversationStorageKey(client),
  );
  return stored?.trim() ? stored.trim() : null;
}

function writeLegacyChatConversationId(
  client: ElizaClient,
  conversationId: string | null,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const key = getLegacyChatConversationStorageKey(client);
  if (conversationId?.trim()) {
    window.sessionStorage.setItem(key, conversationId.trim());
    return;
  }
  window.sessionStorage.removeItem(key);
}

async function ensureLegacyChatConversationId(
  client: ElizaClient,
): Promise<string> {
  const cached = readLegacyChatConversationId(client);
  if (cached) {
    return cached;
  }

  const { conversation } = await client.createConversation(
    LEGACY_CHAT_COMPAT_TITLE,
  );
  writeLegacyChatConversationId(client, conversation.id);
  return conversation.id;
}

ElizaClient.prototype.sendChatRest = async function (
  this: ElizaClient,
  text,
  channelType = "DM",
) {
  const sendToConversation = async (conversationId: string) =>
    this.sendConversationMessage(conversationId, text, channelType, undefined);

  const conversationId = await ensureLegacyChatConversationId(this);
  try {
    return await sendToConversation(conversationId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ApiError" &&
      (error as ApiError).status === 404
    ) {
      writeLegacyChatConversationId(this, null);
      return sendToConversation(await ensureLegacyChatConversationId(this));
    }
    throw error;
  }
};

ElizaClient.prototype.sendChatMessage = function (
  this: ElizaClient,
  text,
  channelType = "DM",
) {
  void this.sendChatRest(text, channelType).catch(() => {
    // View affordances use this as a fire-and-forget "ask Eliza" bridge; the
    // chat surface owns visible delivery/error state for full composer sends.
  });
};

ElizaClient.prototype.sendChatStream = async function (
  this: ElizaClient,
  text,
  onToken,
  channelType = "DM",
  signal?,
) {
  const streamConversation = async (conversationId: string) =>
    this.sendConversationMessageStream(
      conversationId,
      text,
      onToken,
      channelType,
      signal,
      undefined,
    );

  const conversationId = await ensureLegacyChatConversationId(this);
  try {
    return await streamConversation(conversationId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ApiError" &&
      (error as ApiError).status === 404
    ) {
      writeLegacyChatConversationId(this, null);
      return streamConversation(await ensureLegacyChatConversationId(this));
    }
    throw error;
  }
};

// A serverless / shared-runtime agent may omit `updatedAt` from conversation
// objects (a never-updated conversation legitimately has updatedAt == createdAt).
// The shared `isConversationRecord` guard requires the standard shape, so without
// this the conversation list filters to empty and chat sends are dropped for want
// of an active conversation (createConversation's result is rejected too). Default
// the field at the API boundary — clean DTO completion, not a server-specific
// special case.
function withConversationDefaults<T>(conversation: T): T {
  if (
    conversation &&
    typeof conversation === "object" &&
    typeof (conversation as Record<string, unknown>).updatedAt !== "string"
  ) {
    const createdAt = (conversation as Record<string, unknown>).createdAt;
    if (typeof createdAt === "string") {
      return {
        ...(conversation as Record<string, unknown>),
        updatedAt: createdAt,
      } as T;
    }
  }
  return conversation;
}

function withConversationListDefaults<T extends { conversations?: unknown }>(
  response: T,
): T {
  if (response && Array.isArray(response.conversations)) {
    return {
      ...response,
      conversations: response.conversations.map(withConversationDefaults),
    };
  }
  return response;
}

async function invokeLocalDesktopChatRpc<T>(
  baseUrl: string,
  options: { rpcMethod: string; ipcChannel: string; params?: unknown },
): Promise<T | null> {
  if (
    !isDesktopLocalApiBaseUrl(baseUrl) ||
    isDesktopExternalApiBaseUrl(baseUrl) ||
    isRemoteRelayRestAdapterBase(baseUrl)
  ) {
    return null;
  }
  return invokeDesktopBridgeRequest<T>(options);
}

ElizaClient.prototype.listConversations = async function (
  this: ElizaClient,
  options,
) {
  // Prefer typed Electrobun RPC. The bun-side composer throws
  // AgentNotReadyError if the agent has no port yet; we catch and
  // fall through to HTTP so the sidebar's polling loop sees the same
  // "transport not ready" semantic as before RPC was wired.
  try {
    const viaRpc = await invokeLocalDesktopChatRpc<{
      conversations: Conversation[];
    }>(this.getBaseUrl(), {
      rpcMethod: "listConversations",
      ipcChannel: "agent",
    });
    if (viaRpc) return withConversationListDefaults(viaRpc);
  } catch {
    /* AgentNotReadyError or any RPC failure → fall through to HTTP */
  }
  return withConversationListDefaults(
    await this.fetch<{ conversations: Conversation[] }>("/api/conversations", {
      signal: options?.signal,
    }),
  );
};

ElizaClient.prototype.createConversation = async function (
  this: ElizaClient,
  title?,
  options?,
) {
  const response = await this.fetch<{
    conversation: Conversation;
    greeting?: ConversationGreeting;
  }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({
      title,
      ...(options?.includeGreeting === true ||
      options?.bootstrapGreeting === true
        ? { includeGreeting: true }
        : {}),
      ...(typeof options?.lang === "string" && options.lang.trim()
        ? { lang: options.lang.trim() }
        : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
    }),
  });
  const conversation = withConversationDefaults(response.conversation);
  if (!response.greeting) {
    return { ...response, conversation };
  }
  return {
    ...response,
    conversation,
    greeting: {
      ...response.greeting,
      text: this.normalizeGreetingText(response.greeting.text),
    },
  };
};

ElizaClient.prototype.getConversationMessages = async function (
  this: ElizaClient,
  id,
  options,
) {
  let response: { messages: ConversationMessage[]; hasMore?: boolean } | null =
    null;
  // The desktop-bridge RPC only serves the recent window; an `around` jump or a
  // `before` load-older page must go straight to HTTP so the server can center
  // the window on the target (around) or page below the cursor (before).
  if (!options?.around && options?.before === undefined) {
    try {
      response = await invokeLocalDesktopChatRpc<{
        messages: ConversationMessage[];
      }>(this.getBaseUrl(), {
        rpcMethod: "getConversationMessages",
        ipcChannel: "agent",
        params: { id },
      });
    } catch {
      response = null;
    }
  }
  // The HTTP path is abortable (a rapid conversation swipe cancels the prior
  // in-flight load so stacked requests don't race to set the thread); the
  // desktop bridge path is local + fast and ignores the signal.
  let query = "";
  if (options?.around) {
    query = `?around=${encodeURIComponent(options.around)}`;
  } else if (options?.before !== undefined) {
    const params = new URLSearchParams({ before: String(options.before) });
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    query = `?${params.toString()}`;
  }
  response ??= await this.fetch<{
    messages: ConversationMessage[];
    hasMore?: boolean;
  }>(
    `/api/conversations/${encodeURIComponent(id)}/messages${query}`,
    options?.signal ? { signal: options.signal } : undefined,
  );
  return {
    messages: response.messages.map((message) => {
      if (message.role !== "assistant") return message;
      const text = this.normalizeAssistantText(message.text, {
        interrupted: message.interrupted,
      });
      return text === message.text ? message : { ...message, text };
    }),
    ...(typeof response.hasMore === "boolean"
      ? { hasMore: response.hasMore }
      : {}),
  };
};

ElizaClient.prototype.searchConversationMessages = async function (
  this: ElizaClient,
  query,
  options,
) {
  const params = new URLSearchParams({ q: query });
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined)
    params.set("offset", String(options.offset));
  if (options?.since !== undefined) params.set("since", String(options.since));
  if (options?.until !== undefined) params.set("until", String(options.until));
  return this.fetch<ConversationMessageSearchResponse>(
    `/api/conversations/messages/search?${params}`,
    options?.signal ? { signal: options.signal } : undefined,
  );
};

ElizaClient.prototype.getInboxMessages = async function (
  this: ElizaClient,
  options,
) {
  const params = buildInboxMessagesParams(options);
  const query = params.toString();
  const path = query ? `/api/inbox/messages?${query}` : "/api/inbox/messages";
  try {
    const viaRpc = await invokeLocalDesktopChatRpc<{
      messages: Array<ConversationMessage & { roomId: string; source: string }>;
      count: number;
    }>(this.getBaseUrl(), {
      rpcMethod: "getInboxMessages",
      ipcChannel: "agent",
      params: buildInboxMessagesRpcParams(options),
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch<{
    messages: Array<ConversationMessage & { roomId: string; source: string }>;
    count: number;
  }>(path);
};

ElizaClient.prototype.getInboxSources = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeLocalDesktopChatRpc<{ sources: string[] }>(
      this.getBaseUrl(),
      {
        rpcMethod: "getInboxSources",
        ipcChannel: "agent",
      },
    );
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch<{ sources: string[] }>("/api/inbox/sources");
};

ElizaClient.prototype.getInboxChats = async function (
  this: ElizaClient,
  options,
) {
  const params = buildSourcesParams(options?.sources);
  const query = params.toString();
  const path = query ? `/api/inbox/chats?${query}` : "/api/inbox/chats";
  try {
    const viaRpc = await invokeLocalDesktopChatRpc<{
      chats: Array<{
        canSend?: boolean;
        id: string;
        source: string;
        transportSource?: string;
        worldId?: string;
        worldLabel: string;
        roomType?: string;
        muted?: boolean;
        mutedScope?: "room" | "server";
        title: string;
        avatarUrl?: string;
        lastMessageText: string;
        lastMessageAt: number;
        messageCount: number;
      }>;
      count: number;
    }>(this.getBaseUrl(), {
      rpcMethod: "getInboxChats",
      ipcChannel: "agent",
      params: buildInboxChatsRpcParams(options),
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch<{
    chats: Array<{
      canSend?: boolean;
      id: string;
      source: string;
      transportSource?: string;
      /** Owning server/world id when the connector exposes one. */
      worldId?: string;
      /** User-facing server/world label for selectors and section headers. */
      worldLabel: string;
      muted?: boolean;
      mutedScope?: "room" | "server";
      title: string;
      avatarUrl?: string;
      lastMessageText: string;
      lastMessageAt: number;
      messageCount: number;
    }>;
    count: number;
  }>(path);
};

ElizaClient.prototype.setInboxChatMute = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<{
    ok: boolean;
    roomId: string;
    action: "mute" | "unmute";
    scope: "room" | "server";
    muted?: boolean;
    mutedScope?: "room" | "server";
  }>("/api/inbox/chats/mute", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.sendInboxMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<{
    ok: boolean;
    message?: ConversationMessage & { roomId: string; source: string };
  }>("/api/inbox/messages", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.truncateConversationMessages = async function (
  this: ElizaClient,
  id,
  messageId,
  options?,
) {
  return this.fetch(
    `/api/conversations/${encodeURIComponent(id)}/messages/truncate`,
    {
      method: "POST",
      body: JSON.stringify({
        messageId,
        inclusive: options?.inclusive === true,
      }),
    },
  );
};

ElizaClient.prototype.deleteConversationMessage = async function (
  this: ElizaClient,
  id,
  messageId,
) {
  return this.fetch(
    `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(
      messageId,
    )}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.retryConversationReply = async function (
  this: ElizaClient,
  id,
  messageId,
) {
  return this.fetch(
    `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/retry-reply`,
    { method: "POST", body: JSON.stringify({}) },
  );
};

ElizaClient.prototype.sendConversationMessage = async function (
  this: ElizaClient,
  id,
  text,
  channelType = "DM",
  images?,
  metadata?,
) {
  const response = await this.fetch<{
    text: string;
    agentName: string;
    interrupted?: boolean;
    transcriptVisibility?: "internal";
    blocks?: ContentBlock[];
    noResponseReason?: "ignored";
    failureKind?: ChatFailureKind;
    terminalFailure?: ChatTerminalFailure;
    accountConnect?: AccountConnectRequest;
    localInference?: LocalInferenceChatMetadata;
    actionResults?: ChatActionResultSummary[];
  }>(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text,
      channelType,
      ...(images?.length ? { images } : {}),
      ...(metadata ? { metadata } : {}),
    }),
  });
  return {
    ...response,
    text:
      response.noResponseReason === "ignored"
        ? ""
        : this.normalizeAssistantText(response.text, {
            interrupted: response.interrupted,
          }),
  };
};

ElizaClient.prototype.sendConversationMessageStream = async function (
  this: ElizaClient,
  id,
  text,
  onToken,
  channelType = "DM",
  signal?,
  images?,
  metadata?,
  onStatus?,
  onToolEvent?,
  clientMessageId?,
  onReplyReady?,
) {
  return this.streamChatEndpoint(
    `/api/conversations/${encodeURIComponent(id)}/messages/stream`,
    text,
    onToken,
    channelType,
    signal,
    images,
    metadata,
    onStatus,
    onToolEvent,
    clientMessageId,
    onReplyReady,
  );
};

ElizaClient.prototype.abortConversationTurn = async function (
  this: ElizaClient,
  roomId,
  reason = "ui-abort",
) {
  return this.fetch(`/api/turns/${encodeURIComponent(roomId)}/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
};

ElizaClient.prototype.requestGreeting = async function (
  this: ElizaClient,
  id,
  lang?,
) {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  const response = await this.fetch<{
    text: string;
    agentName: string;
    generated: boolean;
    persisted?: boolean;
    localInference?: LocalInferenceChatMetadata;
  }>(`/api/conversations/${encodeURIComponent(id)}/greeting${qs}`, {
    method: "POST",
  });
  return {
    ...response,
    text: this.normalizeGreetingText(response.text),
  };
};

ElizaClient.prototype.renameConversation = async function (
  this: ElizaClient,
  id,
  title,
  options?,
) {
  return this.updateConversation(id, {
    title,
    generate: options?.generate,
  });
};

ElizaClient.prototype.updateConversation = async function (
  this: ElizaClient,
  id,
  data,
) {
  return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(typeof data?.title === "string" ? { title: data.title } : {}),
      ...(typeof data?.generate === "boolean"
        ? { generate: data.generate }
        : {}),
      ...(data && "metadata" in data ? { metadata: data.metadata } : {}),
    }),
  });
};

ElizaClient.prototype.deleteConversation = async function (
  this: ElizaClient,
  id,
) {
  return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.cleanupEmptyConversations = async function (
  this: ElizaClient,
  options?,
) {
  return this.fetch("/api/conversations/cleanup-empty", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(options?.keepId ? { keepId: options.keepId } : {}),
    }),
  });
};

ElizaClient.prototype.getDocumentStats = async function (this: ElizaClient) {
  return this.fetch("/api/documents/stats");
};

ElizaClient.prototype.listDocuments = async function (
  this: ElizaClient,
  options?,
) {
  const params = buildDocumentListParams(options);
  const query = params.toString();
  return this.fetch(`/api/documents${query ? `?${query}` : ""}`);
};

ElizaClient.prototype.getDocumentFacetCounts = async function (
  this: ElizaClient,
  options?,
) {
  // Whole-store facet counts for the hub segmented control (#13594). Reuses the
  // list filter params minus paging so the counts honor the same
  // scope/room/search narrowing as the visible list; the facet param itself is
  // ignored server-side so every bucket is counted.
  const params = new URLSearchParams();
  if (options?.query) params.set("q", options.query);
  appendDocumentFilterParams(params, options);
  const query = params.toString();
  return this.fetch(`/api/documents/facets${query ? `?${query}` : ""}`);
};

ElizaClient.prototype.getDocument = async function (
  this: ElizaClient,
  documentId,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`);
};

ElizaClient.prototype.getDocumentAccess = async function (
  this: ElizaClient,
  documentId,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}/access`);
};

ElizaClient.prototype.getDocumentPins = async function (
  this: ElizaClient,
  documentId,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}/pins`);
};

ElizaClient.prototype.updateDocumentPins = async function (
  this: ElizaClient,
  documentId,
  data,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}/pins`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateDocumentAccess = async function (
  this: ElizaClient,
  documentId,
  data,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}/access`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateDocument = async function (
  this: ElizaClient,
  documentId,
  data,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.deleteDocument = async function (
  this: ElizaClient,
  documentId,
) {
  return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.uploadDocument = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/documents", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.uploadDocumentsBulk = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/documents/bulk", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.uploadDocumentFromUrl = async function (
  this: ElizaClient,
  url,
  options?,
) {
  const metadata = {
    ...(options?.metadata ?? {}),
    ...(typeof options?.includeImageDescriptions === "boolean"
      ? { includeImageDescriptions: options.includeImageDescriptions }
      : {}),
  };
  return this.fetch("/api/documents/url", {
    method: "POST",
    body: JSON.stringify({
      url,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(options?.entityId ? { entityId: options.entityId } : {}),
      ...(options?.scope ? { scope: options.scope } : {}),
      ...(options?.scopedToEntityId
        ? { scopedToEntityId: options.scopedToEntityId }
        : {}),
    }),
  });
};

ElizaClient.prototype.searchDocuments = async function (
  this: ElizaClient,
  query,
  options?,
) {
  const params = buildDocumentSearchParams(query, options);
  return this.fetch(`/api/documents/search?${params}`);
};

ElizaClient.prototype.getDocumentFragments = async function (
  this: ElizaClient,
  documentId,
) {
  return this.fetch(
    `/api/documents/${encodeURIComponent(documentId)}/fragments`,
  );
};

ElizaClient.prototype.rememberMemory = async function (
  this: ElizaClient,
  text,
) {
  return this.fetch("/api/memory/remember", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
};

ElizaClient.prototype.searchMemory = async function (
  this: ElizaClient,
  query,
  options?,
) {
  const params = new URLSearchParams({ q: query });
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  return this.fetch(`/api/memory/search?${params}`);
};

ElizaClient.prototype.quickContext = async function (
  this: ElizaClient,
  query,
  options?,
) {
  const params = new URLSearchParams({ q: query });
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  return this.fetch(`/api/context/quick?${params}`);
};

ElizaClient.prototype.getMemoryFeed = async function (
  this: ElizaClient,
  query?,
) {
  const params = new URLSearchParams();
  if (query?.type) params.set("type", query.type);
  if (typeof query?.limit === "number")
    params.set("limit", String(query.limit));
  if (typeof query?.before === "number")
    params.set("before", String(query.before));
  if (query?.beforeId) params.set("beforeId", query.beforeId);
  const qs = params.toString();
  return this.fetch(`/api/memories/feed${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.browseMemories = async function (
  this: ElizaClient,
  query?,
) {
  const params = new URLSearchParams();
  if (query?.type) params.set("type", query.type);
  if (query?.entityId) params.set("entityId", query.entityId);
  if (query?.roomId) params.set("roomId", query.roomId);
  if (query?.q) params.set("q", query.q);
  if (typeof query?.limit === "number")
    params.set("limit", String(query.limit));
  if (typeof query?.offset === "number")
    params.set("offset", String(query.offset));
  const qs = params.toString();
  return this.fetch(`/api/memories/browse${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getMemoriesByEntity = async function (
  this: ElizaClient,
  entityId,
  query?,
) {
  const params = new URLSearchParams();
  if (query?.type) params.set("type", query.type);
  if (typeof query?.limit === "number")
    params.set("limit", String(query.limit));
  if (typeof query?.offset === "number")
    params.set("offset", String(query.offset));
  if (query?.entityIds && query.entityIds.length > 0)
    params.set("entityIds", query.entityIds.join(","));
  const qs = params.toString();
  return this.fetch(
    `/api/memories/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.getMemoryStats = async function (this: ElizaClient) {
  return this.fetch("/api/memories/stats");
};

ElizaClient.prototype.getMcpConfig = async function (this: ElizaClient) {
  return this.fetch("/api/mcp/config");
};

ElizaClient.prototype.getMcpStatus = async function (this: ElizaClient) {
  return this.fetch("/api/mcp/status");
};

ElizaClient.prototype.searchMcpMarketplace = async function (
  this: ElizaClient,
  query,
  limit,
) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return this.fetch(`/api/mcp/marketplace/search?${params}`);
};

ElizaClient.prototype.getMcpServerDetails = async function (
  this: ElizaClient,
  name,
) {
  return this.fetch(`/api/mcp/marketplace/${encodeURIComponent(name)}`);
};

ElizaClient.prototype.addMcpServer = async function (
  this: ElizaClient,
  name,
  config,
) {
  await this.fetch("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  });
};

ElizaClient.prototype.removeMcpServer = async function (
  this: ElizaClient,
  name,
) {
  await this.fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.ingestShare = async function (
  this: ElizaClient,
  payload,
) {
  return this.fetch("/api/ingest/share", {
    method: "POST",
    body: JSON.stringify(payload),
  });
};

ElizaClient.prototype.consumeShareIngest = async function (this: ElizaClient) {
  return this.fetch("/api/share/consume", { method: "POST" });
};

ElizaClient.prototype.getWorkbenchOverview = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/workbench/overview");
};

ElizaClient.prototype.listWorkbenchTasks = async function (this: ElizaClient) {
  return this.fetch("/api/workbench/tasks");
};

ElizaClient.prototype.getWorkbenchTask = async function (
  this: ElizaClient,
  taskId,
) {
  return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`);
};

ElizaClient.prototype.createWorkbenchTask = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/workbench/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateWorkbenchTask = async function (
  this: ElizaClient,
  taskId,
  data,
) {
  return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.deleteWorkbenchTask = async function (
  this: ElizaClient,
  taskId,
) {
  return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.listWorkbenchTodos = async function (this: ElizaClient) {
  return this.fetch("/api/workbench/todos");
};

ElizaClient.prototype.getWorkbenchTodo = async function (
  this: ElizaClient,
  todoId,
) {
  return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`);
};

ElizaClient.prototype.createWorkbenchTodo = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/workbench/todos", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateWorkbenchTodo = async function (
  this: ElizaClient,
  todoId,
  data,
) {
  return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.setWorkbenchTodoCompleted = async function (
  this: ElizaClient,
  todoId,
  isCompleted,
) {
  await this.fetch(
    `/api/workbench/todos/${encodeURIComponent(todoId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ isCompleted }),
    },
  );
};

ElizaClient.prototype.deleteWorkbenchTodo = async function (
  this: ElizaClient,
  todoId,
) {
  return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.createWorkbenchVfsProject = async function (
  this: ElizaClient,
  projectId,
) {
  return this.fetch("/api/workbench/vfs/projects", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
};

ElizaClient.prototype.getWorkbenchVfsQuota = async function (
  this: ElizaClient,
  projectId,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/quota`,
  );
};

ElizaClient.prototype.listWorkbenchVfsFiles = async function (
  this: ElizaClient,
  projectId,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.path) params.set("path", options.path);
  if (options.recursive) params.set("recursive", "true");
  const query = params.toString();
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/files${
      query ? `?${query}` : ""
    }`,
  );
};

ElizaClient.prototype.readWorkbenchVfsFile = async function (
  this: ElizaClient,
  projectId,
  path,
  options = {},
) {
  const params = new URLSearchParams({ path });
  if (options.encoding) params.set("encoding", options.encoding);
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`,
  );
};

ElizaClient.prototype.writeWorkbenchVfsFile = async function (
  this: ElizaClient,
  projectId,
  data,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.deleteWorkbenchVfsFile = async function (
  this: ElizaClient,
  projectId,
  path,
) {
  const params = new URLSearchParams({ path });
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.listWorkbenchVfsSnapshots = async function (
  this: ElizaClient,
  projectId,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/snapshots`,
  );
};

ElizaClient.prototype.createWorkbenchVfsSnapshot = async function (
  this: ElizaClient,
  projectId,
  data = {},
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/snapshots`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.getWorkbenchVfsDiff = async function (
  this: ElizaClient,
  projectId,
  snapshotId,
) {
  const params = new URLSearchParams({ snapshotId });
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/diff?${params.toString()}`,
  );
};

ElizaClient.prototype.rollbackWorkbenchVfs = async function (
  this: ElizaClient,
  projectId,
  snapshotId,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/rollback`,
    {
      method: "POST",
      body: JSON.stringify({ snapshotId }),
    },
  );
};

ElizaClient.prototype.compileWorkbenchVfsPlugin = async function (
  this: ElizaClient,
  projectId,
  data,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/compile-plugin`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.loadWorkbenchVfsPlugin = async function (
  this: ElizaClient,
  projectId,
  data,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/load-plugin`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.listWorkbenchVfsPlugins = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/workbench/vfs/plugins");
};

ElizaClient.prototype.unloadWorkbenchVfsPlugin = async function (
  this: ElizaClient,
  projectId,
  pluginName,
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(pluginName)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.promoteWorkbenchVfsToCloud = async function (
  this: ElizaClient,
  projectId,
  data = {},
) {
  return this.fetch(
    `/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/promote-to-cloud`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.promoteVfsToCloudContainer = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/cloud/coding-containers/promotions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.requestCloudCodingContainer = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/cloud/coding-containers", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.syncCloudCodingContainerChanges = async function (
  this: ElizaClient,
  containerId,
  data,
) {
  return this.fetch(
    `/api/cloud/coding-containers/${encodeURIComponent(containerId)}/sync`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.refreshRegistry = async function (this: ElizaClient) {
  await this.fetch("/api/apps/refresh", { method: "POST" });
};

ElizaClient.prototype.getTrajectories = async function (
  this: ElizaClient,
  options?,
  init?,
) {
  const params = buildTrajectoryParams(options);
  const query = params.toString();
  return this.fetch(`/api/trajectories${query ? `?${query}` : ""}`, init);
};

ElizaClient.prototype.getTrajectoryDetail = async function (
  this: ElizaClient,
  trajectoryId,
  options?,
) {
  const { includePayloads = true, ...init } = options ?? {};
  return this.fetch(
    `/api/trajectories/${encodeURIComponent(trajectoryId)}${includePayloads ? "" : "?includePayloads=0"}`,
    init,
  );
};

ElizaClient.prototype.getTrajectoryStats = async function (this: ElizaClient) {
  return this.fetch("/api/trajectories/stats");
};

ElizaClient.prototype.getTrajectoryConfig = async function (this: ElizaClient) {
  return this.fetch("/api/trajectories/config");
};

ElizaClient.prototype.updateTrajectoryConfig = async function (
  this: ElizaClient,
  config,
) {
  return this.fetch("/api/trajectories/config", {
    method: "PUT",
    body: JSON.stringify(config),
  });
};

ElizaClient.prototype.exportTrajectories = async function (
  this: ElizaClient,
  options,
) {
  const res = await this.rawRequest("/api/trajectories/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options),
  });
  return res.blob();
};

ElizaClient.prototype.deleteTrajectories = async function (
  this: ElizaClient,
  trajectoryIds,
) {
  return this.fetch("/api/trajectories", {
    method: "DELETE",
    body: JSON.stringify({ trajectoryIds }),
  });
};

ElizaClient.prototype.clearAllTrajectories = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/trajectories", {
    method: "DELETE",
    body: JSON.stringify({ clearAll: true }),
  });
};

ElizaClient.prototype.getDatabaseStatus = async function (this: ElizaClient) {
  return this.fetch("/api/database/status");
};

ElizaClient.prototype.getDatabaseConfig = async function (this: ElizaClient) {
  return this.fetch("/api/database/config");
};

ElizaClient.prototype.saveDatabaseConfig = async function (
  this: ElizaClient,
  config,
) {
  return this.fetch("/api/database/config", {
    method: "PUT",
    body: JSON.stringify(config),
  });
};

ElizaClient.prototype.testDatabaseConnection = async function (
  this: ElizaClient,
  creds,
) {
  return this.fetch("/api/database/test", {
    method: "POST",
    body: JSON.stringify(creds),
  });
};

ElizaClient.prototype.getDatabaseTables = async function (this: ElizaClient) {
  return this.fetch("/api/database/tables");
};

ElizaClient.prototype.getDatabaseRows = async function (
  this: ElizaClient,
  table,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.sort) params.set("sort", opts.sort);
  if (opts?.order) params.set("order", opts.order);
  if (opts?.search) params.set("search", opts.search);
  const qs = params.toString();
  return this.fetch(
    `/api/database/tables/${encodeURIComponent(table)}/rows${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.insertDatabaseRow = async function (
  this: ElizaClient,
  table,
  data,
) {
  return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
    method: "POST",
    body: JSON.stringify({ data }),
  });
};

ElizaClient.prototype.updateDatabaseRow = async function (
  this: ElizaClient,
  table,
  where,
  data,
) {
  return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
    method: "PUT",
    body: JSON.stringify({ where, data }),
  });
};

ElizaClient.prototype.deleteDatabaseRow = async function (
  this: ElizaClient,
  table,
  where,
) {
  return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
    method: "DELETE",
    body: JSON.stringify({ where }),
  });
};

ElizaClient.prototype.executeDatabaseQuery = async function (
  this: ElizaClient,
  sql,
  readOnly = true,
) {
  return this.fetch("/api/database/query", {
    method: "POST",
    body: JSON.stringify({ sql, readOnly }),
  });
};
