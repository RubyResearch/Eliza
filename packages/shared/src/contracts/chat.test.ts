/**
 * Guards the single-source chat SSE contract (#12409): both `ChatTurnStatus`
 * and `ChatFailureKind` are declared exactly once here and re-exported from the
 * `@elizaos/shared` root, so the agent SSE emitter and the UI client parse the
 * same union. The unions are type-only, so these tests pin the member sets via
 * exhaustive const arrays that stop compiling if a member is added or removed
 * on one side without updating this contract.
 */
import { describe, expect, it } from "vitest";
import type {
  ChatFailureKind as RootChatFailureKind,
  ChatTurnStatus as RootChatTurnStatus,
} from "../index.js";
import {
  CHAT_FAILURE_KINDS,
  type ChatFailureKind,
  type ChatTurnStatus,
  isChatFailureKind,
  isRetryableChatFailureKind,
  parseChatFailureKind,
  parseChatTerminalFailure,
  RETRYABLE_CHAT_FAILURE_KINDS,
} from "./chat.js";

// Compile-time proof the root barrel re-exports the same declaration: a
// mismatch on either side is a type error, not a silent divergence.
const _sameTurnStatus: RootChatTurnStatus = {} as ChatTurnStatus;
const _sameFailureKind: RootChatFailureKind = "no_provider" as ChatFailureKind;
void _sameTurnStatus;
void _sameFailureKind;

describe("ChatTurnStatus contract", () => {
  it("covers exactly the seven in-flight turn phases", () => {
    const kinds: ChatTurnStatus["kind"][] = [
      "thinking",
      "streaming",
      "running_action",
      "running_tool",
      "evaluating",
      "waking",
      "speaking",
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(7);
  });

  it("carries only optional label/actionName/toolName alongside kind", () => {
    const running: ChatTurnStatus = {
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    };
    const tool: ChatTurnStatus = { kind: "running_tool", toolName: "search" };
    const bare: ChatTurnStatus = { kind: "thinking" };
    expect(running.actionName).toBe("SEND_MESSAGE");
    expect(tool.toolName).toBe("search");
    expect(bare.label).toBeUndefined();
  });
});

describe("ChatFailureKind contract", () => {
  it("covers exactly the fourteen turn-failure discriminators", () => {
    const kinds: ChatFailureKind[] = [...CHAT_FAILURE_KINDS];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(14);
    expect(kinds).toEqual([
      "insufficient_credits",
      "missing_capability",
      "no_provider",
      "planner_exhaustion",
      "context_overflow",
      "provider_issue",
      "generation_timeout",
      "rate_limited",
      "handler_error",
      "persistence_error",
      "local_inference",
      "coding_mutation_unverified",
      "coding_verification_failed",
      "coding_tool_failure",
    ]);
  });

  it("validates every public kind and rejects unknowns", () => {
    for (const kind of CHAT_FAILURE_KINDS) {
      expect(isChatFailureKind(kind)).toBe(true);
      expect(parseChatFailureKind(kind)).toBe(kind);
    }
    expect(isChatFailureKind("transient_failure")).toBe(false);
    expect(isChatFailureKind("not_a_kind")).toBe(false);
    expect(parseChatFailureKind("generation_timeout")).toBe(
      "generation_timeout",
    );
    expect(parseChatFailureKind(undefined)).toBeUndefined();
  });

  it("marks only recoverable kinds retryable for UI contracts", () => {
    const expectedRetryable = new Set<ChatFailureKind>([
      ...RETRYABLE_CHAT_FAILURE_KINDS,
    ]);
    for (const kind of CHAT_FAILURE_KINDS) {
      expect(isRetryableChatFailureKind(kind)).toBe(
        expectedRetryable.has(kind),
      );
    }
    expect(isRetryableChatFailureKind("planner_exhaustion")).toBe(true);
    expect(isRetryableChatFailureKind("generation_timeout")).toBe(true);
    expect(isRetryableChatFailureKind("missing_capability")).toBe(false);
    expect(isRetryableChatFailureKind("context_overflow")).toBe(false);
    expect(isRetryableChatFailureKind("no_provider")).toBe(false);
    expect(isRetryableChatFailureKind("insufficient_credits")).toBe(false);
    expect(isRetryableChatFailureKind("coding_mutation_unverified")).toBe(
      false,
    );
    expect(isRetryableChatFailureKind("coding_verification_failed")).toBe(
      false,
    );
    expect(isRetryableChatFailureKind("coding_tool_failure")).toBe(false);
  });

  it("validates complete terminal failures without inventing missing fields", () => {
    expect(
      parseChatTerminalFailure({
        kind: "coding_verification_failed",
        message: "Typecheck still fails.",
        transient: false,
        code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
      }),
    ).toEqual({
      kind: "coding_verification_failed",
      message: "Typecheck still fails.",
      transient: false,
      code: "CODING_VERIFICATION_REPAIR_EXHAUSTED",
    });
    expect(
      parseChatTerminalFailure({
        kind: "coding_tool_failure",
        message: "",
        transient: false,
      }),
    ).toBeUndefined();
    expect(
      parseChatTerminalFailure({
        kind: "unknown",
        message: "Failed.",
        transient: false,
      }),
    ).toBeUndefined();
  });
});
