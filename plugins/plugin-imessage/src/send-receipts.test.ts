/** Exercises real service chunking and Blooio parsing with a deterministic HTTP boundary; no native messages are sent. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

function fixture(transport: "blooio" | "native" = "blooio") {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new IMessageService(runtime);
  const internal = service as unknown as {
    settings: IMessageSettings;
    runAppleScript: (script: string) => Promise<string>;
  };
  internal.settings = {
    transport,
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60000,
    dmPolicy: "open",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    blooioApiKey: "synthetic-api-key",
    blooioWebhookSecret: "synthetic-secret",
    blooioFromNumber: "+15551234567",
    blooioChannelId: "ch_synthetic",
  };
  internal.runAppleScript = vi.fn(async () => "");
  return { service, internal };
}
afterEach(() => vi.unstubAllGlobals());

it("retains the provider receipt instead of replacing it with a timestamp", async () => {
  const send = vi.fn(
    async () => new Response(JSON.stringify({ id: "provider-message-1" }), { status: 200 })
  );
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "Synthetic review")).toMatchObject({
    success: true,
    messageId: "provider-message-1",
    messageIds: ["provider-message-1"],
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains every accepted chunk receipt in send order", async () => {
  let sequence = 0;
  const send = vi.fn(
    async () => new Response(JSON.stringify({ id: `provider-part-${++sequence}` }), { status: 200 })
  );
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "x".repeat(4001))).toMatchObject({
    success: true,
    messageId: "provider-part-2",
    messageIds: ["provider-part-1", "provider-part-2"],
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it("preserves accepted chunk evidence when a later chunk fails", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "accepted-part" }), { status: 200 }))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "x".repeat(4001))).toMatchObject({
    success: false,
    messageIds: ["accepted-part"],
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not invent a provider receipt for native automation acceptance", async () => {
  const { service, internal } = fixture("native");
  const result = await service.sendMessage("+15557654321", "Synthetic review");
  expect(result.success).toBe(true);
  expect(result.messageId).toBeUndefined();
  expect(internal.runAppleScript).toHaveBeenCalledTimes(1);
});
