/** Verifies conversation deletion ownership and storage delegation without HTTP. */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  deleteConversationMemories,
  deleteConversationMessage,
  truncateConversationMessages,
} from "./conversation-message-service.ts";

const roomId = "00000000-0000-4000-8000-000000000001" as UUID;
const conversation = { id: "conversation", roomId } as Parameters<
  typeof deleteConversationMessage
>[1];

function runtime(methods: Record<string, unknown>): AgentRuntime {
  return {
    adapter: { db: {} },
    ...methods,
  } as unknown as AgentRuntime;
}

function message(index: number): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
    roomId,
    createdAt: index,
    content: { text: `message ${index}` },
  } as Memory;
}

describe("conversation message service", () => {
  it("uses the runtime mutation boundary ahead of a direct legacy adapter delete", async () => {
    const ids = [message(1).id as UUID, message(2).id as UUID];
    const deleteMemories = vi.fn(async () => undefined);
    const deleteManyMemories = vi.fn(async () => undefined);
    await deleteConversationMemories(
      runtime({ deleteMemories, deleteManyMemories }),
      ids,
    );
    expect(deleteMemories).toHaveBeenCalledWith(ids);
    expect(deleteManyMemories).not.toHaveBeenCalled();
  });

  it("uses the runtime bulk deletion contract", async () => {
    const deleteManyMemories = vi.fn(async () => undefined);
    const ids = ["00000000-0000-4000-8000-000000000002" as UUID];
    await expect(
      deleteConversationMemories(runtime({ deleteManyMemories }), ids),
    ).resolves.toBe(1);
    expect(deleteManyMemories).toHaveBeenCalledWith(ids);
  });

  it("does not reveal whether a message belongs to another room", async () => {
    const foreign = {
      id: "00000000-0000-4000-8000-000000000003" as UUID,
      roomId: "00000000-0000-4000-8000-000000000004" as UUID,
    } as Memory;
    const target = runtime({ getMemoriesByIds: async () => [foreign] });
    await expect(
      deleteConversationMessage(target, conversation, String(foreign.id)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("truncates only messages after the selected pivot", async () => {
    const ids = [2, 3, 4].map(
      (suffix) => `00000000-0000-4000-8000-00000000000${suffix}` as UUID,
    );
    const deleteManyMemories = vi.fn(async () => undefined);
    const target = runtime({
      deleteManyMemories,
      getMemories: async () =>
        ids.map((id, index) => ({ id, roomId, createdAt: index + 1 })),
    });
    await expect(
      truncateConversationMessages(target, conversation, ids[1]),
    ).resolves.toEqual({ deletedCount: 1 });
    expect(deleteManyMemories).toHaveBeenCalledWith([ids[2]]);
  });

  it("traverses every page before deleting a suffix beyond 1,000 messages", async () => {
    const messages = Array.from({ length: 1_205 }, (_, index) =>
      message(index + 1),
    );
    const deleteManyMemories = vi.fn(async () => undefined);
    const getMemories = vi.fn(
      async ({
        cursor,
        limit,
      }: {
        cursor?: { createdAt: number };
        limit: number;
      }) => {
        const start = cursor
          ? messages.findIndex(
              (entry) => entry.createdAt === cursor.createdAt,
            ) + 1
          : 0;
        return messages.slice(start, start + limit);
      },
    );
    const target = runtime({ deleteManyMemories, getMemories });

    await expect(
      truncateConversationMessages(
        target,
        conversation,
        String(messages[999]?.id),
      ),
    ).resolves.toEqual({ deletedCount: 205 });
    expect(getMemories).toHaveBeenCalledTimes(3);
    expect(deleteManyMemories).toHaveBeenCalledWith(
      messages.slice(1_000).map((entry) => entry.id),
    );
  });

  it("rejects a non-advancing adapter before deleting anything", async () => {
    const page = Array.from({ length: 500 }, (_, index) => message(index + 1));
    const deleteManyMemories = vi.fn(async () => undefined);
    const target = runtime({
      deleteManyMemories,
      getMemories: vi.fn(async () => page),
    });

    await expect(
      truncateConversationMessages(target, conversation, String(page[0]?.id)),
    ).rejects.toMatchObject({ code: "CONVERSATION_TRAVERSAL_UNSTABLE" });
    expect(deleteManyMemories).not.toHaveBeenCalled();
  });

  it("requires a bulk deletion contract for multi-message suffixes", async () => {
    const target = runtime({
      getMemories: async () => [message(1), message(2), message(3)],
    });
    await expect(
      truncateConversationMessages(target, conversation, String(message(1).id)),
    ).rejects.toMatchObject({
      code: "CONVERSATION_BULK_DELETE_UNAVAILABLE",
      status: 501,
    });
  });
});
