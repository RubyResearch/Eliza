/**
 * Unit coverage for the per-request fetch-timeout budgets (including the long
 * local-inference TTS/ASR budgets). Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import { defaultFetchTimeoutMs } from "./request-timeout";

describe("defaultFetchTimeoutMs", () => {
  it.each([
    "/api/conversations/conversation-123/messages/assistant-456/retry-reply",
    `/api/conversations/${encodeURIComponent("conversation/123")}/messages/${encodeURIComponent("assistant/456")}/retry-reply`,
    "http://127.0.0.1:31337/api/conversations/conversation-123/messages/assistant-456/retry-reply?attempt=1#reply",
  ])("gives reply recovery the existing chat-generation budget: %s", (path) => {
    const chatBudget = defaultFetchTimeoutMs(
      "/api/conversations/conversation-123/messages",
      { method: "POST" },
    );
    expect(chatBudget).toBe(600_000);
    expect(defaultFetchTimeoutMs(path, { method: "POST" })).toBe(chatBudget);
  });

  it.each([
    [
      "/api/conversations/conversation-123/messages/assistant-456/retry-reply",
      "GET",
    ],
    ["/api/conversations/conversation-123/messages/assistant-456", "POST"],
    [
      "/api/conversations/conversation-123/messages/assistant-456/retry",
      "POST",
    ],
    [
      "/api/conversations/conversation-123/messages/assistant-456/retry-reply/stream",
      "POST",
    ],
    [
      "/api/conversations/conversation-123/messages/assistant-456/retry-reply/extra",
      "POST",
    ],
  ])("keeps unrelated %s %s calls on the ordinary budget", (path, method) => {
    expect(defaultFetchTimeoutMs(path, { method })).toBe(10_000);
  });

  it("allows local neural TTS enough time for mobile CPU generation", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/tts/local-inference", {
        method: "POST",
      }),
    ).toBe(180_000);
  });

  it("gives the in-process agent reset time to stop the runtime", () => {
    expect(
      defaultFetchTimeoutMs("/api/agent/reset", {
        method: "POST",
      }),
    ).toBe(60_000);
  });

  it("keeps ordinary API calls on the short default timeout", () => {
    expect(
      defaultFetchTimeoutMs("http://127.0.0.1:31337/api/health", {
        method: "GET",
      }),
    ).toBe(10_000);
  });
});
