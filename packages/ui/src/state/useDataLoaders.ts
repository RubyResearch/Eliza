/**
 * Data-loading callbacks, one of the domain hooks AppContext composes.
 *
 * Covers: autonomy event merge / replay / append, conversation loaders,
 * BSC trade + steward wrappers, loadInventory, ownerName hydration,
 * character language sync, loadWorkbench, loadUpdateStatus,
 * checkExtensionStatus.
 */

import { logger } from "@elizaos/logger";
import {
  resolveStylePresetByAvatarIndex,
  resolveStylePresetByName,
} from "@elizaos/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentStatus,
  type BscTradeExecuteRequest,
  type BscTradeExecuteResponse,
  type BscTradePreflightResponse,
  type BscTradeQuoteRequest,
  type BscTradeQuoteResponse,
  type BscTradeTxStatusResponse,
  type BscTransferExecuteRequest,
  type BscTransferExecuteResponse,
  type CharacterData,
  type Conversation,
  type ConversationMessage,
  client,
  type ExtensionStatus,
  type StewardWebhookEventType,
  type StreamEventEnvelope,
  type StylePreset,
  type UpdateStatus,
  type WalletTradingProfileResponse,
  type WalletTradingProfileSourceFilter,
  type WalletTradingProfileWindow,
  type WorkbenchOverview,
} from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { restoreCapabilityHandoffs } from "../capability-handoff";
import { useIsAuthenticated } from "../hooks/useAuthStatus";
import type { UiLanguage } from "../i18n";
import { normalizeOwnerName } from "../utils/owner-name";
import {
  type AutonomyRunHealthMap,
  buildAutonomyGapReplayRequests,
  hasPendingAutonomyGaps,
  markPendingAutonomyGapsPartial,
  mergeAutonomyEvents,
} from "./autonomy";
import { normalizeConversationList } from "./chat-conversation-guards";
import { markConversationHistoryApplied } from "./conversation-hydration-readiness";
import {
  applyStreamingTextModification,
  filterRenderableConversationMessages,
  type LoadConversationMessagesResult,
  type StreamingTextModification,
  shouldKeepConversationMessage,
} from "./internal";
import { clearSettledPendingChatTurns } from "./pending-chat-turns";
import { subscribeRuntimeAuthoritySwitch } from "./switch-runtime";

// ── Helpers (module-level, no React deps) ────────────────────────────

function hasConversationBootstrapMessage(
  messages: ConversationMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" && shouldKeepConversationMessage(message),
  );
}

function localConversationMessageLineage(
  message: ConversationMessage,
): string | null {
  if (message.clientRenderId?.startsWith("temp-")) {
    return message.clientRenderId;
  }
  return message.id.startsWith("temp-") ? message.id : null;
}

interface ConversationMessageOverlayRecord {
  /** Latest visible form of this explicitly registered local lineage. */
  message: ConversationMessage | null;
  /** Bumped whenever the visible row is added, rekeyed, or otherwise replaced. */
  revision: number;
  /** Consecutive newest-history snapshots that omitted this unchanged row. */
  consecutiveNewestMisses: number;
  /** Distinguishes a registered-before-paint lineage from an explicitly removed row. */
  hasBeenVisible: boolean;
  /** Only a terminally rekeyed durable row may retire on absence evidence. */
  terminalDurable: boolean;
  /** Durable user rows known before this send, not rows first seen on reconnect. */
  precedingServerUserIds?: Set<string>;
  /** Earlier queued users may acquire their durable ids after this registration. */
  precedingUserRecords?: readonly ConversationMessageOverlayRecord[];
  /** Survives retirement/re-homing while a queued successor still references us. */
  resolvedServerUserId?: string;
}

type ConversationMessageOverlay = Map<string, ConversationMessageOverlayRecord>;

export type ConversationMessageStateMutation =
  | {
      mode: "delete-exact";
      removedMessages: readonly ConversationMessage[];
    }
  | {
      mode: "truncate";
      removedMessages: readonly ConversationMessage[];
      /** Exact visible prefix captured before the server-side truncate. */
      preservedMessages: readonly ConversationMessage[];
    };

interface ConversationMessageLoadFence {
  conversationId: string;
  controller: AbortController;
  ownerGeneration: number;
  visibleRequestGeneration: number;
  requestKind: "newest" | "around";
  /** Only overlay revisions that existed before this GET may be retired by it. */
  overlayRevisionsAtStart: Map<string, number>;
}

function indexConversationMessagesByLineage(
  messages: readonly ConversationMessage[],
): Map<string, ConversationMessage> {
  const indexed = new Map<string, ConversationMessage>();
  for (const message of messages) {
    const lineage = localConversationMessageLineage(message);
    if (lineage) indexed.set(lineage, message);
  }
  return indexed;
}

function captureRegisteredConversationMessageOverlay(
  overlay: ConversationMessageOverlay,
  currentMessages: readonly ConversationMessage[],
): void {
  const currentByLineage = indexConversationMessagesByLineage(currentMessages);
  for (const [lineage, record] of overlay) {
    const message = currentByLineage.get(lineage) ?? null;
    if (!message) {
      // A row that was once visible and is now absent was explicitly removed
      // (stop/failure/retry). Do not let a stale overlay resurrect it later.
      if (record.hasBeenVisible) overlay.delete(lineage);
      continue;
    }
    if (record.message !== message) {
      record.message = message;
      record.revision += 1;
      record.consecutiveNewestMisses = 0;
    }
    record.hasBeenVisible = true;
    if (!message.id.startsWith("temp-")) {
      record.terminalDurable = true;
      rememberResolvedOverlayUser(record, message);
    }
  }
}

function rememberResolvedOverlayUser(
  record: ConversationMessageOverlayRecord,
  message: ConversationMessage,
): void {
  if (message.role !== "user" || message.id.startsWith("temp-")) return;
  record.resolvedServerUserId = message.id;
  // Once this user has a durable id, it no longer needs weak-match ancestry.
  // Release the chain while successors retain this small identity record.
  record.precedingUserRecords = undefined;
}

function overlayMessages(
  overlay: ConversationMessageOverlay | undefined,
): ConversationMessage[] {
  if (!overlay) return [];
  return [...overlay.values()]
    .map((record) => record.message)
    .filter((message): message is ConversationMessage => message !== null);
}

function snapshotOverlayRevisions(
  overlay: ConversationMessageOverlay | undefined,
): Map<string, number> {
  return new Map(
    overlay
      ? [...overlay].map(([lineage, record]) => [lineage, record.revision])
      : [],
  );
}

const LOCAL_TURN_MATCH_SLACK_MS = 60_000;

function findMatchingServerMessageIndex(
  serverMessages: ConversationMessage[],
  localMessage: ConversationMessage,
  usedIndexes: Set<number>,
  options?: { afterIndex?: number },
): number {
  const text = localMessage.text.trim();
  if (!text) return -1;
  const minTimestamp = localMessage.timestamp - LOCAL_TURN_MATCH_SLACK_MS;
  const maxTimestamp = localMessage.timestamp + LOCAL_TURN_MATCH_SLACK_MS;
  const startIndex =
    typeof options?.afterIndex === "number" ? options.afterIndex + 1 : 0;
  let bestIndex = -1;
  let bestTimestampDelta = Number.POSITIVE_INFINITY;
  for (let index = startIndex; index < serverMessages.length; index += 1) {
    if (usedIndexes.has(index)) continue;
    const serverMessage = serverMessages[index];
    if (!serverMessage || serverMessage.role !== localMessage.role) continue;
    if (serverMessage.timestamp < minTimestamp) continue;
    if (serverMessage.timestamp > maxTimestamp) continue;
    if (serverMessage.text.trim() !== text) continue;
    const timestampDelta = Math.abs(
      serverMessage.timestamp - localMessage.timestamp,
    );
    if (timestampDelta < bestTimestampDelta) {
      bestIndex = index;
      bestTimestampDelta = timestampDelta;
    }
  }
  return bestIndex;
}

function isLocalOverlayMessage(
  message: ConversationMessage,
  overlayLineages: ReadonlySet<string>,
): boolean {
  const lineage = localConversationMessageLineage(message);
  return lineage !== null && overlayLineages.has(lineage);
}

function findNearestPriorLocalOverlayUser(
  messages: ConversationMessage[],
  fromIndex: number,
  overlayLineages: ReadonlySet<string>,
): ConversationMessage | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (
      message.role === "user" &&
      isLocalOverlayMessage(message, overlayLineages)
    ) {
      return message;
    }
    if (message.role === "user") return null;
  }
  return null;
}

function findNearestPriorUser(
  messages: ConversationMessage[],
  fromIndex: number,
): ConversationMessage | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

function resolvedLocalOverlayServerIndexes(
  serverMessages: ConversationMessage[],
  currentMessages: ConversationMessage[],
  overlay: ConversationMessageOverlay,
): Map<string, number> {
  const overlayLineages = new Set(overlay.keys());
  const resolvedServerIndexes = new Map<string, number>();
  const serverIndexById = new Map<string, number>();
  serverMessages.forEach((message, index) => {
    serverIndexById.set(message.id, index);
  });
  const currentServerUserIndexes = new Set<number>();
  const usedServerUserIndexes = new Set<number>();
  const usedServerAssistantIndexes = new Set<number>();
  currentMessages.forEach((message) => {
    if (isLocalOverlayMessage(message, overlayLineages)) return;
    const serverIndex = serverIndexById.get(message.id);
    if (typeof serverIndex !== "number") return;
    if (message.role === "user") {
      currentServerUserIndexes.add(serverIndex);
    } else if (message.role === "assistant") {
      usedServerAssistantIndexes.add(serverIndex);
    }
  });
  const serverUserIndexByLocalId = new Map<string, number>();

  currentMessages.forEach((message) => {
    if (
      message.role !== "user" ||
      !isLocalOverlayMessage(message, overlayLineages)
    ) {
      return;
    }
    const exactServerIndex = serverIndexById.get(message.id);
    if (typeof exactServerIndex === "number") {
      usedServerUserIndexes.add(exactServerIndex);
      serverUserIndexByLocalId.set(message.id, exactServerIndex);
      return;
    }
    const lineage = localConversationMessageLineage(message);
    const record = lineage ? overlay.get(lineage) : undefined;
    const precedingIds = record?.precedingServerUserIds;
    const excludedIndexes = new Set(usedServerUserIndexes);
    if (precedingIds) {
      for (const id of precedingIds) {
        const index = serverIndexById.get(id);
        if (index !== undefined) excludedIndexes.add(index);
      }
      for (const predecessor of record?.precedingUserRecords ?? []) {
        const index = predecessor.resolvedServerUserId
          ? serverIndexById.get(predecessor.resolvedServerUserId)
          : undefined;
        if (index !== undefined) excludedIndexes.add(index);
      }
    } else {
      // Without a pre-send canonical window, retain the conservative current-
      // window guard. Never infer that an unseen older repeat belongs to us.
      for (const index of currentServerUserIndexes) excludedIndexes.add(index);
    }
    const serverIndex = findMatchingServerMessageIndex(
      serverMessages,
      message,
      excludedIndexes,
    );
    if (serverIndex < 0) return;
    usedServerUserIndexes.add(serverIndex);
    serverUserIndexByLocalId.set(message.id, serverIndex);
    resolvedServerIndexes.set(message.id, serverIndex);
  });

  currentMessages.forEach((message, index) => {
    if (
      message.role !== "assistant" ||
      !isLocalOverlayMessage(message, overlayLineages)
    ) {
      return;
    }
    const exactServerIndex = serverIndexById.get(message.id);
    if (typeof exactServerIndex === "number") {
      usedServerAssistantIndexes.add(exactServerIndex);
      return;
    }
    const pairedUser = findNearestPriorLocalOverlayUser(
      currentMessages,
      index,
      overlayLineages,
    );
    const matchedUserIndex = pairedUser
      ? serverUserIndexByLocalId.get(pairedUser.id)
      : undefined;
    const serverIndex = findMatchingServerMessageIndex(
      serverMessages,
      message,
      usedServerAssistantIndexes,
      typeof matchedUserIndex === "number"
        ? { afterIndex: matchedUserIndex }
        : undefined,
    );
    if (serverIndex < 0) return;
    usedServerAssistantIndexes.add(serverIndex);
    resolvedServerIndexes.set(message.id, serverIndex);
  });

  return resolvedServerIndexes;
}

// A single newest-history response can still trail a terminal direct reply.
// Keep an unchanged overlay through two consecutive omissions; the third
// independent snapshot is the bounded confirmation that the row was removed.
const OVERLAY_NEWEST_MISS_RETIREMENT_COUNT = 3;

function mergeMessagesChronologically(
  serverMessages: ConversationMessage[],
  localOverlay: ConversationMessage[],
  causalServerPredecessors?: ReadonlyMap<string, number>,
): ConversationMessage[] {
  if (localOverlay.length === 0) return serverMessages;
  const merged: Array<{
    message: ConversationMessage;
    serverIndex: number | null;
  }> = serverMessages.map((message, serverIndex) => ({ message, serverIndex }));
  const orderedOverlay = [...localOverlay].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  for (const message of orderedOverlay) {
    let insertionIndex = merged.findIndex(
      (candidate) => candidate.message.timestamp > message.timestamp,
    );
    if (insertionIndex < 0) insertionIndex = merged.length;

    // A terminal receipt is stronger ordering evidence than client/server
    // clocks. An ephemeral reply must never precede its recorded request.
    const replyToPosition =
      message.role === "assistant" && message.replyToMessageId
        ? merged.findIndex(
            (candidate) =>
              candidate.message.role === "user" &&
              candidate.message.id === message.replyToMessageId,
          )
        : -1;
    if (replyToPosition >= 0) {
      insertionIndex = Math.max(insertionIndex, replyToPosition + 1);
    }
    const lineage = localConversationMessageLineage(message);
    const predecessorServerIndex =
      lineage && !message.replyToMessageId
        ? causalServerPredecessors?.get(lineage)
        : undefined;
    if (typeof predecessorServerIndex === "number") {
      const predecessorPosition = merged.findIndex(
        (candidate) => candidate.serverIndex === predecessorServerIndex,
      );
      if (predecessorPosition >= 0) {
        insertionIndex = Math.max(insertionIndex, predecessorPosition + 1);
      }
    }
    merged.splice(insertionIndex, 0, { message, serverIndex: null });
  }
  return merged.map((entry) => entry.message);
}

function reconcileConversationMessagesWithOverlay(
  serverMessages: ConversationMessage[],
  overlay: ConversationMessageOverlay | undefined,
  options?: {
    localContext?: ConversationMessage[];
    /**
     * Text/time matching is safe only when localContext still contains the
     * preceding canonical newest window. Around/overlay-only paints can omit an
     * older repeated row and must fall back to exact durable ids only.
     */
    allowTextFallback?: boolean;
    /** Present only for a full newest-history GET, never cache/around windows. */
    overlayRevisionsAtRequestStart?: ReadonlyMap<string, number>;
  },
): ConversationMessage[] {
  if (!overlay || overlay.size === 0) return serverMessages;
  const serverIndexById = new Map(
    serverMessages.map((message, index) => [message.id, index]),
  );
  // A cache/around paint settles by exact id only. A canonical network response
  // may also match registered local turns, excluding rows known before each
  // send rather than newly fetched copies of those same pending turns.
  const resolvedOverlayServerIndexes =
    options?.localContext && options.allowTextFallback
      ? resolvedLocalOverlayServerIndexes(
          serverMessages,
          options.localContext,
          overlay,
        )
      : new Map<string, number>();
  const causalServerPredecessors = new Map<string, number>();
  const localContext = options?.localContext;
  if (localContext) {
    localContext.forEach((message, index) => {
      if (message.role !== "assistant") return;
      const lineage = localConversationMessageLineage(message);
      if (!lineage || !overlay.has(lineage)) return;
      const precedingUser = findNearestPriorUser(localContext, index);
      if (!precedingUser) return;
      const predecessorServerIndex =
        serverIndexById.get(precedingUser.id) ??
        resolvedOverlayServerIndexes.get(precedingUser.id);
      if (typeof predecessorServerIndex === "number") {
        causalServerPredecessors.set(lineage, predecessorServerIndex);
      }
    });
  }

  const fullNewestRequestRevisions = options?.overlayRevisionsAtRequestStart;
  const matchedLineages = new Set<string>();
  let visibleServerMessages = serverMessages;
  const preserveOwnedMessage = (
    serverIndex: number,
    lineage: string,
    ownedMessage: ConversationMessage,
  ) => {
    const serverMessage = visibleServerMessages[serverIndex];
    if (!serverMessage) return;
    if (visibleServerMessages === serverMessages) {
      visibleServerMessages = [...serverMessages];
    }
    // A cache/around match is only duplicate-suppression evidence, never proof
    // that its snapshot is newer than the exact registered local revision. The
    // same is true for a newest response whose fence predates a rekey/update.
    // Keep the owned row itself so the following capture cannot downgrade the
    // overlay to stale server text or metadata.
    visibleServerMessages[serverIndex] =
      ownedMessage.clientRenderId === lineage
        ? ownedMessage
        : { ...ownedMessage, clientRenderId: lineage };
  };
  for (const [lineage, record] of overlay) {
    const message = record.message;
    if (!message) continue;
    const revisionAtRequestStart = fullNewestRequestRevisions?.get(lineage);
    const newestRequestCanConsumeRevision =
      fullNewestRequestRevisions !== undefined &&
      revisionAtRequestStart !== undefined &&
      revisionAtRequestStart === record.revision;
    const exactServerIndex = serverIndexById.get(message.id);
    if (typeof exactServerIndex === "number") {
      matchedLineages.add(lineage);
      // Cache paints and around-windows may hide a duplicate by exact id, but
      // only a canonical newest-history endpoint that followed this exact
      // overlay revision may retire overlay state.
      if (newestRequestCanConsumeRevision) {
        rememberResolvedOverlayUser(record, serverMessages[exactServerIndex]);
        overlay.delete(lineage);
      } else {
        preserveOwnedMessage(exactServerIndex, lineage, message);
      }
      continue;
    }

    const fallbackServerIndex = resolvedOverlayServerIndexes.get(message.id);
    if (typeof fallbackServerIndex === "number") {
      // Text/time matching is weaker than exact durable-id evidence. A newest
      // response may consume it only when this exact overlay revision existed
      // before the request; around/cache reconciliation merely links the server
      // row back to the still-owned lineage.
      if (
        fullNewestRequestRevisions !== undefined &&
        !newestRequestCanConsumeRevision
      ) {
        matchedLineages.add(lineage);
        preserveOwnedMessage(fallbackServerIndex, lineage, message);
        continue;
      }
      matchedLineages.add(lineage);
      if (newestRequestCanConsumeRevision) {
        rememberResolvedOverlayUser(
          record,
          serverMessages[fallbackServerIndex],
        );
        overlay.delete(lineage);
      } else {
        preserveOwnedMessage(fallbackServerIndex, lineage, message);
      }
      continue;
    }

    if (
      !record.terminalDurable ||
      revisionAtRequestStart === undefined ||
      revisionAtRequestStart !== record.revision
    ) {
      continue;
    }

    // Client timestamps are not comparable with the server window and retries
    // deliberately retain the original turn timestamp. Only repeated newest
    // responses that began after this exact revision may retire it.
    record.consecutiveNewestMisses += 1;
    if (
      record.consecutiveNewestMisses >= OVERLAY_NEWEST_MISS_RETIREMENT_COUNT
    ) {
      overlay.delete(lineage);
    }
  }

  return mergeMessagesChronologically(
    visibleServerMessages,
    overlayMessages(overlay).filter((message) => {
      const lineage = localConversationMessageLineage(message);
      return lineage === null || !matchedLineages.has(lineage);
    }),
    causalServerPredecessors,
  );
}

function buildLocalizedCharacterPayload(
  preset: StylePreset,
  name?: string | null,
): CharacterData {
  const resolvedName = name?.trim() || preset.name;
  return {
    name: resolvedName,
    bio: [...preset.bio],
    system: preset.system,
    adjectives: [...preset.adjectives],
    topics: [...preset.topics],
    style: {
      all: [...preset.style.all],
      chat: [...preset.style.chat],
      post: [...preset.style.post],
    },
    messageExamples: preset.messageExamples.map((conversation) => ({
      examples: conversation.map((message) => ({
        name: message.user,
        content: { text: message.content.text },
      })),
    })),
    postExamples: [...preset.postExamples],
  };
}

// ── Hook deps ─────────────────────────────────────────────────────────────

// Upper bound on the in-memory conversation-message prefetch cache. Holds the
// active conversation plus several neighbors in each swipe direction; oldest
// entries are evicted first.
const CONVERSATION_MESSAGE_CACHE_MAX = 16;

export interface DataLoadersDeps {
  // Autonomy refs + setters (from useChatState)
  autonomousStoreRef: RefObject<
    ReturnType<typeof mergeAutonomyEvents>["store"]
  >;
  autonomousEventsRef: RefObject<StreamEventEnvelope[]>;
  autonomousLatestEventIdRef: RefObject<string | null>;
  autonomousRunHealthByRunIdRef: RefObject<AutonomyRunHealthMap>;
  autonomousReplayInFlightRef: RefObject<boolean>;
  setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
  setAutonomousLatestEventId: (v: string | null) => void;
  setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;

  // Conversation refs + setters (from useChatState)
  activeConversationIdRef: RefObject<string | null>;
  conversationMessagesRef: RefObject<ConversationMessage[]>;
  greetingFiredRef: RefObject<boolean>;
  setConversations: (v: Conversation[]) => void;
  setActiveConversationId: (v: string | null) => void;
  setConversationMessages: (v: ConversationMessage[]) => void;

  // Wallet
  loadWalletConfig: () => Promise<void>;

  // Character
  agentStatus: AgentStatus | null;
  characterData: CharacterData | null;
  characterDraft: CharacterData | null;
  loadCharacter: () => Promise<void>;
  selectedVrmIndex: number;
  firstRunComplete: boolean;
  uiLanguage: UiLanguage;

  // Owner name
  setOwnerNameState: (v: string | null) => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useDataLoaders(deps: DataLoadersDeps) {
  const {
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig,
    agentStatus,
    characterData,
    characterDraft,
    loadCharacter,
    selectedVrmIndex,
    firstRunComplete,
    uiLanguage,
    setOwnerNameState,
  } = deps;

  // Auth gate (#11084): AppProvider mounts these loaders before the auth probe
  // resolves, so the shell one-shot fetches must stay dormant until the
  // session is authenticated — an unauthenticated shell makes none of them.
  const authenticated = useIsAuthenticated();

  // ── Autonomy ────────────────────────────────────────────────────────

  const applyAutonomyEventMerge = useCallback(
    (incomingEvents: StreamEventEnvelope[], replay = false) => {
      const merged = mergeAutonomyEvents({
        store: autonomousStoreRef.current,
        incomingEvents,
        runHealthByRunId: autonomousRunHealthByRunIdRef.current,
        replay,
      });
      autonomousStoreRef.current = merged.store;
      autonomousEventsRef.current = merged.events;
      autonomousLatestEventIdRef.current = merged.latestEventId;
      autonomousRunHealthByRunIdRef.current = merged.runHealthByRunId;

      setAutonomousEvents(merged.events);
      setAutonomousLatestEventId(merged.latestEventId);
      setAutonomousRunHealthByRunId(merged.runHealthByRunId);

      return merged;
    },
    [
      autonomousEventsRef,
      autonomousLatestEventIdRef,
      autonomousRunHealthByRunIdRef,
      autonomousStoreRef,
      setAutonomousEvents,
      setAutonomousLatestEventId,
      setAutonomousRunHealthByRunId,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: autonomousStoreRef is a ref — its .current is read at call-time (always latest) and must NOT be a dependency, or this callback's identity churns on every autonomy merge and cascades into useStartupCoordinator's deps.
  const fetchAutonomyReplay = useCallback(async () => {
    if (autonomousReplayInFlightRef.current) return;
    autonomousReplayInFlightRef.current = true;
    try {
      const afterEventId = autonomousStoreRef.current.watermark ?? undefined;
      const replay = await client.getAgentEvents({
        afterEventId,
        limit: 300,
      });

      if (replay.events.length > 0) {
        applyAutonomyEventMerge(replay.events);
      }

      const gapReplays = buildAutonomyGapReplayRequests(
        autonomousRunHealthByRunIdRef.current,
        autonomousStoreRef.current,
      ).slice(0, 4);

      // All gap requests are independent — run them in parallel to collapse the
      // serial round-trips into a single wall-clock wait. allSettled so one
      // failed gap replay doesn't discard the others' results.
      const gapResults = await Promise.allSettled(
        gapReplays.map((request) =>
          client.getAgentEvents({
            runId: request.runId,
            fromSeq: request.fromSeq,
            limit: 300,
          }),
        ),
      );
      for (const result of gapResults) {
        if (result.status === "rejected") {
          logger.debug(
            { error: result.reason },
            "[useDataLoaders] autonomy gap replay failed; retried on next poll cycle",
          );
          continue;
        }
        if (result.value.events.length > 0) {
          applyAutonomyEventMerge(result.value.events);
        }
      }

      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
    } catch {
      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
      // best-effort; caller can retry on next poll cycle
    } finally {
      autonomousReplayInFlightRef.current = false;
    }
    // autonomousStoreRef.current is read at call-time inside the body — a ref
    // read is always latest, so it must NOT be a dep (it would churn this
    // callback's identity, cascading into useStartupCoordinator's deps).
  }, [
    applyAutonomyEventMerge,
    autonomousReplayInFlightRef,
    autonomousRunHealthByRunIdRef,
    setAutonomousRunHealthByRunId,
  ]);

  const appendAutonomousEvent = useCallback(
    (event: StreamEventEnvelope) => {
      const merged = applyAutonomyEventMerge([event]);
      if (merged.runsWithNewGaps.length > 0) {
        void fetchAutonomyReplay();
      }
    },
    [applyAutonomyEventMerge, fetchAutonomyReplay],
  );

  // ── Conversations ───────────────────────────────────────────────────

  // Cache the exact visible merge for each conversation. The overlay registry
  // remains the ownership/retirement authority, while the cache guarantees an
  // A -> B -> A paint never flashes the stale server-only snapshot.
  const conversationMessageCacheRef = useRef<
    Map<string, ConversationMessage[]>
  >(new Map());
  const conversationMessageOverlayRef = useRef<
    Map<string, ConversationMessageOverlay>
  >(new Map());
  // Cold-open sends can paint before createConversation returns an id. Their
  // exact lineages are registered here, then atomically transferred when the
  // production send path claims the newly-created conversation.
  const unownedConversationMessageOverlayRef =
    useRef<ConversationMessageOverlay>(new Map());
  // Explicit owner of the visible message store, including a freshly-created
  // conversation whose first authoritative GET has not committed yet.
  const visibleConversationMessagesOwnerRef = useRef<string | null>(null);
  // Claiming a target happens before the old rows are replaced. Keep the owner
  // of the bytes currently in the shared store separate so a returning A claim
  // never captures B's still-visible rows as evidence that A's overlay vanished.
  // `undefined` is an intentionally unbound store; `null` is the valid cold-open
  // owner used before a first-send conversation id exists.
  const visibleConversationMessagesContentOwnerRef = useRef<
    string | null | undefined
  >(null);
  // Text/time fallback dedupe needs the complete preceding newest window. An
  // around or overlay-only paint may omit an older repeated row, making that
  // weaker match ambiguous until one canonical newest response has landed.
  const canonicalNewestConversationMessageContentOwnerRef = useRef<
    string | null
  >(null);
  // Once an around window commits, cache paint alone cannot prove that its
  // omitted rows were already consumed. Require one exact-id-only newest
  // response before re-enabling weaker text/time convergence.
  const textFallbackBlockedConversationIdsRef = useRef<
    Map<string, "around" | "mutation">
  >(new Map());
  const conversationMessageOwnerGenerationRef = useRef(0);
  // Shared by newest and around loads: every visible request supersedes every
  // older visible request, even when ownership itself did not change.
  const visibleConversationMessageRequestGenerationRef = useRef(0);
  const activeMessageLoadFenceRef = useRef<ConversationMessageLoadFence | null>(
    null,
  );
  // Per-id prefetch aborts so a neighbor is never double-fetched.
  const prefetchAbortRef = useRef<Map<string, AbortController>>(new Map());
  // Server-cache writes are request-tokened independently of the visible
  // request fence. A prefetch transport may ignore abort and finish after a
  // newer full GET; its older token must not downgrade that newer snapshot.
  const conversationMessageCacheRequestSequenceRef = useRef(0);
  const conversationMessageCacheRequestTokenRef = useRef<Map<string, number>>(
    new Map(),
  );
  // Which conversation's messages `conversationMessagesRef` currently holds.
  // The ref only becomes that conversation's thread AFTER a load commits, so
  // any caller judging a conversation by `conversationMessagesRef` (the
  // empty-draft cleanup deletes in useChatCallbacks) MUST first check this id:
  // during a rapid switch the ref still holds the PREVIOUS thread while the
  // new fetch is in flight, and judging the new conversation by those stale
  // messages silently deleted real conversations. `null` = holder unknown.
  // Every `conversationMessagesRef.current` write below updates it in lockstep.
  const loadedConversationIdRef = useRef<string | null>(null);

  const beginConversationMessageCacheRequest = useCallback((id: string) => {
    const token = ++conversationMessageCacheRequestSequenceRef.current;
    conversationMessageCacheRequestTokenRef.current.set(id, token);
    return token;
  }, []);

  const invalidateConversationMessageCacheRequest = useCallback(
    (id: string) => {
      conversationMessageCacheRequestSequenceRef.current += 1;
      conversationMessageCacheRequestTokenRef.current.delete(id);
    },
    [],
  );

  const finishConversationMessageCacheRequest = useCallback(
    (id: string, requestToken: number) => {
      if (
        conversationMessageCacheRequestTokenRef.current.get(id) === requestToken
      ) {
        conversationMessageCacheRequestTokenRef.current.delete(id);
      }
    },
    [],
  );

  const cacheConversationMessages = useCallback(
    (
      id: string,
      serverMessages: ConversationMessage[],
      requestToken: number,
    ) => {
      if (
        conversationMessageCacheRequestTokenRef.current.get(id) !== requestToken
      ) {
        return;
      }
      const cache = conversationMessageCacheRef.current;
      // Re-insert to move to the most-recent position (eviction is oldest-first).
      cache.delete(id);
      cache.set(id, serverMessages);
      while (cache.size > CONVERSATION_MESSAGE_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
    [],
  );

  const captureVisibleConversationMessageOverlay = useCallback(
    (owner: string | null) => {
      if (visibleConversationMessagesOwnerRef.current !== owner) return;
      if (visibleConversationMessagesContentOwnerRef.current !== owner) return;
      const overlay =
        owner === null
          ? unownedConversationMessageOverlayRef.current
          : conversationMessageOverlayRef.current.get(owner);
      if (!overlay) return;
      captureRegisteredConversationMessageOverlay(
        overlay,
        conversationMessagesRef.current,
      );
      if (owner !== null && overlay.size === 0) {
        conversationMessageOverlayRef.current.delete(owner);
      }
    },
    [conversationMessagesRef],
  );

  const isCurrentConversationMessageFence = useCallback(
    (fence: ConversationMessageLoadFence): boolean =>
      activeMessageLoadFenceRef.current === fence &&
      !fence.controller.signal.aborted &&
      activeConversationIdRef.current === fence.conversationId &&
      visibleConversationMessagesOwnerRef.current === fence.conversationId &&
      conversationMessageOwnerGenerationRef.current === fence.ownerGeneration &&
      visibleConversationMessageRequestGenerationRef.current ===
        fence.visibleRequestGeneration,
    [activeConversationIdRef],
  );

  const invalidateConversationMessageFence = useCallback(() => {
    const fence = activeMessageLoadFenceRef.current;
    if (!fence) return;
    if (isCurrentConversationMessageFence(fence)) {
      captureVisibleConversationMessageOverlay(fence.conversationId);
    }
    fence.controller.abort();
    activeMessageLoadFenceRef.current = null;
  }, [
    captureVisibleConversationMessageOverlay,
    isCurrentConversationMessageFence,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationMessagesRef is a stable ref whose current value is intentionally read at claim time.
  const claimConversationMessagesOwnership = useCallback(
    (conversationId: string | null): number => {
      const previousOwner = visibleConversationMessagesOwnerRef.current;

      // Capture/release the old owner before changing generation. The active-id
      // check prevents an already-switched view from being attributed back to
      // an old owner.
      if (activeConversationIdRef.current === previousOwner) {
        captureVisibleConversationMessageOverlay(previousOwner);
      }
      invalidateConversationMessageFence();

      const targetOverlay =
        conversationId === null
          ? unownedConversationMessageOverlayRef.current
          : conversationMessageOverlayRef.current.get(conversationId);
      const targetHasVisibleOverlay = overlayMessages(targetOverlay).length > 0;
      const currentByLineage = indexConversationMessagesByLineage(
        conversationMessagesRef.current,
      );
      const targetOwnsVisibleRegisteredRows =
        targetHasVisibleOverlay &&
        currentByLineage.size > 0 &&
        [...currentByLineage].every(
          ([lineage, message]) =>
            targetOverlay?.get(lineage)?.message === message,
        );

      if (
        previousOwner === null &&
        conversationId !== null &&
        visibleConversationMessagesContentOwnerRef.current === null &&
        conversationMessagesRef.current.length > 0 &&
        !targetOwnsVisibleRegisteredRows
      ) {
        // A cold send can still be waiting for createConversation while the
        // user selects an existing room. Preserve its explicitly registered
        // unowned lineage, but retire its bytes from the shared visible store
        // synchronously so they never paint under the selected conversation.
        conversationMessagesRef.current = [];
        setConversationMessages([]);
        visibleConversationMessagesContentOwnerRef.current = undefined;
      }

      // Same-id persisted claims are resyncs, not navigation. Keep the owner
      // token stable so an async command or greeting already scoped to this
      // conversation remains valid while the reload gets its own request token.
      // A null -> null transition is an explicit new-draft/reset boundary and
      // must continue cancelling older cold-create work.
      if (previousOwner !== conversationId || conversationId === null) {
        conversationMessageOwnerGenerationRef.current += 1;
      }
      visibleConversationMessageRequestGenerationRef.current += 1;
      visibleConversationMessagesOwnerRef.current = conversationId;
      if (loadedConversationIdRef.current !== conversationId) {
        loadedConversationIdRef.current = null;
      }

      if (previousOwner === conversationId) {
        // Same-id claims are still semantic transitions (notably null → null
        // new-chat/reset while a cold create is pending). Give callers a fresh
        // token so that older creates cannot later reactivate or repaint a draft
        // the user explicitly left.
        if (conversationId === null) {
          // A null → null draft transition clears the shared rows immediately
          // afterward. Unbind those bytes so a later B claim cannot interpret
          // that intentional reset as evidence that the still-unowned cold turn
          // was deleted. Same-id persisted conversations keep their content
          // binding so overlapping stream/reload capture remains lossless.
          visibleConversationMessagesContentOwnerRef.current = undefined;
        }
        return conversationMessageOwnerGenerationRef.current;
      }

      if (targetOwnsVisibleRegisteredRows) {
        // A cold-open send re-homes only its exact registered lineages before
        // claiming the id returned by createConversation. Those same objects
        // are still the visible store, so the new id owns registry + rows.
        visibleConversationMessagesContentOwnerRef.current = conversationId;
      } else if (
        conversationMessagesRef.current.length === 0 &&
        !targetHasVisibleOverlay
      ) {
        // Empty is safe to bind for hydration/fresh-create paths. Do not bind an
        // empty placeholder over a target with a retained overlay: its load must
        // paint that overlay before absence can be captured.
        visibleConversationMessagesContentOwnerRef.current = conversationId;
      } else {
        // The bytes still belong to the released owner until the caller clears
        // them or the target loader paints cache/overlay state. Leaving the old
        // content owner here would let a later return claim capture unrelated
        // rows (or an empty placeholder) into the target registry.
        visibleConversationMessagesContentOwnerRef.current = undefined;
      }
      return conversationMessageOwnerGenerationRef.current;
    },
    [
      activeConversationIdRef,
      captureVisibleConversationMessageOverlay,
      invalidateConversationMessageFence,
      setConversationMessages,
    ],
  );

  const registerConversationMessageOverlay = useCallback(
    (
      conversationId: string | null,
      lineages: readonly string[],
      explicitMessages?: readonly ConversationMessage[],
    ) => {
      const overlay =
        conversationId === null
          ? unownedConversationMessageOverlayRef.current
          : (conversationMessageOverlayRef.current.get(conversationId) ??
            new Map<string, ConversationMessageOverlayRecord>());

      if (conversationId !== null) {
        // A first send can receive its created id after the user has selected a
        // different conversation. Re-home only the exact lineages that the send
        // registered while unowned; never infer ownership from receipts or from
        // whatever rows happen to be visible under the destination id.
        const unownedOverlay = unownedConversationMessageOverlayRef.current;
        for (const lineage of lineages) {
          const record = unownedOverlay.get(lineage);
          if (!record) continue;
          overlay.set(lineage, record);
          unownedOverlay.delete(lineage);
        }
        if (overlay.size > 0) {
          conversationMessageOverlayRef.current.set(conversationId, overlay);
        }
      }

      // Capture the newest window before registering these rows. Reconnect can
      // temporarily paint a durable copy beside its optimistic lineage; that
      // newly seen id must not become an exclusion for its own pending send.
      const cached =
        conversationId === null
          ? undefined
          : conversationMessageCacheRef.current.get(conversationId);
      const visible =
        visibleConversationMessagesContentOwnerRef.current === conversationId
          ? conversationMessagesRef.current
          : [];
      const requestedLineages = new Set(lineages);
      const precedingUsers = [...(cached ?? []), ...visible].filter(
        (message) =>
          message.role === "user" &&
          !requestedLineages.has(
            localConversationMessageLineage(message) ?? "",
          ),
      );
      const precedingServerUserIds =
        (cached !== undefined ||
          conversationId === null ||
          (loadedConversationIdRef.current === conversationId &&
            visibleConversationMessagesContentOwnerRef.current ===
              conversationId &&
            !textFallbackBlockedConversationIdsRef.current.has(
              conversationId,
            ))) &&
        (conversationId === null ||
          textFallbackBlockedConversationIdsRef.current.get(conversationId) !==
            "mutation")
          ? new Set(
              precedingUsers
                .filter((message) => !message.id.startsWith("temp-"))
                .map((message) => message.id),
            )
          : undefined;
      const precedingUserRecords = [...overlay]
        .filter(
          ([lineage, record]) =>
            !requestedLineages.has(lineage) && record.message?.role === "user",
        )
        .map(([, record]) => record);
      const precedingUserContext = () => ({
        precedingServerUserIds:
          precedingServerUserIds === undefined
            ? undefined
            : new Set(precedingServerUserIds),
        precedingUserRecords,
      });

      // Some exact rows are born only after an awaited create (action sends and
      // 404 replay). If their destination is already off-screen there is no
      // visible store to capture. Seed only the caller-supplied objects and
      // requested lineages; this never infers ownership from receipts or from B's
      // visible transcript.
      const explicitByLineage = indexConversationMessagesByLineage(
        explicitMessages ?? [],
      );
      for (const lineage of lineages) {
        const message = explicitByLineage.get(lineage);
        if (!message) continue;
        const existing = overlay.get(lineage);
        if (existing) {
          if (existing.message !== message) {
            existing.message = message;
            existing.revision += 1;
            existing.consecutiveNewestMisses = 0;
          }
          existing.hasBeenVisible = true;
          if (!message.id.startsWith("temp-")) existing.terminalDurable = true;
          continue;
        }
        overlay.set(lineage, {
          message,
          revision: 1,
          consecutiveNewestMisses: 0,
          hasBeenVisible: true,
          terminalDurable: !message.id.startsWith("temp-"),
          ...precedingUserContext(),
        });
      }
      if (conversationId !== null && overlay.size > 0) {
        conversationMessageOverlayRef.current.set(conversationId, overlay);
      }

      if (visibleConversationMessagesOwnerRef.current !== conversationId) {
        return;
      }
      for (const lineage of lineages) {
        if (!lineage || overlay.has(lineage)) continue;
        overlay.set(lineage, {
          message: null,
          revision: 0,
          consecutiveNewestMisses: 0,
          hasBeenVisible: false,
          terminalDurable: false,
          ...precedingUserContext(),
        });
      }
      visibleConversationMessagesContentOwnerRef.current = conversationId;
      captureRegisteredConversationMessageOverlay(
        overlay,
        conversationMessagesRef.current,
      );
      if (conversationId !== null && overlay.size > 0) {
        conversationMessageOverlayRef.current.set(conversationId, overlay);
      }
    },
    [conversationMessagesRef],
  );

  const getConversationMessagesSnapshot = useCallback(
    (conversationId: string): ConversationMessage[] | undefined => {
      if (
        activeConversationIdRef.current !== conversationId ||
        visibleConversationMessagesOwnerRef.current !== conversationId ||
        visibleConversationMessagesContentOwnerRef.current !== conversationId
      )
        return undefined;
      return conversationMessagesRef.current;
    },
    [activeConversationIdRef, conversationMessagesRef],
  );

  const applyConversationMessageStream = useCallback(
    (
      conversationId: string,
      changed: ConversationMessage[],
      removed: string[],
    ) => {
      const previous = getConversationMessagesSnapshot(conversationId);
      if (!previous) return;
      const removedIds = new Set(removed);
      const rows = new Map(
        previous
          .filter((row) => !removedIds.has(row.id))
          .map((row) => [row.id, row]),
      );
      for (const row of changed) rows.set(row.id, row);
      const orderedRows = [...rows.values()].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      setConversationMessages(
        mergeMessagesChronologically(
          orderedRows.filter((row) => row.assistantEphemeral !== true),
          orderedRows.filter((row) => row.assistantEphemeral === true),
        ),
      );
      // Relayed optimistic and ephemeral rows need the same history-refresh
      // protection as locally sent rows. Durable history is not an overlay.
      registerConversationMessageOverlay(
        conversationId,
        changed.flatMap((row) => {
          const lineage = localConversationMessageLineage(row);
          return lineage ? [lineage] : [];
        }),
        changed,
      );
    },
    [
      getConversationMessagesSnapshot,
      registerConversationMessageOverlay,
      setConversationMessages,
    ],
  );

  const isConversationMessagesOwnershipCurrent = useCallback(
    (conversationId: string | null, generation: number): boolean =>
      visibleConversationMessagesOwnerRef.current === conversationId &&
      conversationMessageOwnerGenerationRef.current === generation,
    [],
  );

  const getConversationMessagesOwnershipGeneration = useCallback(
    (): number => conversationMessageOwnerGenerationRef.current,
    [],
  );

  const applyConversationMessageOverlayModification = useCallback(
    (
      conversationId: string | null,
      lineage: string,
      modification: StreamingTextModification,
      options?: { onlyIfEmpty?: boolean },
    ) => {
      const overlay =
        conversationId === null
          ? unownedConversationMessageOverlayRef.current
          : conversationMessageOverlayRef.current.get(conversationId);
      const record = overlay?.get(lineage);
      if (!overlay || !record?.message) return;
      if (
        options?.onlyIfEmpty &&
        modification.mode === "drop" &&
        record.message.text.trim()
      ) {
        return;
      }

      let nextMessages = [record.message];
      const ownedModification = {
        ...modification,
        // Off-screen callers keep addressing the stable temp lineage after a
        // terminal rekey. The reducer targets physical ids, so translate that
        // exact registered lineage to its current owned row id.
        messageId: record.message.id,
      } as StreamingTextModification;
      applyStreamingTextModification((value) => {
        nextMessages =
          typeof value === "function" ? value(nextMessages) : value;
      }, ownedModification);
      const nextMessage =
        nextMessages.find(
          (message) => localConversationMessageLineage(message) === lineage,
        ) ?? null;
      if (nextMessage === record.message) return;
      if (!nextMessage) {
        overlay.delete(lineage);
        if (conversationId !== null && overlay.size === 0) {
          conversationMessageOverlayRef.current.delete(conversationId);
        }
        return;
      }

      record.message = nextMessage;
      record.revision += 1;
      record.consecutiveNewestMisses = 0;
      record.hasBeenVisible = true;
      if (!nextMessage.id.startsWith("temp-")) {
        record.terminalDurable = true;
      }
    },
    [],
  );

  const removeConversationMessageStateMessages = useCallback(
    (conversationId: string, mutation: ConversationMessageStateMutation) => {
      const { removedMessages } = mutation;
      const removedIds = new Set(removedMessages.map((message) => message.id));
      const removedLineages = new Set(
        removedMessages
          .map(localConversationMessageLineage)
          .filter((lineage): lineage is string => lineage !== null),
      );
      if (
        mutation.mode === "delete-exact" &&
        removedIds.size === 0 &&
        removedLineages.size === 0
      ) {
        return;
      }

      const fence = activeMessageLoadFenceRef.current;
      if (fence?.conversationId === conversationId) {
        fence.controller.abort();
        activeMessageLoadFenceRef.current = null;
      }
      invalidateConversationMessageCacheRequest(conversationId);
      const prefetch = prefetchAbortRef.current.get(conversationId);
      prefetch?.abort();
      if (prefetchAbortRef.current.get(conversationId) === prefetch) {
        prefetchAbortRef.current.delete(conversationId);
      }

      // A successful mutation makes the preceding server snapshot
      // non-canonical. The first newest response after it must reconcile by
      // exact ids only; otherwise a stale row with repeated text can consume a
      // replacement optimistic turn.
      textFallbackBlockedConversationIdsRef.current.set(
        conversationId,
        "mutation",
      );
      if (
        canonicalNewestConversationMessageContentOwnerRef.current ===
        conversationId
      ) {
        canonicalNewestConversationMessageContentOwnerRef.current = null;
      }

      if (mutation.mode === "truncate") {
        // A centered around window can omit newer rows that the server just
        // truncated. No exact patch can make that cached newest snapshot safe.
        conversationMessageCacheRef.current.delete(conversationId);
      } else {
        const cached = conversationMessageCacheRef.current.get(conversationId);
        if (cached) {
          conversationMessageCacheRef.current.set(
            conversationId,
            cached.filter((message) => {
              if (removedIds.has(message.id)) return false;
              const lineage = localConversationMessageLineage(message);
              return lineage === null || !removedLineages.has(lineage);
            }),
          );
        }
      }

      const overlay = conversationMessageOverlayRef.current.get(conversationId);
      if (overlay) {
        const truncateCutoff =
          mutation.mode === "truncate"
            ? Math.min(...removedMessages.map((message) => message.timestamp))
            : null;
        for (const [lineage, record] of overlay) {
          const message = record.message;
          if (
            removedLineages.has(lineage) ||
            (message !== null && removedIds.has(message.id)) ||
            (truncateCutoff !== null &&
              Number.isFinite(truncateCutoff) &&
              message !== null &&
              message.timestamp >= truncateCutoff)
          ) {
            overlay.delete(lineage);
          }
        }
        if (overlay.size === 0) {
          conversationMessageOverlayRef.current.delete(conversationId);
        }
      }

      if (visibleConversationMessagesOwnerRef.current === conversationId) {
        if (mutation.mode === "truncate") {
          // A GET may have committed a pre-truncate tail while the mutation was
          // awaiting the server. Restore the caller's exact captured prefix,
          // not a filtered view of whichever window happened to win that race.
          const next = [...mutation.preservedMessages];
          conversationMessagesRef.current = next;
          visibleConversationMessagesContentOwnerRef.current = conversationId;
          loadedConversationIdRef.current = conversationId;
          greetingFiredRef.current = hasConversationBootstrapMessage(next);
          setConversationMessages(next);
        } else if (
          visibleConversationMessagesContentOwnerRef.current === conversationId
        ) {
          const current = conversationMessagesRef.current;
          const next = current.filter((message) => {
            if (removedIds.has(message.id)) return false;
            const lineage = localConversationMessageLineage(message);
            return lineage === null || !removedLineages.has(lineage);
          });
          if (next.length !== current.length) {
            conversationMessagesRef.current = next;
            greetingFiredRef.current = hasConversationBootstrapMessage(next);
            setConversationMessages(next);
          }
        }
      }
    },
    [
      conversationMessagesRef,
      greetingFiredRef,
      invalidateConversationMessageCacheRequest,
      setConversationMessages,
    ],
  );

  const discardConversationMessageState = useCallback(
    (conversationId?: string) => {
      if (conversationId === undefined) {
        activeMessageLoadFenceRef.current?.controller.abort();
        activeMessageLoadFenceRef.current = null;
        conversationMessageCacheRef.current.clear();
        conversationMessageOverlayRef.current.clear();
        unownedConversationMessageOverlayRef.current.clear();
        visibleConversationMessagesOwnerRef.current = null;
        visibleConversationMessagesContentOwnerRef.current = null;
        canonicalNewestConversationMessageContentOwnerRef.current = null;
        textFallbackBlockedConversationIdsRef.current.clear();
        conversationMessageOwnerGenerationRef.current += 1;
        visibleConversationMessageRequestGenerationRef.current += 1;
        loadedConversationIdRef.current = null;
        for (const controller of prefetchAbortRef.current.values()) {
          controller.abort();
        }
        prefetchAbortRef.current.clear();
        conversationMessageCacheRequestSequenceRef.current += 1;
        conversationMessageCacheRequestTokenRef.current.clear();
        greetingFiredRef.current = false;
        activeConversationIdRef.current = null;
        conversationMessagesRef.current = [];
        setActiveConversationId(null);
        setConversationMessages([]);
        setConversations([]);
        return;
      }

      if (
        activeMessageLoadFenceRef.current?.conversationId === conversationId
      ) {
        activeMessageLoadFenceRef.current.controller.abort();
        activeMessageLoadFenceRef.current = null;
      }
      conversationMessageCacheRef.current.delete(conversationId);
      conversationMessageOverlayRef.current.delete(conversationId);
      textFallbackBlockedConversationIdsRef.current.delete(conversationId);
      if (
        canonicalNewestConversationMessageContentOwnerRef.current ===
        conversationId
      ) {
        canonicalNewestConversationMessageContentOwnerRef.current = null;
      }
      invalidateConversationMessageCacheRequest(conversationId);
      prefetchAbortRef.current.get(conversationId)?.abort();
      prefetchAbortRef.current.delete(conversationId);
      if (visibleConversationMessagesOwnerRef.current === conversationId) {
        visibleConversationMessagesOwnerRef.current = null;
        visibleConversationMessagesContentOwnerRef.current = undefined;
        conversationMessageOwnerGenerationRef.current += 1;
        visibleConversationMessageRequestGenerationRef.current += 1;
        loadedConversationIdRef.current = null;
      }
    },
    [
      activeConversationIdRef,
      conversationMessagesRef,
      greetingFiredRef,
      invalidateConversationMessageCacheRequest,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
    ],
  );

  useEffect(() => {
    // Only explicit runtime/profile switches are authority boundaries. Raw
    // setBaseUrl/repointBaseUrl also power temporary probes and the
    // shared-to-dedicated handoff, both of which must preserve the transcript.
    return subscribeRuntimeAuthoritySwitch((phase) => {
      if (phase === "before") {
        discardConversationMessageState();
      }
    });
  }, [discardConversationMessageState]);

  const loadConversations = useCallback(async (): Promise<
    Conversation[] | null
  > => {
    try {
      const { conversations: c } = await client.listConversations();
      const normalized = normalizeConversationList(c);
      setConversations(normalized);
      return normalized;
    } catch {
      return null;
    }
  }, [setConversations]);

  const loadConversationMessages = useCallback(
    async function loadNewestConversationMessages(
      convId: string,
      confirmGuardedRead = true,
    ): Promise<LoadConversationMessagesResult> {
      // This is the visible transcript loader, not a background fetch. A late
      // send/retry failure can request reconciliation after the user has moved
      // on; reject it before invalidating the current fence, claiming ownership,
      // or painting A's cache under active conversation B.
      if (activeConversationIdRef.current !== convId) return { ok: true };
      markConversationHistoryApplied(false);
      invalidateConversationMessageFence();
      const pendingPrefetch = prefetchAbortRef.current.get(convId);
      if (pendingPrefetch) {
        pendingPrefetch.abort();
        if (prefetchAbortRef.current.get(convId) === pendingPrefetch) {
          prefetchAbortRef.current.delete(convId);
        }
      }
      const cacheRequestToken = beginConversationMessageCacheRequest(convId);
      claimConversationMessagesOwnership(convId);
      captureVisibleConversationMessageOverlay(convId);
      const visibleRequestGeneration =
        ++visibleConversationMessageRequestGenerationRef.current;

      const controller = new AbortController();
      const { signal } = controller;

      // Instant paint from the prefetch cache (a swiped-to neighbor) so the
      // thread never flashes empty mid-swipe; the fetch below still revalidates.
      const cached = conversationMessageCacheRef.current.get(convId);
      const overlay = conversationMessageOverlayRef.current.get(convId);
      if (cached) {
        const restoredServerMessages = restoreCapabilityHandoffs(cached);
        const mergedCached = reconcileConversationMessagesWithOverlay(
          restoredServerMessages,
          overlay,
        );
        canonicalNewestConversationMessageContentOwnerRef.current = convId;
        greetingFiredRef.current =
          hasConversationBootstrapMessage(mergedCached);
        visibleConversationMessagesContentOwnerRef.current = convId;
        conversationMessagesRef.current = mergedCached;
        loadedConversationIdRef.current = convId;
        setConversationMessages(mergedCached);
      } else if (
        loadedConversationIdRef.current !== convId &&
        overlayMessages(overlay).length > 0
      ) {
        // The server LRU may evict a conversation while its overlay is still
        // waiting for convergence. Paint those owned rows rather than losing
        // them during a long navigation sweep.
        const localMessages = overlayMessages(overlay);
        canonicalNewestConversationMessageContentOwnerRef.current = null;
        greetingFiredRef.current =
          hasConversationBootstrapMessage(localMessages);
        visibleConversationMessagesContentOwnerRef.current = convId;
        conversationMessagesRef.current = localMessages;
        loadedConversationIdRef.current = null;
        setConversationMessages(localMessages);
      } else if (loadedConversationIdRef.current !== convId) {
        // No cache means the visible transcript still belongs to the previous
        // active conversation until the fetch resolves. Clear it immediately so
        // the home overlay cannot render old-room context under the newly
        // selected conversation while the network request is in flight.
        canonicalNewestConversationMessageContentOwnerRef.current = null;
        greetingFiredRef.current = false;
        visibleConversationMessagesContentOwnerRef.current = convId;
        conversationMessagesRef.current = [];
        loadedConversationIdRef.current = null;
        setConversationMessages([]);
      }
      // Cache reconciliation can replace a local row with a lineage-linked
      // server clone. Materialize that pre-request state before snapshotting so
      // the response fence compares against the exact revision it followed.
      captureVisibleConversationMessageOverlay(convId);
      const textFallbackBarrier =
        textFallbackBlockedConversationIdsRef.current.get(convId);
      const textFallbackContextIsCanonical =
        (canonicalNewestConversationMessageContentOwnerRef.current === convId ||
          loadedConversationIdRef.current === convId) &&
        visibleConversationMessagesContentOwnerRef.current === convId &&
        !textFallbackBlockedConversationIdsRef.current.has(convId);

      const fence: ConversationMessageLoadFence = {
        conversationId: convId,
        controller,
        ownerGeneration: conversationMessageOwnerGenerationRef.current,
        visibleRequestGeneration,
        requestKind: "newest",
        overlayRevisionsAtStart: snapshotOverlayRevisions(
          conversationMessageOverlayRef.current.get(convId),
        ),
      };
      activeMessageLoadFenceRef.current = fence;

      try {
        const { messages } = await client.getConversationMessages(convId, {
          signal,
        });
        // Validate token + active owner before parsing, capture, cache writes,
        // or any visible effect. A new conversation may claim ownership without
        // starting another load, so AbortSignal alone is not a sufficient guard.
        if (!isCurrentConversationMessageFence(fence)) return { ok: true };
        const serverMessages = restoreCapabilityHandoffs(
          filterRenderableConversationMessages(messages),
        );
        captureVisibleConversationMessageOverlay(convId);
        const currentOverlay =
          conversationMessageOverlayRef.current.get(convId);
        const nextMessages = reconcileConversationMessagesWithOverlay(
          serverMessages,
          currentOverlay,
          {
            localContext: conversationMessagesRef.current,
            allowTextFallback: textFallbackContextIsCanonical,
            overlayRevisionsAtRequestStart: fence.overlayRevisionsAtStart,
          },
        );
        if (currentOverlay?.size === 0) {
          conversationMessageOverlayRef.current.delete(convId);
        }
        cacheConversationMessages(convId, nextMessages, cacheRequestToken);
        clearSettledPendingChatTurns(convId, serverMessages);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        canonicalNewestConversationMessageContentOwnerRef.current = convId;
        textFallbackBlockedConversationIdsRef.current.delete(convId);
        visibleConversationMessagesContentOwnerRef.current = convId;
        conversationMessagesRef.current = nextMessages;
        loadedConversationIdRef.current = convId;
        setConversationMessages(nextMessages);
        markConversationHistoryApplied(true);
        // A guarded around-window recovery establishes canonical history but
        // cannot retire a temp user on that first response. Confirm once when
        // that history contains a safely matchable copy of a registered turn.
        // Do not poll merely pending sends, and never bypass a newer owner/load.
        if (
          confirmGuardedRead &&
          !textFallbackContextIsCanonical &&
          textFallbackBarrier !== "mutation" &&
          currentOverlay &&
          isCurrentConversationMessageFence(fence)
        ) {
          const candidates = resolvedLocalOverlayServerIndexes(
            serverMessages,
            nextMessages,
            currentOverlay,
          );
          const hasUnresolvedUserCopy = [...currentOverlay].some(
            ([lineage, record]) =>
              record.message?.role === "user" &&
              record.message.id.startsWith("temp-") &&
              record.precedingServerUserIds !== undefined &&
              fence.overlayRevisionsAtStart.get(lineage) === record.revision &&
              candidates.has(record.message.id),
          );
          if (hasUnresolvedUserCopy)
            return loadNewestConversationMessages(convId, false);
        }
        return { ok: true };
      } catch (err) {
        // A newer load aborted this one (fast swipe); the newer load owns the
        // thread, so report success and let the caller skip its error path.
        if (
          signal.aborted ||
          (err as { name?: string }).name === "AbortError"
        ) {
          return { ok: true };
        }
        // Ownership may change without another GET (new-chat/create/reset).
        // Such a response is stale and may not capture, clear, or handle a 404
        // against the newly-owned visible store.
        if (!isCurrentConversationMessageFence(fence)) return { ok: true };
        // A transient error still closes this request generation. Materialize
        // any registered terminal rekey before finally clears the fence.
        captureVisibleConversationMessageOverlay(convId);
        const status = (err as { status?: number }).status;
        if (status === 404) {
          // error-policy:J4 the 404 already settled the thread's fate (gone);
          // this refresh only re-syncs the sidebar list. Its failure degrades to
          // the stale list + cleared selection below — logged so a broken
          // list endpoint is not silent.
          const refreshed = await client
            .listConversations()
            .catch((refreshErr: unknown) => {
              logger.warn(
                { err: refreshErr },
                "[useDataLoaders] conversation-list refresh after 404 failed",
              );
              return null;
            });
          // The list refresh is another await boundary. A create/select/reset can
          // claim a different owner while it runs; that newer owner must keep its
          // rows even though this request had already observed A's 404.
          if (!isCurrentConversationMessageFence(fence)) return { ok: true };
          let fallbackId: string | null = null;
          if (refreshed) {
            const normalized = normalizeConversationList(
              refreshed.conversations,
            );
            setConversations(normalized);
            fallbackId = normalized[0]?.id ?? null;
          }
          // The conversation is definitively gone (404) — clear the thread and
          // drop any stale cache entry so a later swipe can't resurrect it.
          discardConversationMessageState(convId);
          greetingFiredRef.current = false;
          canonicalNewestConversationMessageContentOwnerRef.current = null;
          visibleConversationMessagesContentOwnerRef.current = null;
          conversationMessagesRef.current = [];
          setConversationMessages([]);
          if (activeConversationIdRef.current === convId) {
            claimConversationMessagesOwnership(fallbackId);
            setActiveConversationId(fallbackId);
            activeConversationIdRef.current = fallbackId;
          }
        }
        // For TRANSIENT errors (network drop mid-stream, timeout, 5xx) do NOT
        // wipe the thread. The message store is reused as the on-screen history,
        // and blanking it on a flaky-connection reload looked like the app ate
        // the entire conversation (the data is still server-side; a later reload
        // restores it). If we already painted from the prefetch cache, the user
        // is looking at usable (if slightly stale) content, so treat the failed
        // revalidation as a soft success rather than surfacing an error over it.
        if (cached && status !== 404) return { ok: true };
        return {
          ok: false,
          status,
          message:
            err instanceof Error
              ? err.message
              : "Failed to load conversation messages",
        };
      } finally {
        finishConversationMessageCacheRequest(convId, cacheRequestToken);
        if (activeMessageLoadFenceRef.current === fence) {
          if (isCurrentConversationMessageFence(fence)) {
            captureVisibleConversationMessageOverlay(convId);
          }
          activeMessageLoadFenceRef.current = null;
        }
      }
    },
    [
      activeConversationIdRef,
      beginConversationMessageCacheRequest,
      cacheConversationMessages,
      captureVisibleConversationMessageOverlay,
      claimConversationMessagesOwnership,
      conversationMessagesRef,
      discardConversationMessageState,
      finishConversationMessageCacheRequest,
      greetingFiredRef,
      invalidateConversationMessageFence,
      isCurrentConversationMessageFence,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
    ],
  );

  // Replace the active thread with a window CENTERED on a specific message so a
  // keyword-search jump can scroll to a hit older than the most-recent window
  // (#9955). The conversation must already be selected (the jump path awaits
  // handleSelectConversation first); the active-id guard drops the result if the
  // user navigated away before it landed. Best-effort — a failure leaves the
  // current thread untouched and the caller simply doesn't scroll.
  const loadConversationMessagesAround = useCallback(
    async (convId: string, messageId: string): Promise<boolean> => {
      if (
        activeConversationIdRef.current !== convId ||
        visibleConversationMessagesOwnerRef.current !== convId
      ) {
        return false;
      }
      invalidateConversationMessageFence();
      const ownerGeneration = conversationMessageOwnerGenerationRef.current;
      const visibleRequestGeneration =
        ++visibleConversationMessageRequestGenerationRef.current;
      captureVisibleConversationMessageOverlay(convId);
      const controller = new AbortController();
      const fence: ConversationMessageLoadFence = {
        conversationId: convId,
        controller,
        ownerGeneration,
        visibleRequestGeneration,
        requestKind: "around",
        overlayRevisionsAtStart: new Map(),
      };
      activeMessageLoadFenceRef.current = fence;
      try {
        const { messages } = await client.getConversationMessages(convId, {
          around: messageId,
          signal: controller.signal,
        });
        // Around responses use their own owner token. Validate it before any
        // capture/commit, and never let an around window replace the cached
        // canonical newest-history snapshot.
        if (!isCurrentConversationMessageFence(fence)) return false;
        captureVisibleConversationMessageOverlay(convId);
        const serverMessages = filterRenderableConversationMessages(messages);
        const nextMessages = reconcileConversationMessagesWithOverlay(
          serverMessages,
          conversationMessageOverlayRef.current.get(convId),
          {
            localContext: conversationMessagesRef.current,
            allowTextFallback: false,
          },
        );
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        canonicalNewestConversationMessageContentOwnerRef.current = null;
        if (!textFallbackBlockedConversationIdsRef.current.has(convId)) {
          textFallbackBlockedConversationIdsRef.current.set(convId, "around");
        }
        visibleConversationMessagesContentOwnerRef.current = convId;
        conversationMessagesRef.current = nextMessages;
        loadedConversationIdRef.current = convId;
        setConversationMessages(nextMessages);
        return true;
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error as { name?: string }).name === "AbortError"
        ) {
          return false;
        }
        logger.debug(
          { error },
          `[useDataLoaders] around-window load failed for ${convId}`,
        );
        return false;
      } finally {
        if (activeMessageLoadFenceRef.current === fence) {
          if (isCurrentConversationMessageFence(fence)) {
            captureVisibleConversationMessageOverlay(convId);
          }
          activeMessageLoadFenceRef.current = null;
        }
      }
    },
    [
      activeConversationIdRef,
      captureVisibleConversationMessageOverlay,
      conversationMessagesRef,
      greetingFiredRef,
      invalidateConversationMessageFence,
      isCurrentConversationMessageFence,
      setConversationMessages,
    ],
  );

  // Warm the prefetch cache for adjacent conversations so a horizontal swipe
  // paints instantly. Best-effort + abortable: an id already cached or already
  // in flight is skipped, and a miss just means the eventual select does a
  // normal (spinner-backed) load.
  const prefetchConversationMessages = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        if (!id) continue;
        if (conversationMessageCacheRef.current.has(id)) continue;
        if (prefetchAbortRef.current.has(id)) continue;
        const controller = new AbortController();
        const cacheRequestToken = beginConversationMessageCacheRequest(id);
        prefetchAbortRef.current.set(id, controller);
        void client
          .getConversationMessages(id, { signal: controller.signal })
          .then(({ messages }) => {
            if (controller.signal.aborted) return;
            cacheConversationMessages(
              id,
              filterRenderableConversationMessages(messages),
              cacheRequestToken,
            );
          })
          .catch(() => {
            // Prefetch is opportunistic warming; ignore failures.
          })
          .finally(() => {
            if (prefetchAbortRef.current.get(id) === controller) {
              prefetchAbortRef.current.delete(id);
            }
            finishConversationMessageCacheRequest(id, cacheRequestToken);
          });
      }
    },
    [
      beginConversationMessageCacheRequest,
      cacheConversationMessages,
      finishConversationMessageCacheRequest,
    ],
  );

  // ── BSC trade / steward wrappers ────────────────────────────────────

  const getBscTradePreflight = useCallback(
    async (tokenAddress?: string): Promise<BscTradePreflightResponse> =>
      client.getBscTradePreflight(tokenAddress),
    [],
  );

  const getBscTradeQuote = useCallback(
    async (request: BscTradeQuoteRequest): Promise<BscTradeQuoteResponse> =>
      client.getBscTradeQuote(request),
    [],
  );

  const getBscTradeTxStatus = useCallback(
    async (hash: string): Promise<BscTradeTxStatusResponse> =>
      client.getBscTradeTxStatus(hash),
    [],
  );

  const getStewardStatus = useCallback(
    async () => client.getStewardStatus(),
    [],
  );

  const getStewardAddresses = useCallback(
    async () => client.getStewardAddresses(),
    [],
  );

  const getStewardBalance = useCallback(
    async (chainId?: number) => client.getStewardBalance(chainId),
    [],
  );

  const getStewardTokens = useCallback(
    async (chainId?: number) => client.getStewardTokens(chainId),
    [],
  );

  const getStewardWebhookEvents = useCallback(
    async (opts?: { event?: StewardWebhookEventType; since?: number }) =>
      client.getStewardWebhookEvents(opts),
    [],
  );

  const getStewardHistory = useCallback(
    async (opts?: { status?: string; limit?: number; offset?: number }) =>
      client.getStewardHistory(opts),
    [],
  );

  const getStewardPending = useCallback(
    async () => client.getStewardPending(),
    [],
  );

  const approveStewardTx = useCallback(
    async (txId: string) => client.approveStewardTx(txId),
    [],
  );

  const rejectStewardTx = useCallback(
    async (txId: string, reason?: string) =>
      client.rejectStewardTx(txId, reason),
    [],
  );

  const loadWalletTradingProfile = useCallback(
    async (
      window: WalletTradingProfileWindow = "30d",
      source: WalletTradingProfileSourceFilter = "all",
    ): Promise<WalletTradingProfileResponse> =>
      client.getWalletTradingProfile(window, source),
    [],
  );

  const executeBscTrade = useCallback(
    async (request: BscTradeExecuteRequest): Promise<BscTradeExecuteResponse> =>
      client.executeBscTrade(request),
    [],
  );

  const executeBscTransfer = useCallback(
    async (
      request: BscTransferExecuteRequest,
    ): Promise<BscTransferExecuteResponse> =>
      client.executeBscTransfer(request),
    [],
  );

  const loadInventory = useCallback(async () => {
    await loadWalletConfig();
  }, [loadWalletConfig]);

  // ── ownerName hydration ─────────────────────────────────────────────

  // Owner name lives in agent config, so it can only be read once the agent API
  // is reachable. Gating on agent readiness (rather than firing on mount) avoids
  // issuing the request during first-run / early startup, where it would block
  // until the 10s client timeout, and naturally re-hydrates if the agent
  // reconnects. The boolean keeps the effect from re-running on every status
  // poll, which only changes the AgentStatus object reference.
  const agentReachable = agentStatus !== null;

  useEffect(() => {
    if (!agentReachable || !authenticated) {
      return;
    }

    let cancelled = false;
    void client
      .getConfig()
      .then((cfg) => {
        if (cancelled) {
          return;
        }

        const persisted = normalizeOwnerName(cfg.ui?.ownerName);
        if (persisted) {
          setOwnerNameState(persisted);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        logger.debug({ error }, "[useDataLoaders] owner-name hydration failed");
      });

    return () => {
      cancelled = true;
    };
  }, [agentReachable, authenticated, setOwnerNameState]);

  // ── Character language sync ─────────────────────────────────────────

  const localizedCharacterLanguageRef = useRef<UiLanguage>(uiLanguage);

  useEffect(() => {
    const previousLanguage = localizedCharacterLanguageRef.current;
    localizedCharacterLanguageRef.current = uiLanguage;

    if (previousLanguage === uiLanguage) {
      return;
    }
    if (!firstRunComplete || selectedVrmIndex <= 0) {
      return;
    }

    const characterName =
      characterData?.name?.trim() ||
      characterDraft?.name?.trim() ||
      agentStatus?.agentName?.trim();

    // Resolve the persona by name first: avatarIndex is a VRM art-asset index
    // that several personas can share (Eliza and Chen both render asset 1), so
    // the index alone would relocalize a named persona to its sibling.
    const preset =
      resolveStylePresetByName(characterName, uiLanguage) ??
      resolveStylePresetByAvatarIndex(selectedVrmIndex, uiLanguage);
    if (!preset) {
      return;
    }

    const resolvedName = characterName || preset.name;

    void (async () => {
      try {
        await client.updateCharacter(
          buildLocalizedCharacterPayload(preset, resolvedName),
        );
        await loadCharacter();
      } catch {
        // best-effort; user can retry by changing language again
      }
    })();
  }, [
    agentStatus?.agentName,
    characterData?.name,
    characterDraft?.name,
    loadCharacter,
    firstRunComplete,
    selectedVrmIndex,
    uiLanguage,
  ]);

  // ── Workbench / update / extension ──────────────────────────────────

  const [workbenchLoading, setWorkbenchLoading] = useState(false);
  const [workbench, setWorkbench] = useState<WorkbenchOverview | null>(null);
  const [workbenchTasksAvailable, setWorkbenchTasksAvailable] = useState(false);
  const [workbenchTriggersAvailable, setWorkbenchTriggersAvailable] =
    useState(false);
  const [workbenchTodosAvailable, setWorkbenchTodosAvailable] = useState(false);

  const loadWorkbench = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setWorkbench(null);
      setWorkbenchTasksAvailable(false);
      setWorkbenchTriggersAvailable(false);
      setWorkbenchTodosAvailable(false);
      setWorkbenchLoading(false);
      return;
    }
    setWorkbenchLoading(true);
    try {
      const result = await client.getWorkbenchOverview();
      setWorkbench(result);
      setWorkbenchTasksAvailable(result.tasksAvailable ?? false);
      setWorkbenchTriggersAvailable(result.triggersAvailable ?? false);
      setWorkbenchTodosAvailable(result.todosAvailable ?? false);
    } catch {
      setWorkbench(null);
      setWorkbenchTasksAvailable(false);
      setWorkbenchTriggersAvailable(false);
      setWorkbenchTodosAvailable(false);
    } finally {
      setWorkbenchLoading(false);
    }
  }, [authenticated]);

  // The workbench load normally fires on the agent-state "running" edge
  // (useAgentGreetingEffects). When that edge lands before the auth probe
  // resolves the load is suppressed by the gate above, so fire it once the
  // session flips to authenticated with the agent already reachable.
  const workbenchAuthArmedRef = useRef(authenticated);
  useEffect(() => {
    const was = workbenchAuthArmedRef.current;
    workbenchAuthArmedRef.current = authenticated;
    if (!was && authenticated && agentReachable) {
      void loadWorkbench();
    }
  }, [agentReachable, authenticated, loadWorkbench]);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateChannelSaving, setUpdateChannelSaving] = useState(false);
  const updateChannelSavingRef = useRef(false);

  const loadUpdateStatus = useCallback(async (force = false) => {
    setUpdateLoading(true);
    try {
      const status = await client.getUpdateStatus(force);
      setUpdateStatus(status);
    } catch {
      /* ignore */
    }
    setUpdateLoading(false);
  }, []);

  const [extensionStatus, setExtensionStatus] =
    useState<ExtensionStatus | null>(null);
  const [extensionChecking, setExtensionChecking] = useState(false);

  const checkExtensionStatus = useCallback(async () => {
    setExtensionChecking(true);
    try {
      const ext = await client.getExtensionStatus();
      setExtensionStatus(ext);
    } catch {
      setExtensionStatus({
        relayReachable: false,
        relayPort: 18792,
        extensionPath: null,
        chromeBuildPath: null,
        chromePackagePath: null,
        safariWebExtensionPath: null,
        safariAppPath: null,
        safariPackagePath: null,
      });
    }
    setExtensionChecking(false);
  }, []);

  // ── Channel change ──────────────────────────────────────────────────

  const handleChannelChange = useCallback(
    async (channel: "stable" | "beta" | "nightly") => {
      if (updateChannelSavingRef.current || updateChannelSaving) return;
      if (updateStatus?.channel === channel) return;
      updateChannelSavingRef.current = true;
      setUpdateChannelSaving(true);
      try {
        await client.setUpdateChannel(channel);
        await loadUpdateStatus(true);
      } catch {
        /* ignore */
      } finally {
        updateChannelSavingRef.current = false;
        setUpdateChannelSaving(false);
      }
    },
    [updateChannelSaving, updateStatus, loadUpdateStatus],
  );

  return {
    // Autonomy
    applyAutonomyEventMerge,
    fetchAutonomyReplay,
    appendAutonomousEvent,
    // Conversations
    loadConversations,
    loadConversationMessages,
    loadConversationMessagesAround,
    prefetchConversationMessages,
    claimConversationMessagesOwnership,
    isConversationMessagesOwnershipCurrent,
    getConversationMessagesOwnershipGeneration,
    registerConversationMessageOverlay,
    getConversationMessagesSnapshot,
    applyConversationMessageStream,
    applyConversationMessageOverlayModification,
    removeConversationMessageStateMessages,
    discardConversationMessageState,
    loadedConversationIdRef,
    // BSC / Steward / Trading
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    getStewardStatus,
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    loadWalletTradingProfile,
    executeBscTrade,
    executeBscTransfer,
    loadInventory,
    // Workbench
    workbenchLoading,
    workbench,
    workbenchTasksAvailable,
    workbenchTriggersAvailable,
    workbenchTodosAvailable,
    loadWorkbench,
    // Updates
    updateStatus,
    updateLoading,
    updateChannelSaving,
    loadUpdateStatus,
    handleChannelChange,
    // Extension
    extensionStatus,
    extensionChecking,
    checkExtensionStatus,
  };
}
