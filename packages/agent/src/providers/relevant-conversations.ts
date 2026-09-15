/**
 * Provider that recalls conversation snippets relevant to the current message,
 * re-ranked by similarity, from across all platforms. It combines a lexical
 * "hash memory" scan (mirroring the /api/memory/remember writer, so recall works
 * even when no embedding model is registered) with semantic search over the
 * shared per-turn recall-query embed; on embed failure it fails open to the
 * lexical hits alone. The two sources are independent and run concurrently, and
 * result-room tags resolve through one batched room read — this provider sits
 * on the composeState critical path of every reply, so it must not serialize
 * independent round-trips. Current-room messages are filtered out to avoid
 * echo, and hash-memory hits win on id overlap. Gated to USER.
 */
import type {
  AccessContext,
  CanonicalRecallResult,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import {
  buildAccessContext,
  embedRecallQuery,
  filterByAccessContext,
  getUserMessageText,
  markOwnerExclusiveDisclosureUsed,
  OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
  recordOwnerExclusiveSuppression,
  revalidateOwnerExclusiveDisclosure,
  searchCanonicalConversationMemories,
  stringToUuid,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.ts";
import { HASH_MEMORY_SOURCE, rankByKeyword } from "../api/memory-routes.ts";
import {
  formatRelativeTimestampPrefix,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

const MATCH_THRESHOLD = 0.7;
// rankByKeyword returns a [0,1] max-normalized BM25 score. Require a hit to be at
// least half as relevant as the best match in the scan; BM25's IDF already
// down-weights common stop words ("you"/"are"), so weak/stop-word-only matches
// score far below a real hit and fall under this floor.
const MIN_HASH_MEMORY_SCORE = 0.5;

// Only a complete standalone greeting skips optional cross-room similarity
// search. This does not route the turn or remove current-room history. Short
// substantive queries (names, IDs) and greetings followed by requests still
// use recall; unknown languages/forms conservatively keep the retrieval path.
function isStandaloneGreeting(text: string): boolean {
  return /^(?:(?:hi|hey|hello)(?: there)?|good morning|good afternoon|good evening|hola|bonjour|salut|hallo|こんにちは|你好)[\s.!！?？]*$/iu.test(
    text.trim(),
  );
}

function memoryText(memory: Memory): string {
  return typeof memory.content.text === "string" ? memory.content.text : "";
}

function memoryCreatedAt(memory: Memory): number {
  return typeof memory.createdAt === "number" ? memory.createdAt : 0;
}

// /api/memory/remember writes lexical "hash memories" into the messages table at
// a fixed room with content.source === "hash_memory" and NO embedding. When no
// TEXT_EMBEDDING model is registered (cloud agents booting without embed), the
// semantic searchMemories path never surfaces them, so mirror the writer here
// with a lexical scan + score.
async function loadHashMemories(
  runtime: IAgentRuntime,
  query: string,
  accessContext: AccessContext,
): Promise<Memory[]> {
  const agentName = runtime.character.name?.trim() || "Eliza";
  const roomId = stringToUuid(`${agentName}-hash-memory-room`) as UUID;
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    includeEmbedding: false,
    accessContext,
  });

  // Only hash memories are candidates; rank them together so BM25's IDF is
  // computed over the hash-memory corpus.
  const hashMemories = memories.filter(
    (memory) =>
      (memory.content as { source?: string } | undefined)?.source ===
      HASH_MEMORY_SOURCE,
  );

  return rankByKeyword(query, hashMemories, memoryText)
    .filter(({ score }) => score >= MIN_HASH_MEMORY_SCORE)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return memoryCreatedAt(right.item) - memoryCreatedAt(left.item);
    })
    .map(({ item }) => item);
}

export const relevantConversationsProvider: Provider = {
  name: "relevant-conversations",
  description:
    "Semantically relevant conversation snippets from across all platforms, re-ranked by similarity to the current message.",
  descriptionCompressed:
    "relevant conversation snippets across platforms; rerank by current message",
  dynamic: true,
  position: 6,
  relevanceKeywords: getValidationKeywordTerms(
    "provider.relevantConversations.relevance",
    {
      includeAllLocales: true,
    },
  ),
  contexts: ["memory", "messaging"],
  contextGate: { anyOf: ["memory", "messaging"] },
  cacheStable: false,
  cacheScope: "turn",
  alwaysInResponseState: true,
  roleGate: { minRole: "USER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const text = getUserMessageText(message);
    if (!text.trim() || isStandaloneGreeting(text)) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const currentRoom = await runtime.getRoom(message.roomId);
      if (
        isAutomationConversationMetadata(
          extractConversationMetadataFromRoom(currentRoom),
        )
      ) {
        return { text: "", values: {}, data: {} };
      }

      // Access-context resolution is required for both recall branches. If it
      // fails, the wholesale outer J4 boundary reports and suppresses the
      // provider instead of letting lexical and semantic recall disagree.
      const accessContext: AccessContext = await buildAccessContext(
        runtime,
        message,
      );

      // This provider deliberately excludes the current room below, so every
      // result it could render is a cross-room disclosure. Fail closed before
      // lexical reads or embedding work unless the live destination is a
      // revalidated owner-private audience. The canonical search repeats this
      // check as defense in depth at the storage boundary.
      const disclosure = await revalidateOwnerExclusiveDisclosure(
        runtime,
        message,
      );
      if (
        !disclosure.allowed ||
        disclosure.basis !== OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
      ) {
        if (!disclosure.allowed) {
          recordOwnerExclusiveSuppression(message, disclosure.reason);
        }
        return { text: "", values: {}, data: {} };
      }

      // The two recall sources are independent, so they run concurrently:
      // the lexical hash-memory scan overlaps the shared recall-query embed
      // and canonical semantic search instead of adding to the reply critical
      // path. Either branch still fails into the same wholesale outer degrade.
      const [hashMemories, semanticRecall] = await Promise.all([
        loadHashMemories(runtime, text, accessContext),
        (async (): Promise<CanonicalRecallResult | null> => {
          const embedding = await embedRecallQuery(runtime, text);
          if (!embedding || embedding.length === 0) return null;
          return searchCanonicalConversationMemories({
            runtime,
            embedding,
            query: text,
            agentId: runtime.agentId,
            deliveryMessage: message,
            matchThreshold: MATCH_THRESHOLD,
          });
        })(),
      ]);
      const semanticMemories =
        semanticRecall?.items.map((item) => item.memory) ?? [];

      // Filter out messages from the current conversation to avoid echo and dedupe
      // by id (hash memories prepended so they win on overlap).
      const currentRoomId = message.roomId;
      const readable = filterByAccessContext(
        [...hashMemories, ...semanticMemories],
        accessContext,
        runtime.agentId,
      );
      const filtered = readable
        .filter((m) => m.content.text && m.roomId !== currentRoomId)
        .filter(
          (memory, index, all) =>
            !memory.id ||
            all.findIndex((candidate) => candidate.id === memory.id) === index,
        );

      if (
        filtered.some(
          (memory) =>
            (memory.content as { source?: string } | undefined)?.source ===
            HASH_MEMORY_SOURCE,
        )
      ) {
        markOwnerExclusiveDisclosureUsed(message);
      }

      if (
        filtered.length === 0 &&
        semanticRecall?.availability === "unavailable"
      ) {
        return {
          text: "Relevant past conversations are unavailable because matching messages were withheld by access policy.",
          values: {
            relevantConversationCount: 0,
            relevantConversationAvailability: "unavailable",
          },
          data: {
            messages: [],
            withheld: semanticRecall.withheld,
            availability: semanticRecall.availability,
          },
        };
      }

      if (filtered.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room details for source tags in ONE batched read. The
      // per-result getRoom loop this replaces paid one adapter round-trip per
      // distinct room every turn (the runtime's room memo TTL is shorter than
      // a turn gap), serially on the compose critical path.
      const roomCache = new Map<string, Room | null>();
      const roomIds: UUID[] = [];
      for (const mem of filtered) {
        if (mem.roomId && !roomCache.has(mem.roomId)) {
          roomCache.set(mem.roomId, null);
          roomIds.push(mem.roomId);
        }
      }
      try {
        for (const room of await runtime.getRoomsByIds(roomIds)) {
          if (room.id) roomCache.set(room.id, room);
        }
      } catch (error) {
        // error-policy:J4 room source tags degrade to untagged, but the
        // cosmetic lookup failure remains visible through diagnostics.
        runtime.reportError("RelevantConversationsProvider.roomTags", error, {
          roomIds,
        });
      }

      const availability =
        semanticRecall?.availability === "partial" ||
        semanticRecall?.availability === "unavailable"
          ? "partial"
          : "complete";
      const lines: string[] = [
        availability === "partial"
          ? "Relevant past conversations (partial; some matching messages were withheld by access policy):"
          : "Relevant past conversations:",
      ];
      for (const mem of filtered) {
        const room = roomCache.get(mem.roomId) ?? null;
        const tag = roomSourceTag(room);
        const age = formatRelativeTimestampPrefix(mem.createdAt);
        const speaker = formatSpeakerLabel(runtime, mem);
        const msgText = memoryText(mem);
        lines.push(`${tag} ${age}${speaker}: ${msgText}`);
      }

      return {
        text: lines.join("\n"),
        values: {
          relevantConversationCount: filtered.length,
          relevantConversationAvailability: availability,
        },
        data: {
          messages: filtered.map((m) => ({
            id: m.id,
            roomId: m.roomId,
            entityId: m.entityId,
            text: m.content.text,
            createdAt: m.createdAt,
          })),
          withheld: semanticRecall?.withheld ?? [],
          availability,
        },
      };
    } catch (error) {
      // error-policy:J4 recall failure degrades to no relevant-conversations
      // text, but must be distinguishable from a legit-empty recall: reportError
      // surfaces the broken pipeline to the agent via RECENT_ERRORS instead of
      // it reading as "no relevant history".
      runtime.reportError("RelevantConversationsProvider", error, {
        entityId: message.entityId,
        roomId: message.roomId,
      });
      return { text: "", values: {}, data: {} };
    }
  },
};
