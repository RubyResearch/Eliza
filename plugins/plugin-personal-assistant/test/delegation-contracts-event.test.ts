/**
 * Connector-event coverage for delegation contracts.
 *
 * Real connector-shaped memories prove transport metadata reaches the existing
 * durable delegation processor without teaching connectors LifeOps policy.
 */
import type { IAgentRuntime, Memory, MessagePayload } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "../src/lifeops/approval-queue.types.js";
import {
  createDelegationInboundMessageHandler,
  delegationInboundTurnFromMessage,
} from "../src/lifeops/delegation-contracts/inbound-event.js";
import type {
  DelegationContractRepository,
  DelegationInboundProcessingResult,
} from "../src/lifeops/delegation-contracts/index.js";

const ENTITY_ID = "00000000-0000-0000-0000-000000001856";
const ROOM_ID = "00000000-0000-0000-0000-000000001857";

function message(overrides: Partial<Memory> = {}): Memory {
  return {
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    createdAt: Date.parse("2026-07-09T18:00:00.000Z"),
    content: { text: "The price is too high; procurement needs a discount." },
    metadata: {
      type: "message",
      source: "telegram",
      sender: { id: "vendor-1", name: "Riley Vendor" },
      telegram: {
        userId: "vendor-1",
        chatId: "vendor-chat",
        threadId: "renewal-thread",
      },
    },
    ...overrides,
  } as Memory;
}

describe("delegation connector event normalization", () => {
  it("maps a Telegram topic to its contract thread", () => {
    expect(delegationInboundTurnFromMessage(message())).toEqual({
      channel: "telegram",
      threadId: "renewal-thread",
      sender: "Riley Vendor",
      text: "The price is too high; procurement needs a discount.",
      receivedAt: "2026-07-09T18:00:00.000Z",
    });
  });

  it("maps Gmail aliases and sender-class metadata for SLA contracts", () => {
    expect(
      delegationInboundTurnFromMessage(
        message({
          content: {
            text: "Can you send the latest numbers?",
            source: "gmail",
            metadata: {
              senderEmail: "dana@board.example",
              senderClass: "board_member",
              subject: "Quarterly update",
              threadId: "thread-board-1",
            },
          },
          metadata: { type: "message", source: "gmail" },
        }),
      ),
    ).toEqual({
      channel: "email",
      threadId: "thread-board-1",
      sender: ENTITY_ID,
      senderEmail: "dana@board.example",
      senderClass: "board_member",
      subject: "Quarterly update",
      text: "Can you send the latest numbers?",
      receivedAt: "2026-07-09T18:00:00.000Z",
    });
  });

  it("ignores in-app messages that cannot match connector contracts", () => {
    expect(
      delegationInboundTurnFromMessage(
        message({
          content: { text: "hello", source: "client_chat" },
          metadata: { type: "message", source: "client_chat" },
        }),
      ),
    ).toBeNull();
  });

  it("hands connector messages to the durable policy processor", async () => {
    const repository: DelegationContractRepository = {
      listDelegationContracts: vi.fn(async () => []),
      upsertDelegationContract: vi.fn(async () => undefined),
    };
    const approvalQueue: ApprovalQueue = {
      capability: "eliza.approval-execution",
      protocolVersion: 2,
      enqueue: vi.fn(),
      list: vi.fn(),
      byId: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      claimExecution: vi.fn(),
      markDispatchStarted: vi.fn(),
      markDone: vi.fn(),
      markRetryableFailure: vi.fn(),
      markReconciliationRequired: vi.fn(),
      recoverUnstartedExecution: vi.fn(),
      reconcileExecution: vi.fn(),
      markExpired: vi.fn(),
      removePending: vi.fn(),
      purgeExpired: vi.fn(),
    };
    const processingResult: DelegationInboundProcessingResult = {
      evaluations: [],
      enqueuedApprovals: [],
    };
    const processTurn = vi.fn(async () => processingResult);
    const handler = createDelegationInboundMessageHandler({
      createRepository: () => repository,
      createApprovalQueue: () => approvalQueue,
      processTurn,
      now: () => new Date("2026-07-09T18:01:00.000Z"),
    });
    const payload: MessagePayload = {
      runtime: { agentId: ENTITY_ID } as IAgentRuntime,
      message: message(),
      source: "test",
    };
    await handler(payload);
    expect(processTurn).toHaveBeenCalledWith({
      agentId: ENTITY_ID,
      turn: delegationInboundTurnFromMessage(message()),
      nowIso: "2026-07-09T18:01:00.000Z",
      repository,
      approvalQueue,
      resolveEmailSender: expect.any(Function),
    });
  });

  it("does not allocate adapters for non-connector chat", async () => {
    const createRepository = vi.fn();
    const createApprovalQueue = vi.fn();
    const processTurn = vi.fn();
    const handler = createDelegationInboundMessageHandler({
      createRepository,
      createApprovalQueue,
      processTurn,
    });

    await handler({
      runtime: { agentId: ENTITY_ID } as IAgentRuntime,
      message: message({
        content: { text: "hello", source: "client_chat" },
        metadata: { type: "message", source: "client_chat" },
      }),
      source: "test",
    });
    expect(createRepository).not.toHaveBeenCalled();
    expect(createApprovalQueue).not.toHaveBeenCalled();
    expect(processTurn).not.toHaveBeenCalled();
  });

  it("fails fast when connector metadata omits message time", () => {
    expect(() =>
      delegationInboundTurnFromMessage(
        message({
          createdAt: undefined,
          metadata: { type: "message", source: "telegram" },
        }),
      ),
    ).toThrow("connector message has no timestamp");
  });
});
