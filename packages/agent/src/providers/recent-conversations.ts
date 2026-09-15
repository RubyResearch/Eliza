/**
 * Exposes an authorized cross-platform conversation manifest with an explicit
 * storage-backed recall contract. Current dialogue stays in RECENT_MESSAGES;
 * relevant-conversations independently recalls matching historical evidence.
 * No stored record is shortened or removed. When no permitted memory-read
 * action exists, the complete authorized transcript remains inline instead.
 * Automation/page rooms are excluded and owner-private disclosure is checked
 * before identity expansion or history reads.
 */
import type {
  IAgentRuntime,
  Media,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import {
  actionGateRejection,
  buildCrossWorldConversationAccessContext,
  dedupeHygienicDialogueMessages,
  markOwnerExclusiveDisclosureUsed,
  OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
  recordOwnerExclusiveSuppression,
  revalidateOwnerExclusiveDisclosure,
  toWellFormedUnicode,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.ts";
import {
  formatRelativeTimestampPrefix,
  formatSpeakerLabel,
  roomSourceTag,
} from "../shared/conversation-format.ts";

function attachmentPromptSummary(attachments: readonly Media[]): string {
  return attachments
    .map((attachment) => {
      const label =
        attachment.filename ??
        attachment.title ??
        attachment.id ??
        "attachment";
      const mediaType = attachment.mimeType ?? attachment.contentType;
      const readableContent = attachment.text ?? attachment.description;
      return `[attachment: ${toWellFormedUnicode(label)}${mediaType ? `; ${mediaType}` : ""}${readableContent ? `; ${toWellFormedUnicode(readableContent)}` : ""}]`;
    })
    .join(" ");
}

export const recentConversationsProvider: Provider = {
  name: "recent-conversations",
  description:
    "Authorized conversation-room manifest for storage-backed cross-platform recall.",
  descriptionCompressed:
    "authorized conversation room manifest search stored cross platform history",
  dynamic: true,
  // The response router needs the recall contract before it chooses contexts,
  // including for implicit follow-ups that do not contain a recall keyword.
  alwaysInResponseState: true,
  position: 5,
  relevanceKeywords: getValidationKeywordTerms(
    "provider.recentConversations.relevance",
    {
      includeAllLocales: true,
    },
  ),
  contexts: ["memory", "messaging"],
  contextGate: { anyOf: ["memory", "messaging"] },
  cacheStable: false,
  cacheScope: "turn",
  // roleGate ADMIN is enforced by applyPluginRoleGating (#12087 Item 14); the
  // declared gate is authoritative, not the handler body.
  roleGate: { minRole: "ADMIN" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const entityId = message.entityId as UUID | undefined;
    if (!entityId) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const currentRoom = await runtime.getRoom(message.roomId);
      const currentMeta = extractConversationMetadataFromRoom(currentRoom);
      if (
        isAutomationConversationMetadata(currentMeta) ||
        isPageScopedConversationMetadata(currentMeta)
      ) {
        return { text: "", values: {}, data: {} };
      }

      // Every result from this provider can disclose another destination's
      // history. Revalidate the live audience before resolving identities or
      // reading rooms so a group/thread destination cannot probe private
      // cross-platform context through either output or query side effects.
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

      const accessContext = await buildCrossWorldConversationAccessContext(
        runtime,
        message,
      );
      const recentMessagesOwnsCurrentRoom = runtime.providers?.some(
        (provider) => provider.name?.trim().toUpperCase() === "RECENT_MESSAGES",
      );
      const roomIds = (accessContext.authorizedRoomIds ?? []).filter(
        (roomId) => !recentMessagesOwnsCurrentRoom || roomId !== message.roomId,
      );
      if (!roomIds || roomIds.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const memories = await runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds,
        accessContext,
      });
      // Share RECENT_MESSAGES source hygiene: only identical copies of the
      // same source ID collapse. Distinct connector records and repeated turns
      // keep their provenance even when their visible text is identical.
      const byRoom = new Map<string, Memory[]>();
      for (const memory of memories) {
        if (
          !(
            Boolean(memory.content.text) ||
            (memory.content.attachments?.length ?? 0) > 0
          )
        ) {
          continue;
        }
        const bucket = byRoom.get(memory.roomId) ?? [];
        bucket.push(memory);
        byRoom.set(memory.roomId, bucket);
      }
      const sorted = [...byRoom.values()]
        .flatMap((roomMemories) =>
          dedupeHygienicDialogueMessages(
            roomMemories.sort(
              (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
            ),
            runtime.agentId,
          ),
        )
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
      if (sorted.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      // Resolve room labels in one adapter read. Missing cosmetic labels do not
      // remove an authorized room from the manifest or widen disclosure.
      const roomCache = new Map<string, Room | null>();
      for (const roomId of roomIds) roomCache.set(roomId, null);
      const resultRoomIds = Array.from(roomCache.keys()) as UUID[];
      try {
        for (const room of await runtime.getRoomsByIds(resultRoomIds)) {
          if (room.id) roomCache.set(room.id, room);
        }
      } catch (error) {
        // error-policy:J4 source tags degrade to untagged while the complete
        // eligible message set remains visible and diagnostics record failure.
        runtime.reportError("RecentConversationsProvider.roomTags", error, {
          roomIds: resultRoomIds,
        });
      }

      const rooms = roomIds.map((roomId) => {
        const room = roomCache.get(roomId) ?? null;
        return {
          id: roomId,
          source: room?.source ?? null,
          name: room?.name ?? null,
          label: toWellFormedUnicode(roomSourceTag(room)),
        };
      });
      const recallAction = runtime.actions?.find((action) => {
        if (action.name !== "MEMORY_SEARCH" && action.name !== "MEMORY") {
          return false;
        }
        const rejection = actionGateRejection(action, {
          message,
          userRoles: accessContext.role ? [accessContext.role] : [],
          // This manifest tells the response router to select memory when
          // needed; context selection has not happened yet. Every other gate
          // must already admit the action, and execution rechecks all gates.
          activeContexts: ["memory"],
        });
        return rejection === undefined;
      });
      const manifestLines = [
        "Stored conversation manifest:",
        `${sorted.length} stored message(s) across ${rooms.length} authorized room(s).`,
        "This is a room index, not a summary or a claim about what was said. Full message bodies remain stored.",
        "Use current dialogue and relevant recalled evidence for continuity. If an answer needs history not already present, select the memory context and retrieve it before answering; do not guess or treat this index as empty history.",
        `Read with ${recallAction?.name ?? "MEMORY_SEARCH"}${recallAction?.name === "MEMORY" ? " action=search" : ""}, type=messages and an exact roomId below. query optionally narrows by text; omit query to read the whole room. For large results request limit and follow nextOffset/snapshot with identical filters until the needed range is complete. Never treat a page as all history.`,
        ...rooms.map((room) => `- ${room.label} roomId=${room.id}`),
      ];
      markOwnerExclusiveDisclosureUsed(message);

      const manifestText = manifestLines.join("\n");
      let text = manifestText;
      if (!recallAction) {
        const lines = [
          "Stored conversations (complete inline history; no permitted memory retrieval action is registered):",
        ];
        for (const memory of sorted) {
          const room = roomCache.get(memory.roomId) ?? null;
          const body = toWellFormedUnicode(memory.content.text ?? "");
          const attachments = attachmentPromptSummary(
            memory.content.attachments ?? [],
          );
          lines.push(
            `${roomSourceTag(room)} ${formatRelativeTimestampPrefix(memory.createdAt)}${formatSpeakerLabel(runtime, memory)}: ${[body, attachments].filter(Boolean).join(" ")}`,
          );
        }
        text = lines.join("\n");
      }
      return {
        text,
        // A missing retrieval capability must not become an overflow-time
        // permission bypass or an inaccessible body-free replacement.
        ...(recallAction ? { overflowText: manifestText } : {}),
        values: {
          recentConversationCount: sorted.length,
          recentConversationRoomCount: rooms.length,
        },
        data: { rooms },
      };
    } catch (error) {
      // error-policy:J4 recall failure degrades to no recent-conversations text,
      // but must be distinguishable from a legit-empty recall: reportError
      // surfaces the broken pipeline to the agent via RECENT_ERRORS instead of
      // it reading as "no recent history".
      runtime.reportError("RecentConversationsProvider", error, {
        entityId: message.entityId,
        roomId: message.roomId,
      });
      return { text: "", values: {}, data: {} };
    }
  },
};
