/**
 * Verifies the UI iMessage client against plugin-imessage's native setup and
 * data wire contracts. Requests use a deterministic transport stub; no live
 * Messages database, Apple Automation, or personal-assistant plugin is used.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-imessage";
import type { AgentRequestTransport } from "./transport";

function makeClient(responses: Record<string, unknown>): {
  client: ElizaClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn<AgentRequestTransport["request"]>(async (url) => {
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.search}`;
    if (!(key in responses)) {
      throw new Error(`unexpected native iMessage request: ${key}`);
    }
    return Response.json(responses[key]);
  });
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request });
  return { client, request };
}

describe("ElizaClient native iMessage routes", () => {
  it("normalizes the plugin setup status without a LifeOps dependency", async () => {
    const { client, request } = makeClient({
      "/api/setup/imessage/status": {
        connector: "imessage",
        state: "paired",
        detail: {
          available: true,
          connected: true,
          chatDbAvailable: true,
          sendOnly: false,
          chatDbPath: "/Users/test/Library/Messages/chat.db",
          reason: null,
          permissionAction: null,
        },
      },
    });

    await expect(client.getIMessageStatus()).resolves.toMatchObject({
      available: true,
      connected: true,
      bridgeType: "native",
      chatDbAvailable: true,
      sendOnly: false,
      reason: null,
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/setup/imessage/status",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("preserves hosted transport and webhook status across the HTTP boundary", async () => {
    const { client } = makeClient({
      "/api/setup/imessage/status": {
        connector: "imessage",
        state: "paired",
        detail: {
          available: true,
          connected: true,
          transport: "blooio",
          chatDbAvailable: false,
          webhookPath: "/api/imessage/webhook/blooio",
          channelId: "synthetic-channel",
          permissionAction: null,
        },
      },
    });
    const status = await client.getIMessageStatus();
    expect(status.bridgeType).toBe("blooio");
    expect(status.connected).toBe(true);
    expect(status.webhookPath).toBe("/api/imessage/webhook/blooio");
    expect(status.permissionAction).toBeNull();
  });

  it("preserves native message and chat DTOs from plugin-imessage", async () => {
    const message = {
      id: "msg-1",
      text: "hello",
      handle: "+14155550123",
      chatId: "chat-1",
      timestamp: 1_776_000_000_000,
      isFromMe: false,
      hasAttachments: true,
      attachmentPaths: ["/api/media/sha.png"],
    };
    const chat = {
      chatId: "chat-1",
      chatType: "direct",
      displayName: "Alice",
      participants: [{ handle: "+14155550123", isPhoneNumber: true }],
    };
    const { client } = makeClient({
      "/api/imessage/messages?chatId=chat-1&limit=5": {
        messages: [message],
        count: 1,
      },
      "/api/imessage/chats": { chats: [chat], count: 1 },
    });

    await expect(
      client.getIMessageMessages({ chatId: "chat-1", limit: 5 }),
    ).resolves.toEqual({ messages: [message], count: 1 });
    await expect(client.listIMessageChats()).resolves.toEqual({
      chats: [chat],
      count: 1,
    });
  });

  it("sends through the native plugin route and maps the first attachment", async () => {
    const { client, request } = makeClient({
      "/api/imessage/messages": {
        success: true,
        messageId: "native-msg-1",
        chatId: "chat-1",
      },
    });

    await expect(
      client.sendIMessage({
        to: "+14155550123",
        text: "hello",
        attachmentPaths: ["/api/media/sha.png", "/api/media/ignored.png"],
      }),
    ).resolves.toEqual({
      success: true,
      messageId: "native-msg-1",
      chatId: "chat-1",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/imessage/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          to: "+14155550123",
          text: "hello",
          mediaUrl: "/api/media/sha.png",
        }),
      }),
      expect.any(Object),
    );
  });
});
