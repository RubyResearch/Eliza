/** Exercises hosted identity verification and service heartbeat recovery through a controlled HTTP boundary. */
import type { IAgentRuntime, TaskWorker } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { verifyBlooioChannel } from "./blooio-readiness.js";
import { IMessageService } from "./service.js";

const input = { apiKey: "test-key", fromNumber: "+15550000001", channelId: "ch_test" };
const valid = () => Response.json({ data: { channel_id: input.channelId, type: "blooio" } });
afterEach(() => vi.unstubAllGlobals());

it("verifies the sender number resolves to the expected channel without sending", async () => {
  const request = vi.fn().mockResolvedValue(valid());
  vi.stubGlobal("fetch", request);
  await verifyBlooioChannel(input);
  expect(request).toHaveBeenCalledWith(
    "https://api.blooio.com/v4/channels/%2B15550000001/settings",
    expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer test-key" } })
  );
});
it.each([401, 403, 404, 500])("rejects provider HTTP %s", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private provider detail", { status }))
  );
  await expect(verifyBlooioChannel(input)).rejects.toMatchObject({
    code: "BLOOIO_CHANNEL_ACCESS_DENIED",
  });
});
it.each([
  { data: { channel_id: "ch_other", type: "blooio" } },
  { data: { channel_id: "ch_test", type: "twilio" } },
  {},
])("rejects an unverified sender identity", async (payload) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
  await expect(verifyBlooioChannel(input)).rejects.toMatchObject({
    code: "BLOOIO_CHANNEL_IDENTITY_MISMATCH",
  });
});
it("rejects invalid JSON", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid")));
  await expect(verifyBlooioChannel(input)).rejects.toMatchObject({
    code: "BLOOIO_CHANNEL_RESPONSE_INVALID",
  });
});
it("preserves transport failure", async () => {
  const cause = new Error("offline");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
  await expect(verifyBlooioChannel(input)).rejects.toMatchObject({
    code: "BLOOIO_CHANNEL_UNAVAILABLE",
    cause,
  });
});

function harness() {
  const workers = new Map<string, TaskWorker>();
  const settings: Record<string, string> = {
    IMESSAGE_TRANSPORT: "blooio",
    IMESSAGE_BLOOIO_API_KEY: input.apiKey,
    IMESSAGE_BLOOIO_FROM_NUMBER: input.fromNumber,
    IMESSAGE_BLOOIO_CHANNEL_ID: input.channelId,
    IMESSAGE_BLOOIO_WEBHOOK_SECRET: "test-signing-secret",
    IMESSAGE_BACKFILL: "0",
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) => settings[key],
    registerTaskWorker: (worker: TaskWorker) => workers.set(worker.name, worker),
    getTaskWorker: (name: string) => workers.get(name),
    getTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue("task"),
    emitEvent: vi.fn(),
    reportError: vi.fn(),
  };
  return { runtime: runtime as unknown as IAgentRuntime, workers, emitEvent: runtime.emitEvent };
}
it("does not announce connection readiness when credentials fail", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  const { runtime, emitEvent } = harness();
  await expect(IMessageService.start(runtime)).rejects.toMatchObject({
    code: "BLOOIO_CHANNEL_ACCESS_DENIED",
  });
  expect(emitEvent).not.toHaveBeenCalled();
});
it("marks failed credentials disconnected and recovers on the existing heartbeat", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(valid())
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(valid())
  );
  const { runtime, workers } = harness();
  const service = await IMessageService.start(runtime);
  expect(service.getStatus().connected).toBe(true);
  const heartbeat = workers.get("IMESSAGE_HEARTBEAT");
  if (!heartbeat) throw new Error("heartbeat missing");
  await heartbeat.execute(runtime, {}, { name: "IMESSAGE_HEARTBEAT" });
  expect(service.getStatus()).toMatchObject({
    connected: false,
    reason: expect.stringContaining("Blooio rejected"),
  });
  await heartbeat.execute(runtime, {}, { name: "IMESSAGE_HEARTBEAT" });
  expect(service.getStatus()).toMatchObject({ connected: true, reason: null });
});
