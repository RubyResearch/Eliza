/**
 * Chat send callbacks — message sending and streaming operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all message sending,
 * streaming, stop, retry, edit, clear, and queue management.
 */

import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { asRecord } from "@elizaos/shared";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { Conversation, CustomActionDef } from "../api";
import {
  type ChatActionResultSummary,
  type ChatToolCallEvent,
  type ChatTurnStatus,
  type CodingAgentSession,
  type ConversationChannelType,
  type ConversationMessage,
  client,
  type ImageAttachment,
  type MessageAttachmentContentType,
} from "../api";
import { isLimitedCloudAgentApiBase } from "../api/app-shell-capabilities";
import {
  generateChatClientMessageId,
  isStreamGenerationError,
} from "../api/client-base";
import { describeCreditGateError } from "../api/credit-gate-error";
import {
  consumePendingCapabilityIntent,
  findCapabilityHandoff,
  markPendingCapabilityReady,
  readPendingCapabilityReadyAgentId,
  rememberCapabilityHandoff,
} from "../capability-handoff";
import {
  expandSavedCustomCommand,
  loadSavedCustomCommands,
  normalizeSlashCommandName,
} from "../chat";
import {
  captureCompletedActionNavigationFence,
  dispatchCompletedActionNavigation,
} from "../completed-action-navigation";
import { dispatchWorkflowActionHandoff } from "../components/pages/workflow-action-handoff";
import { dispatchDoorDashHumanHandoff } from "../doordash-human-handoff";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
  dispatchChatPrefill,
} from "../events";
import type { Tab } from "../navigation";
import { directCloudSharedAgentIdFromBase } from "../utils/cloud-agent-base";
import {
  dispatchViewActionHandoffDirect,
  findViewActionHandoff,
} from "../view-action-handoff";
import { emitViewEvent } from "../views/view-event-bus";
import { VIEW_EVENTS } from "../views/view-event-types";
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";
import { clearChatDraft } from "./ChatComposerContext.hooks";
import { isConversationRecord } from "./chat-conversation-guards";
import {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  resolveAbortRoomId,
  sentUserTurnPresent,
  UNDELIVERED_TURN_NOTICE,
} from "./chat-send-failures";
import { buildChatViewMetadata } from "./chat-view-routing";
import {
  applyStreamingTextModification,
  formatSearchBullet,
  type LoadConversationMessagesResult,
  mergeStreamingText,
  normalizeCustomActionName,
  parseCustomActionParams,
  parseSlashCommandInput,
  type StreamingTextModification,
  shouldApplyFinalStreamText,
} from "./internal";
import {
  clearPendingChatTurn,
  persistPendingChatTurn,
} from "./pending-chat-turns";
import { streamingRenderDelayMs } from "./streaming-render-cadence";
import type { ConversationMessageStateMutation } from "./useDataLoaders";

// ── Types ────────────────────────────────────────────────────────────

const CHAT_SEND_IDENTITY_OVERRIDE = Symbol("chat-send-identity-override");
const CHAT_SEND_HYDRATION_SETTLED = Symbol("chat-send-hydration-settled");
type ConversationStreamResult = Awaited<
  ReturnType<typeof client.sendConversationMessageStream>
>;

interface ActiveChatTurn {
  controller: AbortController;
  conversationId: string | null;
  roomId: string | null;
  abortServerTurn: (() => void) | null;
}

interface ChatViewHandoffOwner {
  conversationId: string | null;
  generation: number | null;
  controller: AbortController | null;
}

export {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  resolveAbortRoomId,
  UNDELIVERED_TURN_NOTICE,
} from "./chat-send-failures";

function createCompletedViewHandoff(
  isTurnCurrent: () => boolean,
  showFailure: (message: string) => void,
): (actionResults: ChatActionResultSummary[] | undefined) => boolean {
  const sourceBase = client.getBaseUrl();
  const isNavigationCurrent = captureCompletedActionNavigationFence();
  let fallbackHandoffId: string | undefined;
  return (actionResults) => {
    const viewHandoff = findViewActionHandoff(actionResults);
    if (!viewHandoff) return false;
    if (
      !isTurnCurrent() ||
      client.getBaseUrl() !== sourceBase ||
      !isNavigationCurrent()
    ) {
      return true;
    }
    try {
      // Preserve server IDs for WS dedupe. Browser receipts without an ID share
      // a request-local one across reply_ready and done. An unhandled early
      // event can still be retried at done by the canonical navigation bridge.
      if (
        viewHandoff.completedActionHandoffId ||
        !viewHandoff.completedActionDelivered
      ) {
        if (!viewHandoff.completedActionHandoffId && !fallbackHandoffId) {
          fallbackHandoffId = generateChatClientMessageId();
        }
        dispatchViewActionHandoffDirect(actionResults, (detail) =>
          dispatchCompletedActionNavigation({
            ...detail,
            completedActionHandoffId:
              viewHandoff.completedActionHandoffId ?? fallbackHandoffId,
          }),
        );
      }
    } catch (err) {
      // error-policy:J4 the chat turn succeeded, so preserve it while surfacing a
      // distinct navigation failure instead of fabricating an opened view.
      logger.warn(
        { err },
        "[useChatSend] completed VIEWS action could not reach the renderer",
      );
      showFailure(
        "The agent chose a view, but the app couldn't open it. Try opening the view again.",
      );
    }
    return true;
  };
}

async function handoffCompletedAction(
  actionResults: ChatActionResultSummary[] | undefined,
  handoffView: ReturnType<typeof createCompletedViewHandoff>,
): Promise<void> {
  const successfulActions =
    actionResults?.filter((result) => result.success) ?? [];
  if (successfulActions.length > 0) {
    // Refresh remains a terminal commit edge; reply_ready only offers the
    // finalized view destination while durable post-delivery work completes.
    emitViewEvent(
      VIEW_EVENTS.VIEW_REFRESH,
      {
        actionNames: successfulActions.flatMap((result) =>
          result.actionName ? [result.actionName] : [],
        ),
      },
      "agent",
    );
  }
  if (handoffView(actionResults)) return;
  if (dispatchDoorDashHumanHandoff(actionResults)) return;
  dispatchWorkflowActionHandoff(actionResults);
}

// Sentinel for the streaming buffer's `pendingStatus`: "no status update
// parked", distinct from a parked `null` (an explicit clear-the-status commit).
// Module scope (not per-render) so the flush callbacks stay referentially
// stable across renders.
const NO_PENDING_STATUS = Symbol("no-pending-status");

/** Derive the rendered-attachment kind for an optimistic bubble from its MIME. */
function optimisticAttachmentKind(
  mimeType: string,
): MessageAttachmentContentType {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") {
    return "document";
  }
  return "image";
}

/**
 * True when the active client base is an Eliza Cloud agent — either the
 * shared-runtime REST adapter (`/api/v1/eliza/agents/<id>`) or a dedicated agent
 * on its own `<id>.cloud.eliza.app` subdomain. A chat-send 404 against such a base
 * is ambiguous: it can mean "the conversation was deleted" (recoverable by
 * recreating the conversation) OR "the agent itself was deleted / is
 * unreachable" — in which case recreating the conversation also 404s and the
 * user's message must NOT be silently dropped.
 */
function isCloudAgentBase(value: string | null | undefined): boolean {
  return isLimitedCloudAgentApiBase(value);
}

const SENT_TURN_MATCH_SLACK_MS = 60_000;

interface AssistantTurnOrigin {
  optimisticUserMessageId: string;
  text: string;
  sentAt: number;
  persistedUserMessageId?: string;
}

interface CompletedTurnHistorySnapshot {
  userReceiptId: string;
  assistantReceiptId: string | undefined;
  user: ConversationMessage | null;
  assistant: ConversationMessage | null;
}

function captureCompletedTurnForHistoryRefresh(
  messages: readonly ConversationMessage[],
  ids: {
    userReceiptId: string;
    assistantReceiptId?: string;
    optimisticUserMessageId: string;
    optimisticAssistantMessageId: string;
  },
): CompletedTurnHistorySnapshot {
  return {
    userReceiptId: ids.userReceiptId,
    assistantReceiptId: ids.assistantReceiptId,
    user:
      messages.find(
        (message) =>
          message.role === "user" &&
          (message.id === ids.userReceiptId ||
            message.id === ids.optimisticUserMessageId ||
            message.clientRenderId === ids.optimisticUserMessageId),
      ) ?? null,
    assistant:
      messages.find(
        (message) =>
          message.role === "assistant" &&
          (message.id === ids.assistantReceiptId ||
            message.id === ids.optimisticAssistantMessageId ||
            message.clientRenderId === ids.optimisticAssistantMessageId),
      ) ?? null,
  };
}

/**
 * Whether another user turn follows the turn that owns a local assistant row.
 *
 * A view navigation can remount the chat hook while the older request is still
 * settling. History reconciliation then rekeys the optimistic user row and may
 * append its unresolved assistant placeholder after newer server messages. The
 * durable user id is authoritative; the text/time match only covers runtimes
 * that omit that id from the terminal frame.
 */
function hasNewerUserTurn(
  messages: readonly ConversationMessage[],
  origin: AssistantTurnOrigin,
): boolean {
  const originIds = new Set([
    origin.optimisticUserMessageId,
    ...(origin.persistedUserMessageId ? [origin.persistedUserMessageId] : []),
  ]);
  let originIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      (originIds.has(message.id) ||
        (message.clientRenderId
          ? originIds.has(message.clientRenderId)
          : false)),
  );

  if (originIndex < 0) {
    let closestDelta = Number.POSITIVE_INFINITY;
    messages.forEach((message, index) => {
      if (
        message.role !== "user" ||
        message.text.trim() !== origin.text.trim()
      ) {
        return;
      }
      const delta = Math.abs(message.timestamp - origin.sentAt);
      if (delta <= SENT_TURN_MATCH_SLACK_MS && delta < closestDelta) {
        originIndex = index;
        closestDelta = delta;
      }
    });
  }

  if (originIndex >= 0) {
    return messages
      .slice(originIndex + 1)
      .some((message) => message.role === "user");
  }

  return messages.some(
    (message) => message.role === "user" && message.timestamp > origin.sentAt,
  );
}
function abortServerConversationTurn(
  roomId: string | null | undefined,
  reason: string,
): void {
  if (!roomId) return;
  // error-policy:J6 best-effort abort signal for a turn the user already
  // stopped locally; the server also ends the turn when the SSE closes.
  void client.abortConversationTurn(roomId, reason).catch((err) => {
    logger.warn(
      `[useChatSend] abortConversationTurn(${roomId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export interface QueuedChatSend {
  rawInput: string;
  channelType: ConversationChannelType;
  conversationId?: string | null;
  images?: ImageAttachment[];
  metadata?: Record<string, unknown>;
  /** Stable idempotency key for the initial request and route-level recovery. */
  clientMessageId: string;
  /** Stable local row identities for this queued logical turn. */
  optimisticTurn: {
    userMsgId: string;
    assistantMsgId: string;
    timestamp: number;
  };
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Composer payload recovered when queued turns are cancelled before transport. */
export interface RestoredQueuedDraft {
  text: string;
  images: ImageAttachment[];
}

/** Public options accepted by programmatic chat sends. */
export interface ChatSendTextOptions {
  channelType?: ConversationChannelType;
  conversationId?: string | null;
  images?: ImageAttachment[];
  metadata?: Record<string, unknown>;
  /** Optional caller-supplied idempotency key for this logical turn. */
  clientMessageId?: string;
}

interface ChatSendTextInternalOptions extends ChatSendTextOptions {
  [CHAT_SEND_HYDRATION_SETTLED]?: true;
  [CHAT_SEND_IDENTITY_OVERRIDE]?: {
    clientMessageId: string;
    optimisticTurn: QueuedChatSend["optimisticTurn"];
  };
}

/**
 * Commands render only after the drain resolves whether they are local,
 * rewritten, or regular chat. Painting them at enqueue would briefly expose a
 * user-only row before the command result replaces it.
 */
function isDrainPaintedCommand(rawInput: string): boolean {
  const prefix = rawInput.trimStart().charAt(0);
  return prefix === "/" || prefix === "#" || prefix === "$";
}

function createOptimisticTurn(
  clientMessageId: string,
): QueuedChatSend["optimisticTurn"] {
  return {
    userMsgId: `temp-${clientMessageId}`,
    assistantMsgId: `temp-resp-${clientMessageId}`,
    timestamp: Date.now(),
  };
}

function createOptimisticUserMessage(
  turn: Pick<QueuedChatSend, "rawInput" | "images" | "optimisticTurn">,
): ConversationMessage {
  const { userMsgId, timestamp } = turn.optimisticTurn;
  const rawText = turn.rawInput.trim();
  const attachments = turn.images?.length
    ? turn.images.map((image, index) => ({
        id: `${userMsgId}-img-${index}`,
        url: `data:${image.mimeType};base64,${image.data}`,
        contentType: optimisticAttachmentKind(image.mimeType),
        ...(image.name ? { title: image.name } : {}),
        mimeType: image.mimeType,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
        ...(image.transcriptId ? { transcriptId: image.transcriptId } : {}),
        ...(image.thumbnail
          ? {
              thumbnailUrl: `data:${image.thumbnail.mimeType};base64,${image.thumbnail.data}`,
            }
          : {}),
      }))
    : undefined;

  return {
    id: userMsgId,
    clientRenderId: userMsgId,
    role: "user",
    text:
      turn.images?.length && !rawText
        ? "Please review the attached image."
        : rawText,
    timestamp,
    ...(attachments ? { attachments } : {}),
  };
}

// ── Deps interface ──────────────────────────────────────────────────

export interface UseChatSendDeps {
  // Translation
  t: (key: string) => string;

  // UI state
  uiLanguage: string;
  tab: Tab;

  // Chat state
  activeConversationId: string | null;
  /** Current composer text, used to avoid overwriting a draft on setup resume. */
  chatInput?: string;
  /** Setup continuation waits until first-run no longer owns the composer. */
  firstRunComplete?: boolean;
  /** Stable ref whose .current mirrors the latest ptySessions array. */
  ptySessionsRef: MutableRefObject<CodingAgentSession[]>;

  // Setters
  setChatInput: (v: string) => void;
  setChatSending: (v: boolean) => void;
  setChatFirstTokenReceived: (v: boolean) => void;
  /** Set/clear the live server-reported phase of the in-flight turn (#8813).
   *  Fed by the chat-send SSE `onStatus`; cleared when the turn settles. */
  setServerTurnStatus: (status: ChatTurnStatus | null) => void;
  setChatLastUsage: (v: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string | undefined;
    updatedAt: number;
  }) => void;
  setChatPendingImages: (v: ImageAttachment[]) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  setActiveConversationId: (v: string | null) => void;
  setCompanionMessageCutoffTs: (v: number) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setUnreadConversations: (
    v: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  setChatReplyTarget: (v: ChatReplyTarget | null) => void;
  setActionNotice: (
    text: string,
    tone: "success" | "error" | "info",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Refs
  activeConversationIdRef: MutableRefObject<string | null>;
  chatInputRef: MutableRefObject<string>;
  chatPendingImagesRef: MutableRefObject<ImageAttachment[]>;
  chatReplyTargetRef: MutableRefObject<ChatReplyTarget | null>;
  conversationsRef: MutableRefObject<Conversation[]>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  conversationHydrationEpochRef: MutableRefObject<number>;
  chatAbortRef: MutableRefObject<AbortController | null>;
  chatSendBusyRef: MutableRefObject<boolean>;
  chatSendNonceRef: MutableRefObject<number>;

  // Loaders
  loadConversations: () => Promise<Conversation[] | null>;
  loadConversationMessages: (
    convId: string,
  ) => Promise<LoadConversationMessagesResult>;
  claimConversationMessagesOwnership: (conversationId: string | null) => number;
  isConversationMessagesOwnershipCurrent: (
    conversationId: string | null,
    generation: number,
  ) => boolean;
  registerConversationMessageOverlay: (
    conversationId: string | null,
    lineages: readonly string[],
    explicitMessages?: readonly ConversationMessage[],
  ) => void;
  applyConversationMessageOverlayModification: (
    conversationId: string | null,
    lineage: string,
    modification: StreamingTextModification,
    options?: { onlyIfEmpty?: boolean },
  ) => void;
  removeConversationMessageStateMessages?: (
    conversationId: string,
    mutation: ConversationMessageStateMutation,
  ) => void;
  discardConversationMessageState: (conversationId?: string) => void;
  /**
   * Waits for any startup conversation restore to settle before a user turn
   * claims conversation ownership. Callers without startup hydration may omit
   * this dependency.
   */
  settleConversationHydrationForSend?: () => Promise<boolean>;

  // Cloud state
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  pollCloudCredits: () => Promise<boolean>;
}

// ── Hook ────────────────────────────────────────────────────────────

export async function createConversationForFirstSend(
  chatClient: Pick<typeof client, "createConversation" | "getBaseUrl">,
  lang: string,
  title?: string,
): Promise<{ conversation: Conversation }> {
  const sharedAgentId = directCloudSharedAgentIdFromBase(
    chatClient.getBaseUrl(),
  );
  if (sharedAgentId) {
    // The shared-agent server POST handler ignores the request body, so the
    // title cannot round-trip; synthesize the canonical record locally and
    // skip the redundant cold Worker/Hyperdrive create entirely. The optional
    // `title` only feeds the real REST fallback below.
    const createdAt = new Date().toISOString();
    return {
      conversation: {
        id: sharedAgentId,
        title: "Chat",
        roomId: sharedAgentId,
        createdAt,
        updatedAt: createdAt,
      },
    };
  }
  return chatClient.createConversation(title, { lang });
}

export async function prewarmSharedChatScope(
  chatClient: Pick<typeof client, "getBaseUrl" | "getStatus">,
): Promise<void> {
  if (!directCloudSharedAgentIdFromBase(chatClient.getBaseUrl())) return;
  // Selecting a shared Cloud agent and mounting its composer is a strong signal
  // that a turn is imminent. Warm the exact authenticated scope gate before the
  // user presses Send, so API-key validation, user/org hydration, and agent
  // resolution do not all land on the click-to-first-token critical path.
  await chatClient.getStatus();
}

export function useChatSend(deps: UseChatSendDeps) {
  const {
    t,
    uiLanguage,
    tab,
    activeConversationId,
    chatInput = "",
    firstRunComplete = true,
    ptySessionsRef,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    setChatReplyTarget,
    setActionNotice,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    loadConversations,
    loadConversationMessages,
    claimConversationMessagesOwnership,
    isConversationMessagesOwnershipCurrent,
    registerConversationMessageOverlay,
    applyConversationMessageOverlayModification,
    removeConversationMessageStateMessages,
    discardConversationMessageState,
    settleConversationHydrationForSend,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
  } = deps;

  const chatSendQueueRef = useRef<QueuedChatSend[]>([]);
  const activeChatTurnRef = useRef<ActiveChatTurn | null>(null);
  // ElizaClient owns a mutable base outside React state. Snapshot it each render
  // so selecting another agent retriggers the prewarm effect.
  const chatScopePrewarmBase = client.getBaseUrl();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the mutable client base snapshot is the intentional external dependency.
  useEffect(() => {
    void prewarmSharedChatScope(client).catch((error) => {
      // Best-effort only. Send still runs the unchanged authoritative auth gate,
      // so a prewarm outage must not disable or alter normal error semantics.
      logger.debug(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[chat] shared scope prewarm failed",
      );
    });
  }, [chatScopePrewarmBase]);

  // A lifecycle abort is different from an explicit Stop. During teardown the
  // new page owns recovery, so the durable pending-turn receipt must survive
  // the abort/finally microtask. Explicit stops and all other terminal paths
  // still clear it normally.
  const unmountingRef = useRef(false);

  // Freeze-on-shared (cloud-agent handoff, PR2). While a shared→dedicated
  // handoff is migrating, the user is still pointed at the SHARED agent but the
  // shared transcript has already been (or is about to be) snapshotted. The
  // import endpoint is populated-room skip-all idempotent, so any message that
  // reaches the shared history AFTER the snapshot is silently lost — a re-import
  // inserts zero. To guarantee no loss we DON'T send outgoing messages to the
  // shared agent during the window: they sit in `chatSendQueueRef` (un-drained)
  // and are flushed once `onSwitch` has re-pointed the client at the dedicated
  // container (which already holds the copied history). When no handoff is in
  // flight this stays false → the drain runs exactly as before (byte-identical
  // when `preferSharedCloudTier` is off, since no `migrating` phase ever fires).
  const handoffFrozenRef = useRef(false);

  // Streaming-paint coalescer.
  // The SSE stream fires three per-event callbacks that each trigger a state
  // commit: `onToken` (cumulative text, often >60/sec on a fast model),
  // `onStatus` (live turn phase), and `onToolEvent` (inline tool-call steps).
  // A microtask merges callbacks decoded from one transport event, but a fast
  // model still delivers separate events faster than the full chat overlay can
  // render them. Park cumulative snapshots and paint the first one immediately,
  // then at a bounded cadence. Terminal/abort paths synchronously flush the
  // latest snapshot, so throttling cannot lose text. A timeout is the delivery
  // clock rather than rAF because hidden/resource-constrained tabs may defer
  // animation frames for seconds.
  //
  // `pendingStatus` uses the NO_PENDING_STATUS sentinel = "no status update
  // parked", distinct from a parked `null` (an explicit clear-the-status
  // commit).
  const streamingFlushRef = useRef<{
    conversationId: string | null;
    messageId: string;
    pendingText: string | null;
    /** Whether the parked text is action-callback (provisional) text — the
     *  latest frame wins, mirroring `pendingText` (double-speak fix). */
    pendingTextProvisional: boolean;
    pendingStatus: ChatTurnStatus | null | typeof NO_PENDING_STATUS;
    pendingToolEvents: ChatToolCallEvent[];
    flushScheduled: boolean;
    flushGeneration: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    lastFlushAtMs: number | null;
  }>({
    conversationId: null,
    messageId: "",
    pendingText: null,
    pendingTextProvisional: false,
    pendingStatus: NO_PENDING_STATUS,
    pendingToolEvents: [],
    flushScheduled: false,
    flushGeneration: 0,
    flushTimer: null,
    lastFlushAtMs: null,
  });

  const isConversationCommitActive = useCallback(
    (conversationId: string | null): boolean =>
      activeConversationIdRef.current === conversationId,
    [activeConversationIdRef],
  );

  const createTurnViewHandoff = useCallback(
    (owner: ChatViewHandoffOwner) =>
      createCompletedViewHandoff(
        () =>
          !unmountingRef.current &&
          owner.controller !== null &&
          !owner.controller.signal.aborted &&
          activeChatTurnRef.current?.controller === owner.controller &&
          activeConversationIdRef.current === owner.conversationId &&
          owner.generation !== null &&
          isConversationMessagesOwnershipCurrent(
            owner.conversationId,
            owner.generation,
          ),
        (message) => setActionNotice(message, "error", 8_000),
      ),
    [
      activeConversationIdRef,
      isConversationMessagesOwnershipCurrent,
      setActionNotice,
    ],
  );

  const setConversationMessagesForConversation = useCallback(
    (
      conversationId: string | null,
      value:
        | ConversationMessage[]
        | ((prev: ConversationMessage[]) => ConversationMessage[]),
    ) => {
      if (!isConversationCommitActive(conversationId)) return;
      setConversationMessages(value);
    },
    [isConversationCommitActive, setConversationMessages],
  );

  const applyStreamingModificationForConversation = useCallback(
    (
      conversationId: string | null,
      modification: Parameters<typeof applyStreamingTextModification>[1],
    ) => {
      if (!isConversationCommitActive(conversationId)) {
        applyConversationMessageOverlayModification(
          conversationId,
          modification.messageId,
          modification,
        );
        return;
      }
      applyStreamingTextModification(setConversationMessages, modification);
    },
    [
      applyConversationMessageOverlayModification,
      isConversationCommitActive,
      setConversationMessages,
    ],
  );

  const reconcileTerminalStream = useCallback(
    (
      conversationId: string,
      assistantMessageId: string,
      streamedAssistantText: string,
      data: ConversationStreamResult,
      options: {
        includeReasoning: boolean;
        includeAccountConnect: boolean;
        origin: Omit<AssistantTurnOrigin, "persistedUserMessageId">;
      },
    ): string | null => {
      if (data.transcriptVisibility === "internal") {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "drop",
        });
        return null;
      }

      const capabilityHandoff = findCapabilityHandoff(
        data.actionResults,
        directCloudSharedAgentIdFromBase(client.getBaseUrl()),
      );
      if (capabilityHandoff) {
        rememberCapabilityHandoff(
          data.messageId ?? assistantMessageId,
          capabilityHandoff,
        );
      }

      // A non-durable failure belongs only to the turn that produced it. If a
      // later user turn already exists, this request settled out of order after
      // a remount/history reload; dropping its placeholder prevents an old
      // fallback from appearing beneath a newer successful reply.
      if (
        data.assistantEphemeral &&
        isConversationCommitActive(conversationId) &&
        hasNewerUserTurn(conversationMessagesRef.current, {
          ...options.origin,
          ...(data.userMessageId
            ? { persistedUserMessageId: data.userMessageId }
            : {}),
        })
      ) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "drop",
        });
        return null;
      }

      // A durable reply is the authoritative completion of a newer turn. Any
      // already-rendered local-only failure has crossed its retirement boundary
      // and must not survive beside the successful server transcript.
      if (data.completed && data.messageId && !data.assistantEphemeral) {
        setConversationMessagesForConversation(conversationId, (prev) => {
          const next = prev.filter(
            (message) => message.assistantEphemeral !== true,
          );
          return next.length === prev.length ? prev : next;
        });
      }

      // A done frame confirms a durable receipt, not successful generation.
      // Preserve interruption, including zero-token receipts, before any
      // history refresh so neither the renderer nor voice sees a normal reply.
      if (data.interrupted === true || !data.completed) {
        const interruptedText =
          data.interrupted === true
            ? data.text
            : data.text || streamedAssistantText;
        if (data.interrupted !== true && !interruptedText.trim()) {
          // A dropped transport with no text has not supplied an assistant
          // receipt. Let history recovery adopt one instead of retaining an
          // invented empty terminal row beside the recovered user message.
          applyStreamingModificationForConversation(conversationId, {
            messageId: assistantMessageId,
            mode: "drop",
          });
          return null;
        }
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "complete",
          fullText: interruptedText,
          interrupted: true,
          ...(data.userMessageId
            ? { replyToMessageId: data.userMessageId }
            : {}),
          ...(data.failureKind ? { failureKind: data.failureKind } : {}),
          ...(data.replyRecoveryAvailable === true
            ? { replyRecoveryAvailable: true }
            : {}),
          ...(data.terminalFailure
            ? { terminalFailure: data.terminalFailure }
            : {}),
          ...(options.includeReasoning && data.reasoning
            ? { reasoning: data.reasoning }
            : {}),
          ...(data.assistantEphemeral ? { assistantEphemeral: true } : {}),
          ...(data.messageId ? { persistedMessageId: data.messageId } : {}),
        });
        return interruptedText.trim() ? interruptedText : null;
      }

      if (!data.text.trim() && !capabilityHandoff) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          ...(data.failureKind
            ? {
                mode: "fail",
                failureKind: data.failureKind,
                ...(data.replyRecoveryAvailable === true
                  ? { replyRecoveryAvailable: true }
                  : {}),
                ...(data.terminalFailure
                  ? { terminalFailure: data.terminalFailure }
                  : {}),
              }
            : { mode: "drop" }),
        });
      } else if (
        shouldApplyFinalStreamText(streamedAssistantText, data.text) ||
        (options.includeReasoning && data.reasoning) ||
        capabilityHandoff ||
        data.messageId ||
        data.userMessageId ||
        data.assistantEphemeral
      ) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "complete",
          fullText: data.text,
          ...(data.userMessageId
            ? { replyToMessageId: data.userMessageId }
            : {}),
          ...(data.failureKind ? { failureKind: data.failureKind } : {}),
          ...(data.replyRecoveryAvailable === true
            ? { replyRecoveryAvailable: true }
            : {}),
          ...(data.terminalFailure
            ? { terminalFailure: data.terminalFailure }
            : {}),
          ...(options.includeAccountConnect && data.accountConnect
            ? { accountConnect: data.accountConnect }
            : {}),
          ...(capabilityHandoff ? { capabilityHandoff } : {}),
          ...(options.includeReasoning && data.reasoning
            ? { reasoning: data.reasoning }
            : {}),
          ...(data.assistantEphemeral ? { assistantEphemeral: true } : {}),
          ...(data.messageId ? { persistedMessageId: data.messageId } : {}),
        });
      } else if (data.failureKind) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "fail",
          failureKind: data.failureKind,
          ...(data.replyRecoveryAvailable === true
            ? { replyRecoveryAvailable: true }
            : {}),
          ...(data.terminalFailure
            ? { terminalFailure: data.terminalFailure }
            : {}),
        });
      } else if (
        (options.includeAccountConnect && data.accountConnect) ||
        capabilityHandoff
      ) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "complete",
          fullText: data.text,
          ...(options.includeAccountConnect && data.accountConnect
            ? { accountConnect: data.accountConnect }
            : {}),
          ...(capabilityHandoff ? { capabilityHandoff } : {}),
          ...(data.assistantEphemeral ? { assistantEphemeral: true } : {}),
          ...(data.messageId ? { persistedMessageId: data.messageId } : {}),
        });
      }

      return null;
    },
    [
      applyStreamingModificationForConversation,
      conversationMessagesRef,
      isConversationCommitActive,
      setConversationMessagesForConversation,
    ],
  );

  const setServerTurnStatusForConversation = useCallback(
    (conversationId: string | null, status: ChatTurnStatus | null) => {
      if (!isConversationCommitActive(conversationId)) return;
      setServerTurnStatus(status);
    },
    [isConversationCommitActive, setServerTurnStatus],
  );

  // Commit whatever text/status/tool events are parked for the in-flight turn in
  // one pass, then clear the pending slots. Order matters: tool events merge
  // onto the same turn as the text, and the status is a sibling indicator — all
  // three settle together so the commit reflects one coherent stream state.
  // Safe to call when nothing is pending (no-op).
  const commitStreamingBuffer = useCallback(() => {
    const buffer = streamingFlushRef.current;
    const commitVisible = isConversationCommitActive(buffer.conversationId);
    let committed = false;
    if (buffer.pendingText !== null) {
      const fullText = buffer.pendingText;
      const provisional = buffer.pendingTextProvisional;
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      const modification: StreamingTextModification = {
        messageId: buffer.messageId,
        mode: "replace",
        fullText,
        provisional,
      };
      if (commitVisible) {
        applyStreamingTextModification(setConversationMessages, modification);
      } else {
        applyConversationMessageOverlayModification(
          buffer.conversationId,
          buffer.messageId,
          modification,
        );
      }
      committed = true;
    }
    if (buffer.pendingToolEvents.length > 0) {
      const toolEvents = buffer.pendingToolEvents;
      buffer.pendingToolEvents = [];
      for (const event of toolEvents) {
        const modification: StreamingTextModification = {
          messageId: buffer.messageId,
          mode: "tool",
          event,
        };
        if (commitVisible) {
          applyStreamingTextModification(setConversationMessages, modification);
        } else {
          applyConversationMessageOverlayModification(
            buffer.conversationId,
            buffer.messageId,
            modification,
          );
        }
      }
      committed = true;
    }
    if (buffer.pendingStatus !== NO_PENDING_STATUS) {
      const status = buffer.pendingStatus;
      buffer.pendingStatus = NO_PENDING_STATUS;
      if (commitVisible) {
        setServerTurnStatus(status);
        committed = true;
      }
    }
    if (committed) buffer.lastFlushAtMs = performance.now();
  }, [
    applyConversationMessageOverlayModification,
    isConversationCommitActive,
    setConversationMessages,
    setServerTurnStatus,
  ]);

  // Apply whatever streaming state is parked for the in-flight turn NOW and
  // invalidate its pending microtask/timer. Called before every terminal/abort
  // transition so no token, tool row, or status is lost.
  const flushStreamingText = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
    }
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }
    commitStreamingBuffer();
  }, [commitStreamingBuffer]);

  // Reset the buffer to a fresh turn when `messageId` changes, dropping any
  // stale parked state (text/status/tool) from the prior turn. Runs BEFORE a
  // scheduler parks its value, so the reset never clobbers the value just set.
  const startStreamingTurn = useCallback(
    (conversationId: string, messageId: string) => {
      const buffer = streamingFlushRef.current;
      if (
        buffer.conversationId === conversationId &&
        buffer.messageId === messageId
      )
        return;
      if (buffer.flushScheduled) buffer.flushGeneration += 1;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.conversationId = conversationId;
      buffer.messageId = messageId;
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
      buffer.flushScheduled = false;
      buffer.lastFlushAtMs = null;
    },
    [],
  );

  // The first snapshot paints in a microtask; later snapshots within the
  // cadence window share one trailing timer and overwrite the cumulative text.
  const ensureStreamingFlush = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) return;
    buffer.flushScheduled = true;
    const generation = buffer.flushGeneration;
    const commitScheduled = () => {
      if (buffer.flushGeneration !== generation) return;
      buffer.flushTimer = null;
      buffer.flushScheduled = false;
      commitStreamingBuffer();
    };
    const delayMs = streamingRenderDelayMs(
      buffer.lastFlushAtMs,
      performance.now(),
    );
    if (delayMs === 0) {
      queueMicrotask(commitScheduled);
      return;
    }
    buffer.flushTimer = setTimeout(commitScheduled, delayMs);
  }, [commitStreamingBuffer]);

  // Park the latest cumulative text for `messageId`. Synchronous callbacks from
  // one decoded SSE batch overwrite the parked value and commit together.
  const scheduleStreamingText = useCallback(
    (
      conversationId: string,
      messageId: string,
      fullText: string,
      provisional = false,
    ) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingText = fullText;
      streamingFlushRef.current.pendingTextProvisional = provisional;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Park a live turn-status phase for `messageId`; the latest value wins within
  // one synchronous transport burst (superseded phases are never rendered).
  // Coalesced with text/tool events from that burst (#8813).
  const scheduleServerTurnStatus = useCallback(
    (
      conversationId: string,
      messageId: string,
      status: ChatTurnStatus | null,
    ) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingStatus = status;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Park one inline tool-call step for `messageId`. Unlike text/status these
  // ACCUMULATE within a transport burst — each step (call → result/error) is a distinct
  // merge onto the turn's `toolEvents`, so none may be dropped (#13535).
  const scheduleToolEvent = useCallback(
    (conversationId: string, messageId: string, event: ChatToolCallEvent) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingToolEvents.push(event);
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Invalidate any queued flush on unmount so it cannot commit into a torn-down
  // tree.
  useEffect(() => {
    const buffer = streamingFlushRef.current;
    return () => {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.pendingText = null;
      buffer.pendingTextProvisional = false;
      buffer.conversationId = null;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
    };
  }, []);

  useEffect(() => {
    // StrictMode and Fast Refresh replay setup after cleanup on the same refs.
    // A new mounted lifetime must accept its own turns; cleanup still aborts
    // the previous controller so its callbacks cannot regain authority.
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
      const activeTurn = activeChatTurnRef.current;
      if (activeTurn?.abortServerTurn) {
        activeTurn.controller.signal.removeEventListener(
          "abort",
          activeTurn.abortServerTurn,
        );
      }
      activeTurn?.controller.abort();
      chatAbortRef.current?.abort();
      activeChatTurnRef.current = null;
      chatAbortRef.current = null;
      chatSendBusyRef.current = false;
      chatSendQueueRef.current.splice(0);
    };
  }, [chatAbortRef, chatSendBusyRef]);

  const resolveQueuedChatSends = useCallback(
    (conversationId: string | null): RestoredQueuedDraft => {
      const queued: QueuedChatSend[] = [];
      const retained: QueuedChatSend[] = [];
      for (const turn of chatSendQueueRef.current) {
        if ((turn.conversationId ?? null) === conversationId) {
          queued.push(turn);
        } else {
          retained.push(turn);
        }
      }
      chatSendQueueRef.current.splice(
        0,
        chatSendQueueRef.current.length,
        ...retained,
      );
      if (queued.length === 0) return { text: "", images: [] };
      const cancelledMessageIds = new Set(
        queued.flatMap((turn) => [
          turn.optimisticTurn.userMsgId,
          turn.optimisticTurn.assistantMsgId,
        ]),
      );
      setConversationMessagesForConversation(conversationId, (prev) =>
        prev.filter((message) => !cancelledMessageIds.has(message.id)),
      );
      for (const turn of queued) {
        turn.resolve();
      }
      // Composer state belongs to the visible conversation. Retaining other
      // conversations' queued turns prevents their drafts and attachments from
      // being moved into this composer when Stop races a conversation switch.
      const restored = queued
        .map((turn) => turn.rawInput.trim())
        .filter((text) => text.length > 0)
        .join("\n");
      const restoredImages = queued.flatMap((turn) => turn.images ?? []);
      if (restored) {
        setChatInput(restored);
      }
      if (restoredImages.length > 0) {
        setChatPendingImages(restoredImages);
      }
      if (restored || restoredImages.length > 0) {
        setActionNotice(
          restoredImages.length > 0
            ? "Your unsent message and attachments were restored to the input."
            : "Your unsent message was restored to the input.",
          "info",
          6_000,
        );
      }
      return { text: restored, images: restoredImages };
    },
    [
      setActionNotice,
      setChatInput,
      setChatPendingImages,
      setConversationMessagesForConversation,
    ],
  );

  const interruptActiveChatPipelineWithDraft =
    useCallback((): RestoredQueuedDraft => {
      const activeTurn = activeChatTurnRef.current;
      const restoredQueuedDraft = resolveQueuedChatSends(
        activeConversationIdRef.current ?? activeTurn?.conversationId ?? null,
      );
      if (activeTurn?.roomId) {
        abortServerConversationTurn(activeTurn.roomId, "ui-chat-stop");
      }
      if (activeTurn?.abortServerTurn) {
        activeTurn.controller.signal.removeEventListener(
          "abort",
          activeTurn.abortServerTurn,
        );
      }
      activeTurn?.controller.abort();
      chatAbortRef.current?.abort();
      // Commit any parked partial text (so a stopped turn keeps what the user saw)
      // and invalidate the pending scheduled flush so it can't fire after stop.
      flushStreamingText();
      activeChatTurnRef.current = null;
      chatAbortRef.current = null;
      setChatSending(false);
      setChatFirstTokenReceived(false);
      setServerTurnStatus(null);
      return restoredQueuedDraft;
    }, [
      chatAbortRef,
      activeConversationIdRef,
      flushStreamingText,
      resolveQueuedChatSends,
      setChatFirstTokenReceived,
      setServerTurnStatus,
      setChatSending,
    ]);

  const interruptActiveChatPipeline = useCallback((): string => {
    return interruptActiveChatPipelineWithDraft().text;
  }, [interruptActiveChatPipelineWithDraft]);

  const appendLocalCommandTurn = useCallback(
    (
      userText: string,
      assistantText: string,
      conversationId: string | null,
      ownershipGeneration: number | null,
    ) => {
      if (
        ownershipGeneration === null ||
        !isConversationMessagesOwnershipCurrent(
          conversationId,
          ownershipGeneration,
        )
      ) {
        return;
      }
      const now = Date.now();
      const nonce = Math.random().toString(36).slice(2, 8);
      setConversationMessagesForConversation(
        conversationId,
        (prev: ConversationMessage[]) => [
          ...prev,
          {
            id: `local-user-${now}-${nonce}`,
            role: "user",
            text: userText,
            timestamp: now,
          },
          {
            id: `local-assistant-${now}-${nonce}`,
            role: "assistant",
            text: assistantText,
            timestamp: now,
            source: "local_command",
          },
        ],
      );
    },
    [
      isConversationMessagesOwnershipCurrent,
      setConversationMessagesForConversation,
    ],
  );

  const tryHandlePrefixedChatCommand = useCallback(
    async (
      rawText: string,
      conversationId: string | null,
      ownershipGeneration: number | null,
    ): Promise<{ handled: boolean; rewrittenText?: string }> => {
      const commitLocalCommandTurn = (
        userText: string,
        assistantText: string,
      ) =>
        appendLocalCommandTurn(
          userText,
          assistantText,
          conversationId,
          ownershipGeneration,
        );
      const slash = parseSlashCommandInput(rawText);
      if (slash) {
        const savedCommand = loadSavedCustomCommands().find(
          (command) => normalizeSlashCommandName(command.name) === slash.name,
        );
        if (savedCommand) {
          const rewrittenText = expandSavedCustomCommand(
            savedCommand.text,
            slash.argsRaw,
          );
          if (!rewrittenText.trim()) {
            commitLocalCommandTurn(
              rawText,
              `Saved command "/${slash.name}" is empty.`,
            );
            return { handled: true };
          }
          return { handled: false, rewrittenText };
        }

        if (slash.name === "/commands") {
          const customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
          const customCommandNames = customActions
            .map((action) => `/${action.name.toLowerCase()}`)
            .sort();
          const savedCommandNames = loadSavedCustomCommands()
            .map((command) => `/${normalizeSlashCommandName(command.name)}`)
            .sort();
          const lines = [
            formatSearchBullet("Saved / commands", savedCommandNames),
            formatSearchBullet("Custom action / commands", customCommandNames),
            "Use #remember ... to save memory notes. Use #memory or #documents to target retrieval.",
            "Use $query for a quick, non-persistent context answer.",
          ];
          commitLocalCommandTurn(rawText, lines.join("\n\n"));
          return { handled: true };
        }

        let customActions: CustomActionDef[] = [];
        try {
          customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
        } catch (err) {
          // error-policy:J4 designed degrade: a broken custom-action catalog
          // must not block the send — the slash text falls through to normal
          // chat routing, and the failure is logged so it stays observable.
          logger.warn(
            `[useChatSend] listCustomActions failed; falling back to normal slash routing: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { handled: false };
        }

        const customAction = customActions.find(
          (action) =>
            `/${normalizeCustomActionName(action.name).toLowerCase()}` ===
            slash.name,
        );
        if (customAction) {
          const { params, missingRequired } = parseCustomActionParams(
            customAction,
            slash.argsRaw,
          );
          if (missingRequired.length > 0) {
            commitLocalCommandTurn(
              rawText,
              `Missing required parameter(s): ${missingRequired.join(", ")}`,
            );
            return { handled: true };
          }

          const result = await client.testCustomAction(customAction.id, params);
          if (!result.ok) {
            commitLocalCommandTurn(
              rawText,
              `Custom action "${customAction.name}" failed: ${
                result.error ?? "unknown error"
              }`,
            );
            return { handled: true };
          }

          commitLocalCommandTurn(
            rawText,
            result.output?.trim() || `(no output from ${customAction.name})`,
          );
          return { handled: true };
        }
      }

      if (rawText.startsWith("#")) {
        const commandBody = rawText.slice(1).trim();
        if (!commandBody) {
          commitLocalCommandTurn(
            rawText,
            "Usage: #remember <text>, #memory <query>, #documents <query>, or #<query>.",
          );
          return { handled: true };
        }

        const lower = commandBody.toLowerCase();
        if (
          lower.startsWith("remember ") ||
          lower.startsWith("remmeber ") ||
          lower.startsWith("save ")
        ) {
          const memoryText = commandBody
            .replace(/^(remember|remmeber|save)\s+/i, "")
            .trim();
          if (!memoryText) {
            commitLocalCommandTurn(rawText, "Nothing to remember.");
            return { handled: true };
          }
          await client.rememberMemory(memoryText);
          commitLocalCommandTurn(rawText, `Saved memory note: "${memoryText}"`);
          return { handled: true };
        }

        let scope: "memory" | "documents" | "all" = "all";
        let query = commandBody;
        if (lower.startsWith("memory ")) {
          scope = "memory";
          query = commandBody.slice("memory ".length).trim();
        } else if (lower.startsWith("documents ")) {
          scope = "documents";
          query = commandBody.slice("documents ".length).trim();
        } else if (lower.startsWith("all ")) {
          scope = "all";
          query = commandBody.slice("all ".length).trim();
        }

        if (!query) {
          commitLocalCommandTurn(rawText, "Search query cannot be empty.");
          return { handled: true };
        }

        const [memoryResult, documentResult] = await Promise.all([
          scope === "documents"
            ? Promise.resolve(null)
            : client.searchMemory(query, { limit: 6 }),
          scope === "memory"
            ? Promise.resolve(null)
            : client.searchDocuments(query, { threshold: 0.2, limit: 6 }),
        ]);

        const memoryLines =
          memoryResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
          ) ?? [];
        const documentLines =
          documentResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
          ) ?? [];

        commitLocalCommandTurn(
          rawText,
          [
            scope === "memory"
              ? "Memory search"
              : scope === "documents"
                ? "Knowledge search"
                : "Memory + knowledge search",
            "",
            scope === "documents"
              ? ""
              : formatSearchBullet("Memories", memoryLines),
            scope === "memory"
              ? ""
              : formatSearchBullet("Knowledge", documentLines),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return { handled: true };
      }

      if (rawText.startsWith("$")) {
        const queryRaw = rawText.slice(1).trim();
        if (queryRaw) {
          commitLocalCommandTurn(
            rawText,
            "Use bare `$` only. `$ <text>` is not supported.",
          );
          return { handled: true };
        }
        const query =
          "What is most relevant from memory and knowledge right now?";

        const quick = await client.quickContext(query, { limit: 6 });
        const memoryLines = quick.memories.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
        );
        const documentLines = quick.documents.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
        );
        commitLocalCommandTurn(
          rawText,
          [
            quick.answer,
            "",
            formatSearchBullet("Memories used", memoryLines),
            formatSearchBullet("Knowledge used", documentLines),
          ].join("\n"),
        );
        return { handled: true };
      }

      return { handled: false };
    },
    [appendLocalCommandTurn],
  );

  // Drop the empty assistant placeholder bubble (a temp-resp-* that never got
  // any streamed text) while preserving the user's message. Shared by every
  // send-failure branch so the predicate lives in one place and can't drift.
  const dropEmptyAssistantPlaceholder = useCallback(
    (conversationId: string | null, assistantMsgId: string) => {
      if (!isConversationCommitActive(conversationId)) {
        applyConversationMessageOverlayModification(
          conversationId,
          assistantMsgId,
          { messageId: assistantMsgId, mode: "drop" },
          { onlyIfEmpty: true },
        );
        return;
      }
      setConversationMessagesForConversation(conversationId, (prev) =>
        prev.filter(
          (message) => !(message.id === assistantMsgId && !message.text.trim()),
        ),
      );
    },
    [
      applyConversationMessageOverlayModification,
      isConversationCommitActive,
      setConversationMessagesForConversation,
    ],
  );

  // Re-attach a stopped/interrupted turn's partial reply after the post-turn
  // history reload full-replaced it away. The server frequently does NOT persist
  // a reply that was cut off mid-stream, so the reload returns a thread without
  // it and the bubble the user was watching stream in silently vanishes. Append
  // the partial as an interrupted assistant turn — but ONLY when the reloaded
  // thread's last message is not already an assistant turn (i.e. the server has
  // no reply for this turn). When the server DID persist a reply the reload
  // already carries it, so it is kept as-is and never duplicated.
  const reattachInterruptedPartial = useCallback(
    (
      conversationId: string | null,
      partialText: string,
      assistantEphemeral = false,
    ) => {
      const text = partialText.trim();
      if (!text) return;
      setConversationMessagesForConversation(conversationId, (prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") return prev;
        return [
          ...prev,
          {
            id: `local-interrupted-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            role: "assistant",
            text,
            timestamp: Date.now(),
            interrupted: true,
            ...(assistantEphemeral ? { assistantEphemeral: true } : {}),
          },
        ];
      });
    },
    [setConversationMessagesForConversation],
  );

  // Re-attach a user turn the post-turn history reload evicted. The reload
  // full-replaces the thread with server truth; when the server never
  // persisted the turn — a send during local-model warm-up where the
  // runtime-ready hold expired (503), or a runtime that answered with nothing
  // and stored nothing — the reload returns a thread WITHOUT the user's
  // message and the optimistic bubble the user just watched render silently
  // vanishes (#11670). Restore the bubble together with a retryable failed
  // assistant turn so the send fails loudly and one tap re-delivers it once
  // the model is ready. No-op when the reload carries the turn (server
  // persisted it) or never replaced local state (transient reload failure).
  const restoreEvictedUserTurn = useCallback(
    (
      conversationId: string | null,
      turn: {
        userMsgId: string;
        assistantMsgId: string;
        text: string;
        timestamp: number;
        attachments?: ConversationMessage["attachments"];
      },
    ) => {
      const sentText = turn.text.trim();
      if (!sentText) return;
      setConversationMessagesForConversation(conversationId, (prev) => {
        if (sentUserTurnPresent(prev, sentText, turn.timestamp)) return prev;
        return [
          ...prev,
          {
            id: turn.userMsgId,
            role: "user",
            text: turn.text,
            timestamp: turn.timestamp,
            ...(turn.attachments?.length
              ? { attachments: turn.attachments }
              : {}),
          },
          {
            id: `${turn.assistantMsgId}-undelivered`,
            role: "assistant",
            text: UNDELIVERED_TURN_NOTICE,
            timestamp: Date.now(),
            failureKind: "provider_issue",
          },
        ];
      });
    },
    [setConversationMessagesForConversation],
  );

  // A successful stream can carry durable user/assistant receipt ids before the
  // follow-up history endpoint exposes those rows.
  // When an action or compatibility response requires that immediate refresh,
  // the full replacement must retain the exact completed local turn until the
  // history view converges. Match only receipt/client-render ids for the user
  // row; merge missing rows adjacent to each other without duplicating server
  // truth.
  const preserveCompletedTurnAfterHistoryRefresh = useCallback(
    (
      conversationId: string | null,
      turn: {
        user: ConversationMessage;
        assistant: ConversationMessage | null;
        userReceiptId: string;
        assistantReceiptId?: string;
      },
    ) => {
      setConversationMessagesForConversation(conversationId, (prev) => {
        const userIds = new Set(
          [turn.userReceiptId, turn.user.id, turn.user.clientRenderId].filter(
            (value): value is string => Boolean(value),
          ),
        );
        const userIndex = prev.findIndex(
          (message) =>
            message.role === "user" &&
            (userIds.has(message.id) ||
              (message.clientRenderId
                ? userIds.has(message.clientRenderId)
                : false)),
        );
        const assistant = turn.assistant;
        const assistantIds = new Set(
          [
            turn.assistantReceiptId,
            assistant?.id,
            assistant?.clientRenderId,
          ].filter((value): value is string => Boolean(value)),
        );
        let assistantIndex = assistant
          ? prev.findIndex(
              (message) =>
                message.role === "assistant" &&
                (assistantIds.has(message.id) ||
                  (message.clientRenderId
                    ? assistantIds.has(message.clientRenderId)
                    : false)),
            )
          : -1;
        if (assistant && assistantIndex < 0 && !turn.assistantReceiptId) {
          assistantIndex = prev.findIndex(
            (message) =>
              message.role === "assistant" &&
              message.text.trim() === assistant.text.trim() &&
              Math.abs(message.timestamp - assistant.timestamp) <=
                SENT_TURN_MATCH_SLACK_MS,
          );
        }

        if (userIndex >= 0 && (!assistant || assistantIndex >= 0)) return prev;

        const next = [...prev];
        if (userIndex < 0 && assistantIndex >= 0) {
          next.splice(assistantIndex, 0, turn.user);
          return next;
        }
        if (userIndex >= 0 && assistant && assistantIndex < 0) {
          next.splice(userIndex + 1, 0, assistant);
          return next;
        }
        next.push(turn.user);
        if (assistant) next.push(assistant);
        return next;
      });
    },
    [setConversationMessagesForConversation],
  );

  const runQueuedChatSend = useCallback(
    async (turn: Omit<QueuedChatSend, "resolve" | "reject">) => {
      const hasAttachedImages = Boolean(turn.images?.length);
      const rawText = turn.rawInput.trim();
      if (!rawText && !hasAttachedImages) return;

      const channelType = turn.channelType;
      const imagesToSend = turn.images;
      const clientMessageId = turn.clientMessageId;
      const optimisticOwnerConversationId =
        turn.conversationId ?? activeConversationIdRef.current ?? null;
      // Snapshot ownership before the first command-resolution await. A queued
      // turn has already been shifted out of the queue at this point, so a
      // new-chat/select cannot find it to cancel; this token prevents the older
      // continuation from painting or rerouting itself when that await returns.
      const optimisticOwnerGeneration =
        activeConversationIdRef.current === optimisticOwnerConversationId
          ? claimConversationMessagesOwnership(optimisticOwnerConversationId)
          : null;
      let controller: AbortController | null = null;
      let abortServerTurn: (() => void) | null = null;
      let convRoomId: string | null = null;
      const viewHandoffOwner: ChatViewHandoffOwner = {
        conversationId: optimisticOwnerConversationId,
        generation: optimisticOwnerGeneration,
        controller,
      };
      const handoffView = createTurnViewHandoff(viewHandoffOwner);

      let text = hasAttachedImages
        ? rawText || "Please review the attached image."
        : rawText;
      if (rawText) {
        let commandResult: { handled: boolean; rewrittenText?: string };
        try {
          commandResult = await tryHandlePrefixedChatCommand(
            rawText,
            optimisticOwnerConversationId,
            optimisticOwnerGeneration,
          );
        } catch (err) {
          appendLocalCommandTurn(
            rawText,
            `Command failed: ${err instanceof Error ? err.message : "unknown error"}`,
            optimisticOwnerConversationId,
            optimisticOwnerGeneration,
          );
          return;
        }
        if (commandResult.handled) {
          return;
        }
        if (
          typeof commandResult.rewrittenText === "string" &&
          commandResult.rewrittenText.trim()
        ) {
          text = commandResult.rewrittenText.trim();
        }
      }

      if (
        optimisticOwnerGeneration !== null &&
        !isConversationMessagesOwnershipCurrent(
          optimisticOwnerConversationId,
          optimisticOwnerGeneration,
        )
      ) {
        setConversationMessagesForConversation(
          optimisticOwnerConversationId,
          (prev) =>
            prev.filter(
              (message) =>
                message.id !== turn.optimisticTurn.userMsgId &&
                message.id !== turn.optimisticTurn.assistantMsgId,
            ),
        );
        applyConversationMessageOverlayModification(
          optimisticOwnerConversationId,
          turn.optimisticTurn.userMsgId,
          { messageId: turn.optimisticTurn.userMsgId, mode: "drop" },
        );
        applyConversationMessageOverlayModification(
          optimisticOwnerConversationId,
          turn.optimisticTurn.assistantMsgId,
          { messageId: turn.optimisticTurn.assistantMsgId, mode: "drop" },
        );
        return;
      }

      const optimisticTurn = turn.optimisticTurn;
      const { userMsgId, assistantMsgId, timestamp: now } = optimisticTurn;
      const optimisticUserMessage = createOptimisticUserMessage({
        ...turn,
        rawInput: text,
      });
      const optimisticAttachments = optimisticUserMessage.attachments;
      const optimisticAssistantMessage: ConversationMessage = {
        id: assistantMsgId,
        clientRenderId: assistantMsgId,
        role: "assistant",
        text: "",
        timestamp: now,
      };
      if (isConversationCommitActive(optimisticOwnerConversationId)) {
        setCompanionMessageCutoffTs(now);
      }
      // The user row is painted at enqueue. Drain owns the assistant placeholder
      // because only now do prefixed commands resolve to local output, rewritten
      // chat, or a real model turn. The idempotent merge also covers a cold-start
      // send accepted before the active conversation exists.
      setConversationMessagesForConversation(
        optimisticOwnerConversationId,
        (prev: ConversationMessage[]) => {
          const userIndex = prev.findIndex(
            (message) => message.id === userMsgId,
          );
          const assistantIndex = prev.findIndex(
            (message) => message.id === assistantMsgId,
          );
          if (userIndex >= 0) {
            if (assistantIndex >= 0) return prev;
            return [
              ...prev.slice(0, userIndex + 1),
              optimisticAssistantMessage,
              ...prev.slice(userIndex + 1),
            ];
          }
          if (assistantIndex >= 0) {
            return [
              ...prev.slice(0, assistantIndex),
              optimisticUserMessage,
              ...prev.slice(assistantIndex),
            ];
          }
          return [...prev, optimisticUserMessage, optimisticAssistantMessage];
        },
      );
      registerConversationMessageOverlay(
        optimisticOwnerConversationId,
        [userMsgId, assistantMsgId],
        [optimisticUserMessage, optimisticAssistantMessage],
      );
      if (isConversationCommitActive(optimisticOwnerConversationId)) {
        setChatFirstTokenReceived(false);
      }

      let convId: string = optimisticOwnerConversationId ?? "";
      if (!convId) {
        try {
          const { conversation: rawConversation } =
            await createConversationForFirstSend(client, uiLanguage);
          if (!isConversationRecord(rawConversation)) {
            throw new Error(
              "Conversation creation returned an invalid payload.",
            );
          }
          const conversation = rawConversation;
          const nextCutoffTs = Date.now();
          setConversations((prev) => [conversation, ...prev]);
          // Re-home only this cold-open turn's exact registered lineages. If a
          // real selection won while createConversation was pending, this keeps
          // A's overlay with A without claiming or mutating B's visible store.
          registerConversationMessageOverlay(conversation.id, [
            userMsgId,
            assistantMsgId,
          ]);
          const shouldActivateCreatedConversation =
            optimisticOwnerGeneration !== null &&
            activeConversationIdRef.current === optimisticOwnerConversationId &&
            isConversationMessagesOwnershipCurrent(
              optimisticOwnerConversationId,
              optimisticOwnerGeneration,
            );
          if (shouldActivateCreatedConversation) {
            viewHandoffOwner.generation = claimConversationMessagesOwnership(
              conversation.id,
            );
            viewHandoffOwner.conversationId = conversation.id;
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
            setCompanionMessageCutoffTs(nextCutoffTs);
          }
          convId = conversation.id;
          convRoomId = conversation.roomId;
        } catch {
          // error-policy:J4 surfaced user-facing failure state.
          // First-message conversation creation failed (cold open on weak
          // signal). Remove the local accepted-turn rows and restore the draft:
          // no conversation exists to own or retry this turn yet.
          setConversationMessagesForConversation(
            optimisticOwnerConversationId,
            (prev) =>
              prev.filter(
                (message) =>
                  message.id !== userMsgId && message.id !== assistantMsgId,
              ),
          );
          applyConversationMessageOverlayModification(
            optimisticOwnerConversationId,
            userMsgId,
            { messageId: userMsgId, mode: "drop" },
          );
          applyConversationMessageOverlayModification(
            optimisticOwnerConversationId,
            assistantMsgId,
            { messageId: assistantMsgId, mode: "drop" },
          );
          if (
            optimisticOwnerGeneration !== null &&
            activeConversationIdRef.current === optimisticOwnerConversationId &&
            isConversationMessagesOwnershipCurrent(
              optimisticOwnerConversationId,
              optimisticOwnerGeneration,
            )
          ) {
            chatInputRef.current = rawText;
            setChatInput(rawText);
            if (imagesToSend?.length) {
              const restoredImages = [...imagesToSend];
              chatPendingImagesRef.current = restoredImages;
              setChatPendingImages(restoredImages);
            }
          }
          setActionNotice(
            `Couldn't start the conversation — check your connection and try again. ${imagesToSend?.length ? "Your message and attachments were restored." : "Your message was restored."}`,
            "error",
            8_000,
          );
          return;
        }
      }

      persistPendingChatTurn({
        conversationId: convId,
        clientMessageId,
        text,
        sentAt: now,
      });

      if (activeConversationIdRef.current === convId) {
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: convId,
        });
      }

      const activeConv = conversationsRef.current.find((c) => c.id === convId);
      // The room id is used only by the optional abort side-channel. Never hold
      // the primary message POST behind a conversation-list refresh: on Cloud
      // that extra edge/DB round trip can delay request dispatch by 3-4s even
      // though the optimistic bubble already painted. A known room id wins;
      // conversation id is the protocol fallback (and is canonical for shared
      // runtime conversations).
      convRoomId = resolveAbortRoomId(convId, convRoomId, activeConv?.roomId);
      if (
        activeConv &&
        (!activeConv.title ||
          activeConv.title === "New Chat" ||
          activeConv.title === "companion.newChat" ||
          activeConv.title === "conversations.newChatTitle")
      ) {
        const fallbackTitle =
          text.length > 15 ? `${text.slice(0, 15)}...` : text;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId ? { ...c, title: fallbackTitle } : c,
          ),
        );
      }

      controller = new AbortController();
      viewHandoffOwner.controller = controller;
      chatAbortRef.current = controller;
      abortServerTurn = () => {
        abortServerConversationTurn(convRoomId, "ui-chat-abort");
      };
      controller.signal.addEventListener("abort", abortServerTurn, {
        once: true,
      });
      activeChatTurnRef.current = {
        controller,
        conversationId: convId,
        roomId: convRoomId,
        abortServerTurn,
      };
      let streamedAssistantText = "";

      try {
        const data = await client.sendConversationMessageStream(
          convId,
          text,
          (token, accumulatedText, provisional) => {
            const nextText =
              typeof accumulatedText === "string"
                ? accumulatedText
                : mergeStreamingText(streamedAssistantText, token);
            if (nextText === streamedAssistantText) return;
            streamedAssistantText = nextText;
            if (isConversationCommitActive(convId)) {
              setChatFirstTokenReceived(true);
            }
            // Coalesce tokens delivered in one transport burst into a microtask;
            // the parked text is flushed synchronously before terminal changes.
            // Provisional (action-callback) text is stamped on the message so
            // voice output holds it until the final reply confirms or replaces
            // it (double-speak fix).
            scheduleStreamingText(
              convId,
              assistantMsgId,
              nextText,
              provisional === true,
            );
          },
          channelType,
          controller.signal,
          imagesToSend,
          turn.metadata,
          // Live server phase → the rich status indicator. Additive; the reply
          // streams through onToken above regardless. Coalesced into the same
          // transport-burst microtask as text/tool commits and flushed
          // synchronously before any terminal transition.
          (status) => scheduleServerTurnStatus(convId, assistantMsgId, status),
          // Inline tool-call steps → the turn's tool rows (call → result/error),
          // merged by callId so one row flips running → settled (#13535).
          // Coalesced into the current transport burst with the text + status.
          (event) => scheduleToolEvent(convId, assistantMsgId, event),
          // Stable idempotency key for this logical turn.
          clientMessageId,
          handoffView,
        );

        // Commit any token parked by the throttle before the terminal
        // drop/complete/fail/interrupt — no streamed tokens may be lost.
        flushStreamingText();

        if (data.userMessageId) {
          applyStreamingModificationForConversation(convId, {
            messageId: userMsgId,
            mode: "rekey",
            persistedMessageId: data.userMessageId,
          });
        }
        const interruptedPartial = reconcileTerminalStream(
          convId,
          assistantMsgId,
          streamedAssistantText,
          data,
          {
            includeReasoning: true,
            includeAccountConnect: true,
            origin: {
              optimisticUserMessageId: userMsgId,
              text,
              sentAt: now,
            },
          },
        );
        if (data.usage) {
          setChatLastUsage({
            promptTokens: data.usage.promptTokens,
            completionTokens: data.usage.completionTokens,
            totalTokens: data.usage.totalTokens,
            model: data.usage.model,
            updatedAt: Date.now(),
          });
        }

        // A stopped / dropped turn keeps a partial reply the user was watching.
        // Snapshot it BEFORE the reload below (which full-replaces local state
        // with the server's copy) so it can be re-attached if the server never
        // persisted it.
        // The stream result is the user-visible end of this turn. History
        // reconciliation can continue below, but it must not leave a completed
        // reply looking active. Keep the busy state when another turn is queued.
        setServerTurnStatusForConversation(convId, null);
        if (isConversationCommitActive(convId)) {
          setChatFirstTokenReceived(false);
        }
        if (chatSendQueueRef.current.length === 0) {
          if (isConversationCommitActive(convId)) {
            setChatSending(false);
          }
        }
        await handoffCompletedAction(data.actionResults, handoffView);

        const completedTurnSnapshot =
          isConversationCommitActive(convId) &&
          data.completed &&
          data.userMessageId
            ? captureCompletedTurnForHistoryRefresh(
                conversationMessagesRef.current,
                {
                  userReceiptId: data.userMessageId,
                  ...(data.messageId
                    ? { assistantReceiptId: data.messageId }
                    : {}),
                  optimisticUserMessageId: userMsgId,
                  optimisticAssistantMessageId: assistantMsgId,
                },
              )
            : null;

        // Direct replies already carry both committed memory ids, so reloading
        // the whole transcript would add a DB round trip, replace every message
        // object, and race the terminal frame. Action callbacks are the only
        // topology that may commit extra rows outside the streamed bubble.
        if (
          activeConversationIdRef.current === convId &&
          (data.historyRefreshRequired ||
            !data.completed ||
            (!data.messageId && !data.assistantEphemeral) ||
            !data.userMessageId)
        ) {
          await loadConversationMessages(convId);
          if (completedTurnSnapshot?.user) {
            preserveCompletedTurnAfterHistoryRefresh(convId, {
              user: completedTurnSnapshot.user,
              assistant: completedTurnSnapshot.assistant,
              userReceiptId: completedTurnSnapshot.userReceiptId,
              ...(completedTurnSnapshot.assistantReceiptId
                ? {
                    assistantReceiptId:
                      completedTurnSnapshot.assistantReceiptId,
                  }
                : {}),
            });
          }
          // The reload above full-replaces the thread; a stopped reply is often
          // NOT persisted server-side, so re-attach the partial the user watched
          // stream in (no-op / no duplicate when the server kept it).
          if (interruptedPartial) {
            reattachInterruptedPartial(
              convId,
              interruptedPartial,
              data.assistantEphemeral === true,
            );
          }
          // Same full-replace hazard for the USER turn: a send during agent
          // warm-up can complete with nothing persisted, and the reload then
          // evicts the user's bubble (#11670). Restore it with a retryable
          // failed turn; no-op when the server persisted it.
          // A terminal userMessageId is the server's persistence receipt. In
          // callback-only turns (notably attachment actions) the assistant row
          // may be committed outside the streamed bubble, so the history load
          // is necessary but can race that row's WS echo. Re-attaching the
          // optimistic user turn despite the receipt creates a duplicate user
          // bubble plus a false Retry failure. Only restore when the server did
          // not confirm persistence at all (the warm-up/drop case).
          if (!data.userMessageId) {
            restoreEvictedUserTurn(convId, {
              userMsgId,
              assistantMsgId,
              text,
              timestamp: now,
              ...(optimisticAttachments
                ? { attachments: optimisticAttachments }
                : {}),
            });
          }
        }

        const userMessageCount = isConversationCommitActive(convId)
          ? conversationMessagesRef.current.filter(
              (message) =>
                message.role === "user" && !message.id.startsWith("temp-"),
            ).length
          : null;

        if (
          userMessageCount === 1 &&
          data.completed !== false &&
          data.interrupted !== true &&
          data.text.trim() &&
          !data.failureKind &&
          !isCloudAgentBase(client.getBaseUrl())
        ) {
          void client
            .renameConversation(convId, "", { generate: true })
            .then(() => {
              void loadConversations();
            })
            .catch((err) => {
              // error-policy:J4 title generation is decorative — the snippet
              // fallback title is already applied; the reload keeps the list
              // fresh either way.
              logger.warn(
                `[useChatSend] conversation title generation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              void loadConversations();
            });
        } else {
          void loadConversations();
        }

        if (elizaCloudEnabled || elizaCloudConnected) {
          void pollCloudCredits();
        }
        clearPendingChatTurn(convId, clientMessageId);
      } catch (err) {
        // Commit any throttled-but-uncommitted token first so an abort/error
        // never drops a placeholder the user already saw fill with partial text.
        flushStreamingText();
        const abortError = err as Error;
        if (abortError.name === "AbortError" || controller?.signal.aborted) {
          dropEmptyAssistantPlaceholder(convId, assistantMsgId);
          return;
        }

        // A terminal SSE `error` event that carried a structured gate must
        // surface that gate on the assistant turn — the same UI the completed
        // response shows — instead of collapsing to a generic error notice that
        // loses the actionable signal (#10231). `no_provider` → the provider
        // gate; a connect-account request → the AccountConnectBlock.
        if (
          isStreamGenerationError(err) &&
          (err.failureKind || err.accountConnect)
        ) {
          if (err.failureKind) {
            applyStreamingModificationForConversation(convId, {
              messageId: assistantMsgId,
              mode: "fail",
              failureKind: err.failureKind,
            });
          } else if (err.accountConnect) {
            applyStreamingModificationForConversation(convId, {
              messageId: assistantMsgId,
              mode: "complete",
              fullText: "",
              accountConnect: err.accountConnect,
            });
          }
          return;
        }

        // A thrown JSON 402 (`code: insufficient_credits`) is a terminal
        // billing gate, not a transport hiccup: retrying re-hits the same
        // empty balance. Render the existing out-of-credits turn (banner +
        // "Add credits" CTA) instead of falling through to the generic
        // provider_issue Retry chip below (#18045). The classifier is the
        // same fail-closed 402 walk the /join surface layers its
        // welcome-bonus reading on.
        const creditGate = describeCreditGateError(err);
        if (creditGate) {
          applyStreamingModificationForConversation(convId, {
            messageId: assistantMsgId,
            mode: "complete",
            fullText: creditGate.message,
            failureKind: "insufficient_credits",
          });
          if (elizaCloudEnabled || elizaCloudConnected) {
            void pollCloudCredits();
          }
          return;
        }

        const status = (err as { status?: number }).status;
        if (status === 404) {
          // A 404 on send usually means the conversation row was deleted —
          // recreate it and replay. But on an Eliza Cloud agent base the 404 can
          // instead mean the AGENT itself was deleted / is unreachable, in which
          // case createConversation() ALSO 404s. Distinguish the two so we don't
          // silently drop the user's message on a dead agent.
          let conversation: Conversation;
          try {
            const { conversation: rawConversation } =
              await client.createConversation();
            if (!isConversationRecord(rawConversation)) {
              throw new Error(
                "Conversation creation returned an invalid payload.",
              );
            }
            conversation = rawConversation;
          } catch (createErr) {
            const createStatus = (createErr as { status?: number }).status;
            // Conversation recreation also failed against a cloud agent base —
            // the agent is gone/unreachable. Surface the failure and KEEP the
            // user's message (drop only the empty assistant placeholder) so the
            // user can retry or re-select an agent instead of losing their text.
            if (createStatus === 404 && isCloudAgentBase(client.getBaseUrl())) {
              setActionNotice(
                "This agent is no longer reachable — it may have been deleted. Your message was kept; pick another agent and try again.",
                "error",
                10_000,
              );
              dropEmptyAssistantPlaceholder(convId, assistantMsgId);
              return;
            }
            // Non-cloud base, or a different create failure — the recovery
            // could not produce a conversation to replay into. Drop the empty
            // placeholder and tell the user; a silent return here read as a
            // lost message.
            dropEmptyAssistantPlaceholder(convId, assistantMsgId);
            setActionNotice(buildSendFailureNotice(createErr), "error", 8_000);
            return;
          }

          // Seed ids live above the try so the failure handler below can
          // remove the replay's own placeholder (the original assistant id no
          // longer exists once the thread is re-seeded).
          const replayNow = Date.now();
          const replayUserId = `temp-${replayNow}`;
          const replayAssistantId = `temp-resp-${replayNow}`;
          try {
            const nextCutoffTs = Date.now();
            const shouldActivateReplay =
              activeConversationIdRef.current === convId &&
              viewHandoffOwner.generation !== null &&
              isConversationMessagesOwnershipCurrent(
                convId,
                viewHandoffOwner.generation,
              );
            discardConversationMessageState(convId);
            setConversations((prev) => [conversation, ...prev]);
            if (shouldActivateReplay) {
              viewHandoffOwner.generation = claimConversationMessagesOwnership(
                conversation.id,
              );
              viewHandoffOwner.conversationId = conversation.id;
              setActiveConversationId(conversation.id);
              activeConversationIdRef.current = conversation.id;
              setCompanionMessageCutoffTs(nextCutoffTs);
            }
            if (shouldActivateReplay) {
              client.sendWsMessage({
                type: "active-conversation",
                conversationId: conversation.id,
              });
            }

            // Seed the recreated conversation with the user turn + an empty
            // assistant placeholder, then REPLAY as a token stream — the 404
            // recovery must stream like the primary send, not pop the whole
            // reply in at once with the non-streaming endpoint (#10231).
            // Seed unfiltered (like the primary send path) — the empty assistant
            // placeholder must survive so streamed tokens have a target;
            // filterRenderableConversationMessages would drop an empty turn.
            const replayMessages: ConversationMessage[] = [
              {
                id: replayUserId,
                clientRenderId: replayUserId,
                role: "user",
                text,
                timestamp: replayNow,
              },
              {
                id: replayAssistantId,
                clientRenderId: replayAssistantId,
                role: "assistant",
                text: "",
                timestamp: replayNow,
              },
            ];
            setConversationMessagesForConversation(
              conversation.id,
              replayMessages,
            );
            registerConversationMessageOverlay(
              conversation.id,
              [replayUserId, replayAssistantId],
              replayMessages,
            );

            let replayStreamedText = "";
            const retryData = await client.sendConversationMessageStream(
              conversation.id,
              text,
              (token, accumulatedText, provisional) => {
                const nextText =
                  typeof accumulatedText === "string"
                    ? accumulatedText
                    : mergeStreamingText(replayStreamedText, token);
                if (nextText === replayStreamedText) return;
                replayStreamedText = nextText;
                if (isConversationCommitActive(conversation.id)) {
                  setChatFirstTokenReceived(true);
                }
                scheduleStreamingText(
                  conversation.id,
                  replayAssistantId,
                  nextText,
                  provisional === true,
                );
              },
              channelType,
              controller?.signal,
              imagesToSend,
              turn.metadata,
              (serverStatus) =>
                scheduleServerTurnStatus(
                  conversation.id,
                  replayAssistantId,
                  serverStatus,
                ),
              (event) =>
                scheduleToolEvent(conversation.id, replayAssistantId, event),
              // Same idempotency key across the whole logical turn, including
              // the 404 recreate-and-replay recovery.
              clientMessageId,
              handoffView,
            );

            await handoffCompletedAction(retryData.actionResults, handoffView);

            // Commit any throttle-parked token before the terminal modification.
            flushStreamingText();

            if (retryData.userMessageId) {
              applyStreamingModificationForConversation(conversation.id, {
                messageId: replayUserId,
                mode: "rekey",
                persistedMessageId: retryData.userMessageId,
              });
            }

            reconcileTerminalStream(
              conversation.id,
              replayAssistantId,
              replayStreamedText,
              retryData,
              {
                includeReasoning: true,
                includeAccountConnect: true,
                origin: {
                  optimisticUserMessageId: replayUserId,
                  text,
                  sentAt: replayNow,
                },
              },
            );
          } catch (replayErr) {
            // The re-seed above replaced the whole thread, so the ORIGINAL
            // placeholder id is gone — dropping it was a no-op that left the
            // replay's empty bubble stuck forever and the failure invisible.
            // Clean up the replay placeholder and surface the failure exactly
            // like the primary send path (aborts stay silent by design).
            flushStreamingText();
            dropEmptyAssistantPlaceholder(conversation.id, replayAssistantId);
            if (
              (replayErr as Error).name !== "AbortError" &&
              !controller?.signal.aborted
            ) {
              setActionNotice(
                buildSendFailureNotice(replayErr),
                "error",
                8_000,
              );
            }
          }
        } else {
          // Non-abort, non-404 send failure (network/timeout/5xx/auth/429/4xx).
          // Surface the manual resend affordance immediately. Waiting for a
          // speculative reconnect makes a dead request look like a slow model
          // response and can hide failure for tens of seconds.
          // Drop the empty assistant placeholder but KEEP the user's message,
          // and surface a status-specific notice so a failed turn is never
          // silent dead air.
          dropEmptyAssistantPlaceholder(convId, assistantMsgId);
          const isAuth = status === 401 || status === 403;
          if (getSendValidationFailureMessage(err) !== null) {
            // A 4xx validation rejection (oversized/unsupported attachment,
            // malformed payload) means the server REFUSED the message before it
            // persisted: the composer was already cleared at enqueue and the
            // reconcile reload below wipes the optimistic bubble, so without a
            // restore the user's text + attachments would be irrecoverably
            // destroyed on a primary flow (e.g. a phone-photo upload). Mirror
            // the cold-open create-failure path: put the draft — text AND
            // pending attachments (the pending-images state holds the same
            // ImageAttachment shape that was sent) — back in the composer, and
            // say exactly why the server rejected it, because resending the
            // same payload unchanged would fail identically.
            const restoredToComposer = isConversationCommitActive(convId);
            if (restoredToComposer) {
              if (rawText) setChatInput(rawText);
              if (imagesToSend?.length) {
                setChatPendingImages([...imagesToSend]);
              }
            }
            const restored = restoredToComposer
              ? rawText && imagesToSend?.length
                ? "Your text and attachments were restored to the input."
                : imagesToSend?.length
                  ? "Your attachments were restored to the input."
                  : "Your message was restored to the input."
              : "Return to that conversation to edit and retry the rejected turn.";
            setActionNotice(
              `${buildSendFailureNotice(err)} ${restored}`,
              "error",
              10_000,
            );
          } else {
            setActionNotice(buildSendFailureNotice(err), "error", 8_000);
          }
          // Reconcile from the server for non-auth errors — loadConversationMessages
          // no longer wipes the thread on transient failures (404-only clear), so
          // this is safe; skip on auth where the reload would just fail again.
          if (!isAuth) {
            await loadConversationMessages(convId);
            // When the server refused the turn before persisting it (e.g. the
            // 503 warm-up gate), the reconcile just evicted the user's bubble —
            // the "KEEP the user's message" promise above becomes a lie
            // (#11670). Restore it with a retryable failed turn. Validation
            // rejects are excluded: their draft went back to the composer
            // above, so re-attaching the bubble would duplicate it.
            if (
              getSendValidationFailureMessage(err) === null &&
              activeConversationIdRef.current === convId
            ) {
              restoreEvictedUserTurn(convId, {
                userMsgId,
                assistantMsgId,
                text,
                timestamp: now,
                ...(optimisticAttachments
                  ? { attachments: optimisticAttachments }
                  : {}),
              });
            }
          }
        }
      } finally {
        // Belt-and-braces: invalidate any microtask still pending so it cannot commit a
        // stale snapshot into the next turn (idempotent — every exit path above
        // already flushed).
        flushStreamingText();
        // The turn settled (done / error / abort) — drop the live status so the
        // indicator doesn't linger on a stale phase between turns.
        setServerTurnStatusForConversation(
          convId || optimisticOwnerConversationId,
          null,
        );
        if (controller && abortServerTurn) {
          controller.signal.removeEventListener("abort", abortServerTurn);
        }
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
        }
        if (activeChatTurnRef.current?.controller === controller) {
          activeChatTurnRef.current = null;
        }
        if (convId && !unmountingRef.current) {
          clearPendingChatTurn(convId, clientMessageId);
        }
      }
    },
    [
      appendLocalCommandTurn,
      createTurnViewHandoff,
      applyStreamingModificationForConversation,
      reconcileTerminalStream,
      loadConversationMessages,
      loadConversations,
      claimConversationMessagesOwnership,
      isConversationMessagesOwnershipCurrent,
      registerConversationMessageOverlay,
      applyConversationMessageOverlayModification,
      discardConversationMessageState,
      tryHandlePrefixedChatCommand,
      activeConversationIdRef,
      chatAbortRef,
      chatInputRef,
      chatPendingImagesRef,
      conversationMessagesRef,
      conversationsRef,
      isConversationCommitActive,
      setActiveConversationId,
      setChatFirstTokenReceived,
      setChatSending,
      setServerTurnStatusForConversation,
      setChatLastUsage,
      setCompanionMessageCutoffTs,
      setConversationMessagesForConversation,
      dropEmptyAssistantPlaceholder,
      reattachInterruptedPartial,
      restoreEvictedUserTurn,
      preserveCompletedTurnAfterHistoryRefresh,
      setConversations,
      setActionNotice,
      setChatInput,
      setChatPendingImages,
      uiLanguage,
      elizaCloudEnabled,
      elizaCloudConnected,
      pollCloudCredits,
      scheduleStreamingText,
      scheduleServerTurnStatus,
      scheduleToolEvent,
      flushStreamingText,
    ],
  );

  const flushQueuedChatSends = useCallback(async () => {
    if (chatSendBusyRef.current) return;
    // Handoff in progress: hold the queue. We must NOT dispatch to the network
    // here — the live client still points at the shared agent, and anything that
    // lands on the shared history after its snapshot is lost to the skip-all
    // import. The queued turns stay put and are drained when the switch settles
    // (the freeze is cleared and this is re-invoked, now pointed at the
    // dedicated container). The composer is already cleared + `setChatSending`
    // is on, so the user sees their message accepted, not dropped.
    if (handoffFrozenRef.current) {
      setChatSending(true);
      return;
    }
    chatSendBusyRef.current = true;
    setChatSending(true);

    try {
      while (chatSendQueueRef.current.length > 0) {
        // Re-check the freeze EACH iteration: a handoff can begin (`migrating`)
        // while an earlier turn is mid-`await` here, and `sendChatText` can
        // enqueue a new turn during that await. Without this guard the loop
        // would drain that newly-queued turn to the SHARED agent after its
        // snapshot — re-opening the skip-all-import loss window the freeze
        // exists to close. `break` leaves the not-yet-shifted turns queued; the
        // terminal-phase handler re-invokes this flush after the client base is
        // repointed at the dedicated, so they land there exactly once.
        if (handoffFrozenRef.current) break;
        const nextTurn = chatSendQueueRef.current.shift();
        if (!nextTurn) break;
        try {
          await runQueuedChatSend(nextTurn);
          nextTurn.resolve();
        } catch (err) {
          nextTurn.reject(err);
        }
      }
    } finally {
      chatSendBusyRef.current = false;
      setChatSending(false);
      setChatFirstTokenReceived(false);
    }
  }, [
    chatSendBusyRef,
    runQueuedChatSend,
    setChatFirstTokenReceived,
    setChatSending,
  ]);

  // Drive the freeze off the existing shared→dedicated handoff lifecycle
  // (CLOUD_HANDOFF_PHASE_EVENT). `migrating` opens the window (stop draining to
  // the shared agent); every terminal phase closes it and drains:
  //   - `switched` / `switched-empty`: `onSwitch` has already re-pointed the
  //     client at the dedicated container (it runs INSIDE the handoff before the
  //     phase is dispatched), so the drain now delivers the queued messages to
  //     the dedicated — exactly where the copied history lives.
  //   - `timed-out` / `failed`: no switch happened, the user safely stays on the
  //     working shared agent, so unfreeze and let the queue flow to the shared
  //     agent as normal (the snapshot never landed, nothing to lose).
  // Without a handoff this listener never fires, so the queue drains inline as
  // before — no behavior change when the shared-tier flag is off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPhase = (event: Event) => {
      const detail = (event as CustomEvent<CloudHandoffPhaseDetail>).detail;
      if (!detail) return;
      if (detail.phase === "migrating") {
        handoffFrozenRef.current = true;
        return;
      }
      if (
        (detail.phase === "switched" || detail.phase === "switched-empty") &&
        markPendingCapabilityReady(detail.agentId) &&
        firstRunComplete &&
        !chatInputRef.current.trim()
      ) {
        const originalIntent = consumePendingCapabilityIntent(detail.agentId);
        if (originalIntent) {
          setChatInput(originalIntent);
          dispatchChatPrefill({ text: originalIntent, select: true });
          setActionNotice(
            "Your workspace is ready. Review your request, then send it when you want.",
            "success",
          );
        }
      }
      // Any terminal phase ends the window. Drain whatever queued up — by now
      // the client base is the dedicated container (on a switch) or unchanged
      // (on timeout/failure), so the flush targets the right agent either way.
      if (handoffFrozenRef.current) {
        handoffFrozenRef.current = false;
        void flushQueuedChatSends();
      }
    };
    window.addEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
    return () => window.removeEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
  }, [
    chatInputRef,
    firstRunComplete,
    flushQueuedChatSends,
    setActionNotice,
    setChatInput,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeConversationIdRef is a ref — its .current is read at ENQUEUE time (always latest) and must NOT be a dependency, or this callback's identity churns on every conversation switch.
  const sendChatTextInternal = useCallback(
    async (rawInput: string, options?: ChatSendTextInternalOptions) => {
      const hasAttachedImages = Boolean(options?.images?.length);
      if (!rawInput.trim() && !hasAttachedImages) {
        return;
      }

      // Direct Cloud paints the shell while its history restore continues in
      // the background. Let that restore choose the active conversation before
      // this turn snapshots the target or paints optimistically; otherwise the
      // late restore can replace the just-sent turn with stale history.
      if (
        !options?.[CHAT_SEND_HYDRATION_SETTLED] &&
        (await settleConversationHydrationForSend?.()) === false
      )
        return;

      // Claim + clear the active reply target here — the single chokepoint every
      // real user turn (composer send + overlay/voice send()) funnels through —
      // so one Reply affordance covers all surfaces and a second send never
      // re-attaches a stale reply. Skip when the caller already stamped a reply
      // (a retry replaying an earlier reply-turn's metadata). The id rides in
      // `metadata.replyToMessageId`; the API boundary lifts it onto
      // `content.inReplyTo`, which drives the REPLY_CONTEXT provider.
      const replyTarget = chatReplyTargetRef.current;
      const metadata =
        replyTarget && !asRecord(options?.metadata)?.replyToMessageId
          ? { ...options?.metadata, replyToMessageId: replyTarget.messageId }
          : options?.metadata;
      if (replyTarget) {
        chatReplyTargetRef.current = null;
        setChatReplyTarget(null);
      }

      const identityOverride = options?.[CHAT_SEND_IDENTITY_OVERRIDE];
      const clientMessageId =
        identityOverride?.clientMessageId ??
        options?.clientMessageId ??
        generateChatClientMessageId();
      const optimisticTurn =
        identityOverride?.optimisticTurn ??
        createOptimisticTurn(clientMessageId);
      const conversationId =
        options?.conversationId ?? activeConversationIdRef.current ?? null;
      const queuedTurn = {
        rawInput,
        channelType: options?.channelType ?? "DM",
        // Pin the target conversation at ENQUEUE, not at drain (#10700). The
        // shell send() path (voice converse turns + tapped suggestions) omits
        // conversationId, so without this the queued turn resolved its target
        // LATE in runQueuedChatSend as `activeConversationIdRef.current` — and
        // a new-chat between enqueue and drain rerouted it to the wrong (new)
        // conversation. Snapshot the active conversation now so the turn lands
        // where it was sent. When there is NO active conversation (cold open),
        // stay null and let the drain-time create-or-join resolve it, so a
        // rapid second cold-open turn still joins the one created conversation
        // rather than spawning its own.
        conversationId,
        images: options?.images,
        metadata: buildChatViewMetadata(tab, metadata),
        clientMessageId,
        optimisticTurn,
      } satisfies Omit<QueuedChatSend, "resolve" | "reject">;

      if (!isDrainPaintedCommand(rawInput)) {
        const optimisticUserMessage = createOptimisticUserMessage(queuedTurn);
        setCompanionMessageCutoffTs(optimisticTurn.timestamp);
        setConversationMessagesForConversation(
          conversationId,
          (prev: ConversationMessage[]) => {
            // A server-ephemeral terminal failure is useful until the user acts
            // on it. The next send is that boundary: retire only those local
            // replies before painting the new turn, while preserving durable
            // failures and user-stopped partial responses.
            const current = prev.filter(
              (message) => message.assistantEphemeral !== true,
            );
            return current.some(
              (message) => message.id === optimisticTurn.userMsgId,
            )
              ? current
              : [...current, optimisticUserMessage];
          },
        );
        registerConversationMessageOverlay(conversationId, [
          optimisticTurn.userMsgId,
        ]);
      }

      await new Promise<void>((resolve, reject) => {
        chatSendQueueRef.current.push({
          ...queuedTurn,
          resolve,
          reject,
        });
        setChatSending(true);
        void flushQueuedChatSends();
      });
    },
    [
      flushQueuedChatSends,
      settleConversationHydrationForSend,
      setChatReplyTarget,
      setChatSending,
      setCompanionMessageCutoffTs,
      setConversationMessagesForConversation,
      registerConversationMessageOverlay,
      tab,
    ],
  );

  const sendChatText = useCallback(
    (rawInput: string, options?: ChatSendTextOptions): Promise<void> =>
      sendChatTextInternal(rawInput, options),
    [sendChatTextInternal],
  );

  const handleChatSend = useCallback(
    async (
      channelType: ConversationChannelType = "DM",
      options?: {
        metadata?: Record<string, unknown>;
      },
    ) => {
      if (
        !chatInputRef.current.trim() &&
        chatPendingImagesRef.current.length === 0
      )
        return;
      // Keep the draft, attachments and reply target intact until restore has
      // established the destination. Concurrent clicks then claim the draft
      // only once, after this shared barrier settles.
      if ((await settleConversationHydrationForSend?.()) === false) return;
      const claimedInput = chatInputRef.current;
      const imagesToSend = chatPendingImagesRef.current.length
        ? [...chatPendingImagesRef.current]
        : undefined;

      if (!claimedInput.trim() && !imagesToSend?.length) {
        return;
      }

      chatInputRef.current = "";
      chatPendingImagesRef.current = [];
      setChatInput("");
      setChatPendingImages([]);
      // The composer draft for this conversation is now stale — the
      // user just sent it. Clear before the debounce window so a
      // background-app pause cannot snapshot the empty-then-restored
      // value back to storage.
      clearChatDraft(activeConversationIdRef.current);

      // The reply target (if any) is attached + cleared inside sendChatText, the
      // single chokepoint both this and the overlay's send() funnel through.
      // Enqueue immediately after claiming the draft. A second asynchronous
      // restore barrier here could reject after the draft has been cleared.
      await sendChatTextInternal(claimedInput, {
        [CHAT_SEND_HYDRATION_SETTLED]: true,
        channelType,
        conversationId: activeConversationIdRef.current,
        images: imagesToSend,
        metadata: options?.metadata,
      });
    },
    [
      activeConversationIdRef,
      chatInputRef,
      chatPendingImagesRef,
      sendChatTextInternal,
      settleConversationHydrationForSend,
      setChatInput,
      setChatPendingImages,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversations omitted to limit rerenders
  const sendActionMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const viewHandoffOwner: ChatViewHandoffOwner = {
        conversationId: null,
        generation: null,
        controller: null,
      };
      // Capture API/navigation scope before hydration can yield to user input.
      const handoffView = createTurnViewHandoff(viewHandoffOwner);
      // Actions can be fired from shell surfaces while startup hydration is
      // still choosing the initial conversation. An unavailable restore leaves
      // the action unsent instead of allocating a competing conversation.
      if ((await settleConversationHydrationForSend?.()) === false) return;
      if (chatSendBusyRef.current) return;
      chatSendBusyRef.current = true;
      const sendNonce = ++chatSendNonceRef.current;
      let controller: AbortController | null = null;
      let abortServerTurn: (() => void) | null = null;
      let convRoomId: string | null = null;

      try {
        const optimisticOwnerConversationId =
          activeConversationIdRef.current ?? activeConversationId ?? null;
        viewHandoffOwner.conversationId = optimisticOwnerConversationId;
        viewHandoffOwner.generation = claimConversationMessagesOwnership(
          optimisticOwnerConversationId,
        );
        let convId: string = optimisticOwnerConversationId ?? "";
        if (!convId) {
          try {
            const actionTitle =
              trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
            // Defer the create the same way the fixed cold-open send path does
            // (runQueuedChatSend -> createConversationForFirstSend): on a shared
            // agent base this synthesizes the canonical record locally and skips
            // the redundant cold Worker/Hyperdrive round trip. The title is only
            // forwarded to the real REST fallback (the shared server ignores it).
            const { conversation: rawConversation } =
              await createConversationForFirstSend(
                client,
                uiLanguage,
                actionTitle || t("common.newChat"),
              );
            if (!isConversationRecord(rawConversation)) {
              throw new Error(
                "Conversation creation returned an invalid payload.",
              );
            }
            const conversation = rawConversation;
            const nextCutoffTs = Date.now();
            setConversations((prev) => [conversation, ...prev]);
            if (
              activeConversationIdRef.current ===
                optimisticOwnerConversationId &&
              isConversationMessagesOwnershipCurrent(
                optimisticOwnerConversationId,
                viewHandoffOwner.generation,
              )
            ) {
              viewHandoffOwner.generation = claimConversationMessagesOwnership(
                conversation.id,
              );
              viewHandoffOwner.conversationId = conversation.id;
              setActiveConversationId(conversation.id);
              activeConversationIdRef.current = conversation.id;
              setCompanionMessageCutoffTs(nextCutoffTs);
            }
            convId = conversation.id;
            convRoomId = conversation.roomId;
          } catch {
            // error-policy:J4 surfaced user-facing failure state. An
            // action/inbox send that can't start a conversation must not
            // vanish silently (mirrors the cold-open path in
            // runQueuedChatSend).
            setActionNotice(
              "Couldn't start the conversation — check your connection and try again.",
              "error",
              8_000,
            );
            return;
          }
        }

        if (activeConversationIdRef.current === convId) {
          client.sendWsMessage({
            type: "active-conversation",
            conversationId: convId,
          });
        }

        // Eagerly rename "New Chat" using a snippet of the first message
        const activeConv = conversationsRef.current.find(
          (c) => c.id === convId,
        );
        // Do not block action/inbox sends on a list refresh solely to resolve
        // the abort side-channel room id. See the interactive send path above.
        convRoomId = resolveAbortRoomId(convId, convRoomId, activeConv?.roomId);
        if (
          activeConv &&
          (!activeConv.title ||
            activeConv.title === "New Chat" ||
            activeConv.title === "companion.newChat" ||
            activeConv.title === "conversations.newChatTitle")
        ) {
          const fallbackTitle =
            trimmed.length > 15 ? `${trimmed.slice(0, 15)}...` : trimmed;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId ? { ...c, title: fallbackTitle } : c,
            ),
          );
        }

        const now = Date.now();
        const userMsgId = `temp-action-${now}`;
        const assistantMsgId = `temp-action-resp-${now}`;

        if (activeConversationIdRef.current === convId) {
          setCompanionMessageCutoffTs(now);
        }
        const actionMessages: ConversationMessage[] = [
          {
            id: userMsgId,
            clientRenderId: userMsgId,
            role: "user",
            text: trimmed,
            timestamp: now,
          },
          {
            id: assistantMsgId,
            clientRenderId: assistantMsgId,
            role: "assistant",
            text: "",
            timestamp: now,
          },
        ];
        setConversationMessagesForConversation(
          convId,
          (prev: ConversationMessage[]) => [...prev, ...actionMessages],
        );
        registerConversationMessageOverlay(
          convId,
          [userMsgId, assistantMsgId],
          actionMessages,
        );
        if (isConversationCommitActive(convId)) {
          setChatSending(true);
          setChatFirstTokenReceived(false);
        }

        controller = new AbortController();
        viewHandoffOwner.controller = controller;
        chatAbortRef.current = controller;
        abortServerTurn = () => {
          abortServerConversationTurn(convRoomId, "ui-chat-abort");
        };
        controller.signal.addEventListener("abort", abortServerTurn, {
          once: true,
        });
        activeChatTurnRef.current = {
          controller,
          conversationId: convId,
          roomId: convRoomId,
          abortServerTurn,
        };
        let streamedAssistantText = "";

        try {
          const data = await client.sendConversationMessageStream(
            convId,
            trimmed,
            (token, accumulatedText, provisional) => {
              const nextText =
                typeof accumulatedText === "string"
                  ? accumulatedText
                  : mergeStreamingText(streamedAssistantText, token);
              if (nextText === streamedAssistantText) return;
              streamedAssistantText = nextText;
              if (isConversationCommitActive(convId)) {
                setChatFirstTokenReceived(true);
              }
              // Coalesce tokens delivered in one transport burst into a microtask;
              // flush synchronously before terminal changes.
              scheduleStreamingText(
                convId,
                assistantMsgId,
                nextText,
                provisional === true,
              );
            },
            "DM",
            controller.signal,
            undefined,
            buildChatViewMetadata(tab),
            // No overlay status on the action/DM path (its finally doesn't clear
            // it); still stream inline tool rows onto the turn (#13535),
            // coalesced into the current transport burst with the text.
            undefined,
            (event) => scheduleToolEvent(convId, assistantMsgId, event),
            undefined,
            handoffView,
          );

          // Commit any token parked by the throttle before the terminal
          // drop/complete/fail/interrupt — no streamed tokens may be lost.
          flushStreamingText();
          if (data.userMessageId) {
            applyStreamingModificationForConversation(convId, {
              messageId: userMsgId,
              mode: "rekey",
              persistedMessageId: data.userMessageId,
            });
          }
          await handoffCompletedAction(data.actionResults, handoffView);

          const interruptedPartial = reconcileTerminalStream(
            convId,
            assistantMsgId,
            streamedAssistantText,
            data,
            {
              includeReasoning: false,
              includeAccountConnect: false,
              origin: {
                optimisticUserMessageId: userMsgId,
                text: trimmed,
                sentAt: now,
              },
            },
          );

          // Keep the visible thread authoritative when the server stores
          // additional action-generated messages during a successful send.
          if (activeConversationIdRef.current === convId) {
            await loadConversationMessages(convId);
            if (interruptedPartial) {
              reattachInterruptedPartial(
                convId,
                interruptedPartial,
                data.assistantEphemeral === true,
              );
            }
            // The reload full-replaces the thread; when the server never
            // persisted this turn (agent warm-up), re-attach the user's
            // bubble instead of letting it silently vanish (#11670).
            restoreEvictedUserTurn(convId, {
              userMsgId,
              assistantMsgId,
              text: trimmed,
              timestamp: now,
            });
          }

          void loadConversations();
          if (elizaCloudEnabled || elizaCloudConnected) {
            void pollCloudCredits();
          }
        } catch (err) {
          // Commit any throttled-but-uncommitted token first so an abort/error
          // never drops a placeholder the user already saw fill with text.
          flushStreamingText();
          const abortError = err as Error;
          if (abortError.name === "AbortError" || controller?.signal.aborted) {
            dropEmptyAssistantPlaceholder(convId, assistantMsgId);
            return;
          }
          dropEmptyAssistantPlaceholder(convId, assistantMsgId);
          // Surface a status-specific notice so an inbox/connector send that
          // 5xxs, times out, or auth-fails is never silent dead air — the
          // main-chat send path already does this; this one did not (#10231).
          setActionNotice(buildSendFailureNotice(err), "error", 8_000);
          await loadConversationMessages(convId);
          // The reconcile evicts a turn the server never persisted (e.g. the
          // 503 warm-up gate) — restore it with a retryable failed turn
          // (#11670).
          if (activeConversationIdRef.current === convId) {
            restoreEvictedUserTurn(convId, {
              userMsgId,
              assistantMsgId,
              text: trimmed,
              timestamp: now,
            });
          }
        } finally {
          // Belt-and-braces: invalidate any pending scheduled flush (idempotent).
          flushStreamingText();
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
          }
          if (activeChatTurnRef.current?.controller === controller) {
            activeChatTurnRef.current = null;
          }
          if (chatSendNonceRef.current === sendNonce) {
            chatSendBusyRef.current = false;
            if (isConversationCommitActive(convId)) {
              setChatSending(false);
              setChatFirstTokenReceived(false);
            }
            if (chatSendQueueRef.current.length > 0) {
              void flushQueuedChatSends();
            }
          }
        }
      } finally {
        if (controller && abortServerTurn) {
          controller.signal.removeEventListener("abort", abortServerTurn);
        }
        if (controller == null && chatSendNonceRef.current === sendNonce) {
          chatSendBusyRef.current = false;
          if (chatSendQueueRef.current.length > 0) {
            void flushQueuedChatSends();
          }
        }
      }
    },
    [
      activeConversationId,
      createTurnViewHandoff,
      claimConversationMessagesOwnership,
      isConversationMessagesOwnershipCurrent,
      chatSendQueueRef,
      elizaCloudEnabled,
      elizaCloudConnected,
      flushQueuedChatSends,
      loadConversationMessages,
      loadConversations,
      pollCloudCredits,
      applyStreamingModificationForConversation,
      reconcileTerminalStream,
      restoreEvictedUserTurn,
      dropEmptyAssistantPlaceholder,
      reattachInterruptedPartial,
      registerConversationMessageOverlay,
      isConversationCommitActive,
      setConversationMessagesForConversation,
      setChatFirstTokenReceived,
      setChatSending,
      tab,
      uiLanguage,
      scheduleStreamingText,
      scheduleToolEvent,
      settleConversationHydrationForSend,
      flushStreamingText,
    ],
  );

  const handleChatStop = useCallback(() => {
    interruptActiveChatPipeline();

    // Also stop any active PTY sessions — the user wants everything to halt.
    // Read from the ref so this callback stays stable even as ptySessions polls.
    for (const session of ptySessionsRef.current) {
      // error-policy:J6 best-effort bulk stop on user-initiated halt; a session
      // that fails to stop keeps reporting its live status in the PTY panel.
      client.stopCodingAgent(session.sessionId).catch((err) => {
        logger.warn(
          `[useChatSend] stopCodingAgent(${session.sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // ptySessionsRef is a stable ref object — only include the ref itself, not .current
  }, [interruptActiveChatPipeline, ptySessionsRef]);

  const replyRecoveriesRef = useRef(new Set<string>());
  const handleChatRetry = useCallback(
    async (assistantMsgId: string) => {
      const currentMessages = conversationMessagesRef.current;
      // Find the failed/interrupted assistant message + its preceding user turn.
      const assistantIdx = currentMessages.findIndex(
        (m) => m.id === assistantMsgId && m.role === "assistant",
      );
      if (assistantIdx < 0) return;
      const assistantMessage = currentMessages[assistantIdx];
      const convId = activeConversationIdRef.current;
      const recoveryKey = `${convId}:${assistantMsgId}`;
      if (replyRecoveriesRef.current.has(recoveryKey)) return;
      if (assistantMessage.replyRecoveryAvailable === true) {
        if (!convId || assistantMsgId.startsWith("temp-")) return;
        replyRecoveriesRef.current.add(recoveryKey);
        try {
          const reply = await client.retryConversationReply(
            convId,
            assistantMsgId,
          );
          if (reply.messageId !== assistantMsgId) {
            throw new Error("Reply recovery returned a different message");
          }
          applyStreamingModificationForConversation(convId, {
            messageId: assistantMsgId,
            mode: "complete",
            fullText: reply.text,
          });
        } catch (err) {
          // error-policy:J4 keep the durable failure and recovery control when
          // the reply service is unavailable; never resend its original action.
          setActionNotice(
            `Could not regenerate reply: ${err instanceof Error ? err.message : "network error"}`,
            "error",
            4200,
          );
        } finally {
          replyRecoveriesRef.current.delete(recoveryKey);
        }
        return;
      }
      // A stale caller cannot turn a permanent presentation failure into an
      // action replay when durable reply recovery was not advertised.
      if (assistantMessage.terminalFailure?.transient === false) return;
      if (!assistantMessage.failureKind && !assistantMessage.interrupted)
        return;
      let userIdx = -1;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        if (currentMessages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const userMsg = currentMessages[userIdx];
      const retryText = userMsg.text;
      if (!retryText) return;

      const canTruncate =
        Boolean(convId) &&
        userMsg.source !== "local_command" &&
        !userMsg.id.startsWith("temp-");

      // Preferred path: re-run the turn IN PLACE. Truncate from the user message
      // (inclusive) so [Q, fail] is removed server-side, then resend Q — exactly
      // like handleChatEdit. The old behaviour only dropped the assistant bubble
      // in memory and resent, producing a duplicate [Q, fail, Q-dup, new] turn.
      if (canTruncate && convId) {
        interruptActiveChatPipeline();
        const removedTail = currentMessages.slice(userIdx);
        const preservedMessages = currentMessages.slice(0, userIdx);
        conversationMessagesRef.current = preservedMessages;
        setConversationMessages(preservedMessages);
        try {
          await client.truncateConversationMessages(convId, userMsg.id, {
            inclusive: true,
          });
          removeConversationMessageStateMessages?.(convId, {
            mode: "truncate",
            removedMessages: removedTail,
            preservedMessages,
          });
          await sendChatText(retryText, { conversationId: convId });
        } catch (err) {
          await loadConversationMessages(convId);
          setActionNotice(
            `Failed to retry message: ${err instanceof Error ? err.message : "network error"}`,
            "error",
            4200,
          );
        }
        return;
      }

      // Fallback (no persisted user id yet): replace only this local pair and
      // reuse its logical idempotency/render identity. A request can reach the
      // server while its terminal response is lost; minting a new identity on
      // Retry could then duplicate the accepted turn.
      const optimisticUserId = userMsg.clientRenderId ?? userMsg.id;
      const clientMessageId = optimisticUserId.startsWith("temp-")
        ? optimisticUserId.slice("temp-".length)
        : "";
      setConversationMessages((prev) =>
        prev.filter(
          (m) =>
            m.id !== assistantMsgId &&
            !(m.id === userMsg.id && m.id.startsWith("temp-")),
        ),
      );
      void sendChatTextInternal(retryText, {
        ...(clientMessageId
          ? {
              [CHAT_SEND_IDENTITY_OVERRIDE]: {
                clientMessageId,
                optimisticTurn: {
                  userMsgId: optimisticUserId,
                  assistantMsgId: `temp-resp-${clientMessageId}`,
                  timestamp: userMsg.timestamp,
                },
              },
            }
          : {}),
      });
    },
    [
      sendChatText,
      sendChatTextInternal,
      applyStreamingModificationForConversation,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
      interruptActiveChatPipeline,
      loadConversationMessages,
      removeConversationMessageStateMessages,
      setActionNotice,
    ],
  );

  const handleChatEdit = useCallback(
    async (messageId: string, text: string): Promise<boolean> => {
      const convId = activeConversationIdRef.current;
      const nextText = text.trim();
      if (!convId || !nextText) {
        return false;
      }

      let currentMessages = conversationMessagesRef.current;
      let messageIndex = currentMessages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      );
      if (messageIndex < 0) {
        const loaded = await loadConversationMessages(convId);
        if (!loaded.ok) {
          return false;
        }
        currentMessages = conversationMessagesRef.current;
        messageIndex = currentMessages.findIndex(
          (message) => message.id === messageId && message.role === "user",
        );
      }
      if (messageIndex < 0) {
        return false;
      }

      const targetMessage = currentMessages[messageIndex];
      if (
        targetMessage.source === "local_command" ||
        targetMessage.id.startsWith("temp-")
      ) {
        return false;
      }

      const restoredQueuedDraft = interruptActiveChatPipelineWithDraft();
      if (!restoredQueuedDraft.text) {
        setChatInput("");
      }

      const removedTail = currentMessages.slice(messageIndex);
      const preservedMessages = currentMessages.slice(0, messageIndex);
      conversationMessagesRef.current = preservedMessages;
      setConversationMessages(preservedMessages);

      try {
        await client.truncateConversationMessages(convId, messageId, {
          inclusive: true,
        });
        removeConversationMessageStateMessages?.(convId, {
          mode: "truncate",
          removedMessages: removedTail,
          preservedMessages,
        });
        await sendChatText(nextText, { conversationId: convId });
        return true;
      } catch (err) {
        await loadConversationMessages(convId);
        setActionNotice(
          `Failed to edit message: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return false;
      }
    },
    [
      loadConversationMessages,
      removeConversationMessageStateMessages,
      sendChatText,
      setActionNotice,
      activeConversationIdRef.current,
      conversationMessagesRef,
      interruptActiveChatPipelineWithDraft,
      setChatInput,
      setConversationMessages,
    ],
  );

  // Persistently delete a single message (#13533). Optimistically removes the
  // bubble, fires the server DELETE, and re-hydrates from the store on failure
  // so a network/authz error never leaves a locally-hidden-but-still-persisted
  // message. Distinct from the local-only `removeConversationMessage`
  // suggestion dismissal (#8792), which is intentionally server-free.
  const handleChatDelete = useCallback(
    async (messageId: string): Promise<boolean> => {
      const convId = activeConversationIdRef.current;
      if (!convId) return false;

      const currentMessages = conversationMessagesRef.current;
      const target = currentMessages.find((m) => m.id === messageId);
      // An optimistic (temp-) or local command turn has no persisted memory row
      // to delete; drop it locally so the UI stays consistent.
      if (
        !target ||
        target.id.startsWith("temp-") ||
        target.source === "local_command"
      ) {
        const nextMessages = currentMessages.filter((m) => m.id !== messageId);
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return true;
      }

      // Optimistic removal, remembering the prior list for rollback.
      const preserved = currentMessages;
      const nextMessages = currentMessages.filter((m) => m.id !== messageId);
      conversationMessagesRef.current = nextMessages;
      setConversationMessages(nextMessages);

      try {
        await client.deleteConversationMessage(convId, messageId);
        removeConversationMessageStateMessages?.(convId, {
          mode: "delete-exact",
          removedMessages: [target],
        });
        return true;
      } catch (err) {
        // Roll back so the message stays visible — never a silent local-only
        // removal on failure. Only touch state if we're still viewing the
        // conversation we deleted from: a switch mid-delete swapped the ref +
        // setter to another conversation, and restoring this one's snapshot
        // there would leak state across conversations (same guard every send
        // path uses). Reconcile against the CURRENT list — re-add the pre-delete
        // messages while keeping anything that streamed in during the request —
        // rather than overwriting with the stale snapshot, so a reply that
        // arrived mid-delete is not clobbered.
        if (activeConversationIdRef.current === convId) {
          const live = conversationMessagesRef.current;
          const preservedIds = new Set(preserved.map((m) => m.id));
          const restored = [
            ...preserved,
            ...live.filter((m) => !preservedIds.has(m.id)),
          ];
          conversationMessagesRef.current = restored;
          setConversationMessages(restored);
        }
        setActionNotice(
          `Failed to delete message: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return false;
      }
    },
    [
      activeConversationIdRef,
      conversationMessagesRef,
      removeConversationMessageStateMessages,
      setConversationMessages,
      setActionNotice,
    ],
  );

  const handleChatClear = useCallback(async () => {
    const convId = activeConversationIdRef.current ?? activeConversationId;
    if (!convId) {
      setActionNotice("No active conversation to clear.", "info", 2200);
      return;
    }
    interruptActiveChatPipeline();
    const removeClearedConversationLocally = () => {
      const clearingCurrentActive = activeConversationIdRef.current === convId;
      if (clearingCurrentActive) {
        conversationHydrationEpochRef.current += 1;
        claimConversationMessagesOwnership(null);
      }
      discardConversationMessageState(convId);
      if (clearingCurrentActive) {
        setActiveConversationId(null);
        activeConversationIdRef.current = null;
        conversationMessagesRef.current = [];
        setConversationMessages([]);
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: null,
        });
      }
      setUnreadConversations((prev) => {
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
    };
    try {
      await client.deleteConversation(convId);
      removeClearedConversationLocally();
      await loadConversations();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        removeClearedConversationLocally();
        await loadConversations();
        setActionNotice("Conversation was already cleared.", "info", 2600);
        return;
      }
      setActionNotice(
        `Failed to clear conversation: ${err instanceof Error ? err.message : "network error"}`,
        "error",
        4200,
      );
    }
  }, [
    activeConversationId,
    activeConversationIdRef,
    claimConversationMessagesOwnership,
    conversationHydrationEpochRef,
    conversationMessagesRef,
    discardConversationMessageState,
    interruptActiveChatPipeline,
    loadConversations,
    setActionNotice,
    setActiveConversationId,
    setConversationMessages,
    setUnreadConversations,
  ]);

  useEffect(() => {
    if (!firstRunComplete || chatInput.trim()) return;
    const readyAgentId = readPendingCapabilityReadyAgentId();
    if (!readyAgentId) return;
    const originalIntent = consumePendingCapabilityIntent(readyAgentId);
    if (!originalIntent) return;
    setChatInput(originalIntent);
    dispatchChatPrefill({ text: originalIntent, select: true });
    setActionNotice(
      "Your workspace is ready. Review your request, then send it when you want.",
      "success",
    );
  }, [chatInput, firstRunComplete, setActionNotice, setChatInput]);

  return {
    chatSendQueueRef,
    interruptActiveChatPipeline,
    interruptActiveChatPipelineWithDraft,
    appendLocalCommandTurn,
    tryHandlePrefixedChatCommand,
    sendChatText,
    handleChatSend,
    sendActionMessage,
    handleChatStop,
    handleChatRetry,
    handleChatEdit,
    handleChatDelete,
    handleChatClear,
  };
}
