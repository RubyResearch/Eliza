/**
 * Contract coverage for the loopback local-runtime adapter used by the real
 * voice-session harness; the downstream fetch is captured without a model.
 */

import { describe, expect, test } from "bun:test";
import {
  LOCAL_VOICE_RUNTIME_AGENT_HEADER,
  LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER,
  REALTIME_VOICE_CLIENT_TRANSPORT,
} from "@elizaos/shared";
import { streamElizaConversation } from "../../../../../shared/src/lib/voice-session/eliza-sse-bridge";
import {
  createLocalRuntimeConversationFetch,
  LocalRuntimeConversationFetchError,
} from "../lib/local-runtime-conversation-fetch";

const SCOPE = {
  agentId: "agent-a",
  conversationId: "11111111-1111-4111-8111-111111111111",
};

describe("local runtime conversation fetch", () => {
  test("rewrites the cloud route to canonical local SSE without cloud credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return new Response('event: done\ndata: {"text":"ok"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
      downstream,
    );

    const response = await bridge(
      "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream",
      {
        method: "POST",
        redirect: "follow",
        signal,
        headers: {
          Authorization: "Bearer cloud-secret",
          "X-Service-Key": "Bearer cloud-secret",
          "X-Eliza-Organization-Id": "org-a",
          "X-Eliza-User-Id": "user-a",
          "X-Eliza-Voice-Trace-Id": "trace-a",
          "X-Eliza-Trace-Id": "trace-a",
          [LOCAL_VOICE_RUNTIME_AGENT_HEADER]: "spoofed-agent",
          [LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER]: "spoofed-conversation",
          Cookie: "session=cloud-secret",
          "X-Future-Cloud-Secret": "must-not-cross-loopback",
          "X-ElizaOS-Client-Id": "wrong-renderer-header",
        },
        body: JSON.stringify({
          text: "hello locally",
          messageRole: "system",
          clientMessageId: "twilio-call:CA123:started",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
            uiViewPath: "/notes",
            uiTimeZone: "America/New_York",
            uiClientId: "ui-speaking-seeker",
            uiViewActionNames: ["UNTRUSTED_ACTION"],
          },
          streamProtocol: "delta-v2",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:31337/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream",
    );
    expect(calls[0]?.init?.signal).toBe(signal);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "hello locally",
      channelType: "VOICE_DM",
      messageRole: "system",
      clientMessageId: "twilio-call:CA123:started",
      metadata: {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
        uiViewPath: "/notes",
        uiTimeZone: "America/New_York",
      },
      streamProtocol: "delta-v2",
    });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-ElizaOS-Client-Id")).toBe("ui-speaking-seeker");
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Service-Key")).toBe(false);
    expect(headers.has("X-Eliza-Organization-Id")).toBe(false);
    expect(headers.has("X-Eliza-User-Id")).toBe(false);
    expect(headers.has("Cookie")).toBe(false);
    expect(headers.has("X-Future-Cloud-Secret")).toBe(false);
    expect(headers.get("X-Eliza-Voice-Trace-Id")).toBe("trace-a");
    expect(headers.get("X-Eliza-Trace-Id")).toBe("trace-a");
    expect(headers.get(LOCAL_VOICE_RUNTIME_AGENT_HEADER)).toBe(SCOPE.agentId);
    expect(headers.get(LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER)).toBe(
      SCOPE.conversationId,
    );
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  test("preserves provisional delta-v2 authority through the loopback adapter", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        [
          `data: ${JSON.stringify({
            type: "token",
            text: "Changed ",
            provisional: true,
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "token",
            text: "to warm.",
            fullText: "Changed to warm.",
            provisional: true,
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "token",
            fullText: "Okay, I changed my personality to warm.",
          })}\n\n`,
          `data: ${JSON.stringify({
            type: "done",
            fullText: "Okay, I changed my personality to warm.",
          })}\n\n`,
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const deltas: string[] = [];

    const result = await streamElizaConversation(
      {
        endpoint: "https://cloud.example",
        authorization: "Bearer local-secret",
        model: "m",
        transcript: "make your personality warmer",
        agentId: "agent-a",
        conversationId: "11111111-1111-4111-8111-111111111111",
        traceId: "trace-provisional-loopback",
        signal: new AbortController().signal,
        fetchImpl: createLocalRuntimeConversationFetch(
          "http://127.0.0.1:31337",
          SCOPE,
          downstream,
        ),
      },
      (delta) => deltas.push(delta),
    );

    expect(result).toEqual({ completed: true, aborted: false });
    expect(deltas).toEqual(["Okay, I changed my personality to warm."]);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:31337/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream",
        body: {
          text: "make your personality warmer",
          channelType: "VOICE_DM",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        },
      },
    ]);
  });

  test.each(["https://api.example.com", "http://localhost:31337"])(
    "rejects a non-literal loopback origin before downstream fetch: %s",
    (origin) => {
      expect(() => createLocalRuntimeConversationFetch(origin, SCOPE)).toThrow(
        LocalRuntimeConversationFetchError,
      );
    },
  );

  test("rejects unsupported upstream paths", async () => {
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
    );
    await expect(
      bridge("https://cloud.example/not-a-conversation", {
        method: "POST",
        body: JSON.stringify({
          text: "hello",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
  });

  test("rejects non-POST requests before downstream fetch", async () => {
    let calls = 0;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
      (async () => {
        calls += 1;
        return new Response();
      }) as unknown as typeof fetch,
    );
    const url =
      "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream";

    await expect(
      bridge(url, {
        method: "GET",
        body: JSON.stringify({
          text: "hello",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      }),
    ).rejects.toThrow("requires POST");
    expect(calls).toBe(0);
  });

  test.each([
    {
      text: "",
      metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
    },
    {
      text: "   ",
      metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
    },
    {
      text: 42,
      metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
    },
    { text: "hello" },
    { text: "hello", metadata: { clientTransport: "browser-chat" } },
    ...[
      "",
      "other renderer",
      "ui-a\r\nAuthorization:x",
      "x".repeat(129),
      7,
    ].map((uiClientId) => ({
      text: "hello",
      metadata: {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
        uiClientId,
      },
    })),
  ])(
    "rejects invalid text or transport metadata before downstream fetch",
    async (fields) => {
      let calls = 0;
      const bridge = createLocalRuntimeConversationFetch(
        "http://127.0.0.1:31337",
        SCOPE,
        (async () => {
          calls += 1;
          return new Response();
        }) as unknown as typeof fetch,
      );
      const url =
        "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream";

      await expect(
        bridge(url, {
          method: "POST",
          body: JSON.stringify({ ...fields, streamProtocol: "delta-v2" }),
        }),
      ).rejects.toBeInstanceOf(LocalRuntimeConversationFetchError);
      expect(calls).toBe(0);
    },
  );

  test("rejects malformed or empty conversation bodies", async () => {
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
    );
    const url =
      "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream";

    await expect(
      bridge(url, { method: "POST", body: "{nope" }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({
          text: "",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({
          text: "hello",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
          streamProtocol: "legacy",
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
  });

  test.each([
    { messageRole: "user" },
    { messageRole: null },
    { clientMessageId: "" },
    { clientMessageId: " leading-space" },
    { clientMessageId: "trailing-space " },
    { clientMessageId: "x".repeat(129) },
    { clientMessageId: 42 },
  ])(
    "rejects noncanonical lifecycle fields before downstream fetch",
    async (field) => {
      let calls = 0;
      const bridge = createLocalRuntimeConversationFetch(
        "http://127.0.0.1:31337",
        SCOPE,
        (async () => {
          calls += 1;
          return new Response();
        }) as unknown as typeof fetch,
      );
      const url =
        "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream";
      await expect(
        bridge(url, {
          method: "POST",
          body: JSON.stringify({
            text: "opening lifecycle event",
            ...field,
            metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
            streamProtocol: "delta-v2",
          }),
        }),
      ).rejects.toBeInstanceOf(LocalRuntimeConversationFetchError);
      expect(calls).toBe(0);
    },
  );

  test.each([
    "https://127.0.0.1:31337",
    "http://127.0.0.1:31337/path",
    "http://user@127.0.0.1:31337",
    "http://127.0.0.1.evil:31337",
    " http://127.0.0.1:31337",
  ])(
    "rejects noncanonical target origin before downstream fetch: %s",
    (origin) => {
      let calls = 0;
      const downstream = (async () => {
        calls += 1;
        return new Response();
      }) as unknown as typeof fetch;
      expect(() =>
        createLocalRuntimeConversationFetch(origin, SCOPE, downstream),
      ).toThrow(LocalRuntimeConversationFetchError);
      expect(calls).toBe(0);
    },
  );

  test.each([
    "https://cloud.example/api/v1/eliza/agents/other-agent/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream",
    "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/22222222-2222-4222-8222-222222222222/messages/stream",
  ])(
    "rejects an upstream identity outside the startup scope: %s",
    async (url) => {
      let calls = 0;
      const bridge = createLocalRuntimeConversationFetch(
        "http://127.0.0.1:31337",
        SCOPE,
        (async () => {
          calls += 1;
          return new Response();
        }) as unknown as typeof fetch,
      );
      await expect(
        bridge(url, {
          method: "POST",
          body: JSON.stringify({
            text: "hello",
            metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
            streamProtocol: "delta-v2",
          }),
        }),
      ).rejects.toThrow("bound runtime identity");
      expect(calls).toBe(0);
    },
  );
});
