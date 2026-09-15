/**
 * Exercises interrupted chat receipts through the real client JSON and SSE
 * parsers with Response/ReadableStream transport fixtures; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-chat";
import type { AgentRequestTransport } from "./transport";

function makeClient(response: Response) {
  const request = vi.fn<AgentRequestTransport["request"]>(async () => response);
  const client = new ElizaClient("http://agent.example:31337", "test-token");
  client.setRequestTransport({ request });
  return { client, request };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: object[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const terminalFailure = {
  kind: "provider_issue",
  message: "Generation interrupted during shutdown.",
  transient: true,
  code: "TURN_ABORTED",
};

describe("interrupted conversation receipts", () => {
  it.each(["", "  The next step is **"])(
    "hydrates interrupted text %j without manufacturing or rewriting a reply",
    async (text) => {
      const interrupted = {
        id: "interrupted-receipt",
        role: "assistant",
        text,
        timestamp: 10,
        interrupted: true,
        failureKind: terminalFailure.kind,
        terminalFailure,
      };
      const genuine = {
        id: "model-reply",
        role: "assistant",
        text: "The files are ready.",
        timestamp: 20,
      };
      const { client, request } = makeClient(
        jsonResponse({ messages: [interrupted, genuine] }),
      );

      const result = await client.getConversationMessages("conversation-1");

      expect(result.messages).toEqual([interrupted, genuine]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[1].method ?? "GET").toBe("GET");
    },
  );

  it.each(["", "  The next step is **"])(
    "preserves interrupted JSON outcome text %j without resending",
    async (text) => {
      const receipt = {
        text,
        agentName: "Eliza",
        interrupted: true,
        failureKind: terminalFailure.kind,
        terminalFailure,
      };
      const { client, request } = makeClient(jsonResponse(receipt));

      const result = await client.sendConversationMessage(
        "conversation-1",
        "hello",
      );

      expect(result).toEqual(receipt);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "  The next step is **"])(
    "retains interrupted SSE terminal text %j and its durable identity",
    async (text) => {
      const { client, request } = makeClient(
        sseResponse([
          ...(text ? [{ type: "token", text, fullText: text }] : []),
          {
            type: "done",
            fullText: text,
            agentName: "Eliza",
            interrupted: true,
            messageId: "interrupted-receipt",
            userMessageId: "original-user-turn",
            failureKind: terminalFailure.kind,
            terminalFailure,
          },
        ]),
      );
      const onToken = vi.fn();

      const result = await client.sendConversationMessageStream(
        "conversation-1",
        "hello",
        onToken,
      );

      expect(result).toMatchObject({
        text,
        completed: true,
        interrupted: true,
        messageId: "interrupted-receipt",
        userMessageId: "original-user-turn",
        failureKind: terminalFailure.kind,
        terminalFailure,
      });
      expect(request).toHaveBeenCalledTimes(1);
      if (text) expect(onToken).toHaveBeenCalledWith(text, text, false);
      else expect(onToken).not.toHaveBeenCalled();
    },
  );

  it("retains reply recovery authority through SSE and history, and requests only the stored reply", async () => {
    const failed = {
      id: "assistant-1",
      role: "assistant",
      timestamp: 2,
      text: "The action completed but its reply failed.",
      failureKind: "provider_issue",
      replyRecoveryAvailable: true,
    };
    const streamed = makeClient(
      sseResponse([
        {
          type: "done",
          fullText: failed.text,
          messageId: failed.id,
          userMessageId: "user-1",
          failureKind: failed.failureKind,
          replyRecoveryAvailable: true,
        },
      ]),
    );
    expect(
      await streamed.client.sendConversationMessageStream(
        "conv-1",
        "create note",
        vi.fn(),
      ),
    ).toMatchObject({ messageId: failed.id, replyRecoveryAvailable: true });
    const history = makeClient(jsonResponse({ messages: [failed] }));
    expect(
      (await history.client.getConversationMessages("conv-1")).messages,
    ).toEqual([failed]);
    const recovered = {
      text: "The note is saved.",
      agentName: "Eliza",
      messageId: failed.id,
      userMessageId: "user-1",
    };
    const recovery = makeClient(jsonResponse(recovered));
    expect(
      await recovery.client.retryConversationReply("conv/1", "assistant/1"),
    ).toEqual(recovered);
    expect(recovery.request).toHaveBeenCalledTimes(1);
    const [url, init] = recovery.request.mock.calls[0];
    expect(String(url)).toContain(
      "/api/conversations/conv%2F1/messages/assistant%2F1/retry-reply",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("rejects malformed SSE recovery flags instead of advertising mutation-safe retry", async () => {
    const { client } = makeClient(
      sseResponse([
        { type: "done", fullText: "failed", replyRecoveryAvailable: "true" },
      ]),
    );
    expect(
      (await client.sendConversationMessageStream("conv", "hello", vi.fn()))
        .replyRecoveryAvailable,
    ).toBeUndefined();
  });

  it("does not treat a malformed interruption flag as a terminal interruption", async () => {
    const { client } = makeClient(
      sseResponse([{ type: "done", fullText: "", interrupted: "true" }]),
    );

    const result = await client.sendConversationMessageStream(
      "conversation-1",
      "hello",
      vi.fn(),
    );

    expect(result.interrupted).toBeUndefined();
    expect(result.text).toBe(client.normalizeAssistantText(""));
  });
});
