/**
 * Owns conversation-message deletion and truncation against the runtime
 * persistence contract. HTTP routes supply an authorized conversation and
 * translate the service's status-bearing not-found error at their boundary.
 */
import {
  type AgentRuntime,
  ElizaError,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { ConversationMeta } from "../api/server-types.ts";

type DeletableRuntime = AgentRuntime & {
  deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
  deleteMemory?: (memoryId: UUID) => Promise<unknown>;
  removeMemory?: (memoryId: UUID) => Promise<unknown>;
  adapter: AgentRuntime["adapter"] & {
    db: {
      deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
      deleteMemory?: (memoryId: UUID) => Promise<unknown>;
      removeMemory?: (memoryId: UUID) => Promise<unknown>;
    };
  };
};

function conversationMessageNotFound(): Error & { status: number } {
  return Object.assign(new Error("Conversation message not found"), {
    status: 404,
  });
}

export async function deleteConversationMemories(
  runtime: AgentRuntime,
  memoryIds: UUID[],
): Promise<number> {
  if (memoryIds.length === 0) return 0;
  const deletable = runtime as DeletableRuntime;
  // The canonical runtime boundary also retires derived source evidence and
  // invalidates room reads. A direct adapter delete bypasses those guarantees.
  if (typeof runtime.deleteMemories === "function") {
    await runtime.deleteMemories(memoryIds);
    return memoryIds.length;
  }
  if (typeof deletable.deleteManyMemories === "function") {
    await deletable.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }
  if (typeof deletable.adapter.db.deleteManyMemories === "function") {
    await deletable.adapter.db.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }

  if (memoryIds.length > 1) {
    throw Object.assign(
      new ElizaError(
        "Atomic conversation message deletion is not supported by this adapter",
        { code: "CONVERSATION_BULK_DELETE_UNAVAILABLE" },
      ),
      { status: 501 },
    );
  }

  for (const memoryId of memoryIds) {
    if (typeof deletable.deleteMemory === "function") {
      await deletable.deleteMemory(memoryId);
    } else if (typeof deletable.removeMemory === "function") {
      await deletable.removeMemory(memoryId);
    } else if (typeof deletable.adapter.db.deleteMemory === "function") {
      await deletable.adapter.db.deleteMemory(memoryId);
    } else if (typeof deletable.adapter.db.removeMemory === "function") {
      await deletable.adapter.db.removeMemory(memoryId);
    } else {
      throw Object.assign(
        new Error("Conversation message deletion is not supported"),
        { status: 501 },
      );
    }
  }
  return memoryIds.length;
}

const CONVERSATION_SCAN_PAGE_SIZE = 500;

function memoryCursor(memory: Memory): { createdAt: number; id: UUID } {
  if (
    typeof memory.id !== "string" ||
    memory.id.length === 0 ||
    !Number.isFinite(memory.createdAt)
  ) {
    throw new ElizaError("Conversation traversal returned an unpageable row", {
      code: "CONVERSATION_TRAVERSAL_INVALID_ROW",
    });
  }
  return { createdAt: memory.createdAt as number, id: memory.id };
}

function cursorFollows(
  next: { createdAt: number; id: UUID },
  previous: { createdAt: number; id: UUID },
): boolean {
  return (
    next.createdAt > previous.createdAt ||
    (next.createdAt === previous.createdAt && next.id > previous.id)
  );
}

async function getCompleteConversationMemories(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<Memory[]> {
  const complete: Memory[] = [];
  let cursor: { createdAt: number; id: UUID } | undefined;

  while (true) {
    const page = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: CONVERSATION_SCAN_PAGE_SIZE,
      orderBy: "createdAt",
      orderDirection: "asc",
      ...(cursor ? { cursor } : {}),
    });
    if (page.length > CONVERSATION_SCAN_PAGE_SIZE) {
      throw new ElizaError(
        "Conversation traversal exceeded its requested page",
        {
          code: "CONVERSATION_TRAVERSAL_INVALID_PAGE",
          context: {
            requested: CONVERSATION_SCAN_PAGE_SIZE,
            received: page.length,
          },
        },
      );
    }
    for (const memory of page) {
      const next = memoryCursor(memory);
      if (cursor && !cursorFollows(next, cursor)) {
        throw new ElizaError("Conversation traversal did not advance", {
          code: "CONVERSATION_TRAVERSAL_UNSTABLE",
          context: { previousId: cursor.id, nextId: next.id },
        });
      }
      complete.push(memory);
      cursor = next;
    }
    if (page.length < CONVERSATION_SCAN_PAGE_SIZE) return complete;
  }
}

export async function deleteConversationMessage(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
): Promise<{ deletedCount: number }> {
  const [memory] = await runtime.getMemoriesByIds(
    [messageId as UUID],
    "messages",
  );
  // A cross-room id is indistinguishable from absence so callers cannot use
  // this endpoint to confirm foreign message existence.
  if (!memory || memory.roomId !== conversation.roomId) {
    throw conversationMessageNotFound();
  }
  return {
    deletedCount: await deleteConversationMemories(runtime, [
      messageId as UUID,
    ]),
  };
}

export async function truncateConversationMessages(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
  options?: { inclusive?: boolean },
): Promise<{ deletedCount: number }> {
  const memories = await getCompleteConversationMemories(
    runtime,
    conversation.roomId,
  );
  const targetIndex = memories.findIndex((memory) => memory.id === messageId);
  if (targetIndex < 0) throw conversationMessageNotFound();
  const start = options?.inclusive === true ? targetIndex : targetIndex + 1;
  const memoryIds = memories
    .slice(start)
    .map((memory) => memory.id)
    .filter(
      (memoryId): memoryId is UUID =>
        typeof memoryId === "string" && memoryId.trim().length > 0,
    );
  return {
    deletedCount: await deleteConversationMemories(runtime, memoryIds),
  };
}
