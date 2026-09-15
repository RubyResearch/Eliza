/** Exercises the real Telegram service and manager against deterministic Bot API and memory boundaries; no live messages are sent. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager.js";
import { TelegramService } from "./service.js";

function fixture(
  options: { failSend?: number; failPersistence?: number } = {},
) {
  let sent = 0;
  const memories: Memory[] = [];
  const sendMessage = vi.fn(async (chatId: string, text: string) => {
    sent++;
    if (sent === options.failSend)
      throw new Error("Synthetic lost acknowledgement");
    return {
      message_id: sent,
      date: 1700000000 + sent,
      text,
      chat: { id: Number(chatId), type: "private" },
    };
  });
  const createMemory = vi.fn(async (memory: Memory) => {
    if (memories.length + 1 === options.failPersistence)
      throw new Error("Synthetic database failure");
    memories.push(memory);
    return memory.id;
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: () => undefined,
    createMemory,
    emitEvent: vi.fn(),
    getRoom: async () => null,
  } as unknown as IAgentRuntime;
  const bot = {
    telegram: { sendMessage, sendChatAction: vi.fn(async () => undefined) },
  };
  const manager = new MessageManager(bot as never, runtime);
  const service = Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    { bot, messageManager: manager },
  );
  const send = (text: string) =>
    service.handleSendMessage(
      runtime,
      { source: "telegram", channelId: "123" },
      { text },
    );
  return { send, sendMessage, createMemory, memories };
}

describe("Telegram delivery receipts", () => {
  it("returns every provider ID and its persisted memory through the service", async () => {
    const f = fixture();
    const result = await f.send("x".repeat(5000));
    expect(result).toMatchObject({
      kind: "delivered",
      receipt: {
        providerMessageIds: ["1", "2"],
        persistence: {
          status: "persisted",
          memoryIds: f.memories.map((memory) => memory.id),
        },
      },
      memories: f.memories,
    });
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.memories.map((memory) => memory.content.text).join("")).toBe(
      "x".repeat(5000),
    );
  });

  it("retains accepted chunks after a later transport failure", async () => {
    const f = fixture({ failSend: 2 });
    expect(await f.send("x".repeat(5000))).toMatchObject({
      kind: "partially_delivered",
      receipt: {
        providerMessageIds: ["1"],
        persistence: { status: "not_attempted" },
      },
    });
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.createMemory).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "keeps provider acceptance separate from persistence failure at memory %s",
    async (failPersistence) => {
      const f = fixture({ failPersistence });
      expect(await f.send("x".repeat(5000))).toMatchObject({
        kind: "delivered",
        receipt: {
          providerMessageIds: ["1", "2"],
          persistence: { status: failPersistence === 1 ? "failed" : "partial" },
        },
      });
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
      expect(f.memories).toHaveLength(failPersistence - 1);
    },
  );

  it("does not invent provider acceptance after the first request loses its acknowledgement", async () => {
    const f = fixture({ failSend: 1 });
    await expect(f.send("Synthetic review")).rejects.toMatchObject({
      code: "TELEGRAM_OUTBOUND_SEND_FAILED",
    });
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns explicit nondelivery for empty input without calling Telegram", async () => {
    const f = fixture();
    expect(await f.send("   ")).toMatchObject({ kind: "not_delivered" });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
