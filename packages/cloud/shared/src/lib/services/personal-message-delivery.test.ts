/**
 * Exercises normalized personal connector delivery with mocked runtime edges,
 * proving Shared fallback and active Dedicated selection.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";

let dedicatedTarget: {
  id: string;
  status: "running" | "stopped" | "sleeping" | "provisioning";
  bridge_url: string;
} | null = null;
const findActivePersonalDedicatedTarget = mock(async () => dedicatedTarget);
const sharedRestMessageSend = mock(async () => ({ text: "Shared reply", agentName: "Eliza" }));
const bridge = mock(async () => ({ result: { text: "Dedicated reply" } }));

mock.module("./agent-tier-upgrade-target", () => ({ findActivePersonalDedicatedTarget }));
mock.module("./shared-runtime/personal-shared-agent", () => ({
  personalSharedAgent: () => ({
    id: "personal-shared-agent",
    agent_name: "Eliza",
  }),
}));
mock.module("./shared-runtime/shared-rest-adapter", () => ({ sharedRestMessageSend }));
mock.module("./shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory: mock(async () => []),
}));
mock.module("./eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge,
    importCanonicalConversation: mock(async () => null),
  },
}));

const { deliverPersonalTextMessage } = await import("./personal-message-delivery");

const base = {
  account: {
    user: { id: "personal-user" },
    organization: { id: "personal-org" },
  },
  message: "hello",
  messageId: "x-dm:501",
  platform: "x",
  senderName: "Alice",
  env: {},
  executionCtx: { waitUntil: mock() },
  namespace: { getByName: mock(() => ({ fetch: mock() })) },
} as never;

describe("deliverPersonalTextMessage", () => {
  beforeEach(() => {
    dedicatedTarget = null;
    sharedRestMessageSend.mockClear();
    bridge.mockClear();
  });

  test("uses the rowless personal Shared runtime when no Dedicated target exists", async () => {
    const result = await deliverPersonalTextMessage(base);

    expect(result).toMatchObject({
      success: true,
      identity: { id: "personal-shared-agent", runtime: "shared" },
      reply: "Shared reply",
    });
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend.mock.calls[0]?.[9]).toBe("hello");
    expect(sharedRestMessageSend.mock.calls[0]?.[10]).toEqual({
      type: ChannelType.DM,
      source: "x",
    });
    expect(bridge).not.toHaveBeenCalled();
  });

  test("uses the active personal Dedicated runtime when present", async () => {
    dedicatedTarget = {
      id: "dedicated-agent",
      status: "running",
      bridge_url: "https://dedicated.example.test",
    };
    const result = await deliverPersonalTextMessage(base);

    expect(result).toMatchObject({
      success: true,
      identity: {
        id: "personal-shared-agent",
        runtime: "dedicated",
        activeAgentId: "dedicated-agent",
      },
      reply: "Dedicated reply",
    });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });
  for (const status of ["stopped", "sleeping"] as const) {
    test(`${status} Dedicated requires explicit app start without bridge or Shared fallback`, async () => {
      dedicatedTarget = { id: "dedicated-agent", status, bridge_url: "" };
      const result = await deliverPersonalTextMessage(base);
      expect(result).toMatchObject({
        success: false,
        status: 428,
        code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
        retryable: false,
      });
      expect(bridge).not.toHaveBeenCalled();
      expect(sharedRestMessageSend).not.toHaveBeenCalled();
    });
  }

  test("an already provisioning Dedicated target remains retryable without delivering", async () => {
    dedicatedTarget = { id: "dedicated-agent", status: "provisioning", bridge_url: "" };
    const result = await deliverPersonalTextMessage(base);
    expect(result).toMatchObject({
      success: false,
      status: 503,
      code: "dedicated_starting",
      retryable: true,
      retryAfterSeconds: 5,
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });
});
