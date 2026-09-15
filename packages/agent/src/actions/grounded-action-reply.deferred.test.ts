/** Real executor -> renderer -> settlement -> planner serialization; model is stubbed. */
import {
  type Action,
  applyGroundedActionReply,
  getActionReplyOwner,
  type IAgentRuntime,
  type Memory,
  renderActionResultsForModel,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executePlannedToolCall } from "../../../core/src/runtime/execute-planned-tool-call";
import { actionResultToPlannerToolResult } from "../../../core/src/runtime/planner-loop";
import { renderGroundedActionReply } from "./grounded-action-reply";

const message = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  content: {
    text: "Save the corrected reminder and tell me about the earlier version.",
  },
} as Memory;
const receipt = {
  receiptId: "save-1",
  operation: "lifeops.definition.create",
  resource: { kind: "lifeops.definition", id: "definition-1" },
  artifacts: [],
  idempotency: { key: "request-1", replayed: false },
  observedAt: "2026-09-11T20:00:00.000Z",
  outcome: "applied" as const,
  commit: {
    kind: "durable" as const,
    id: "commit-1",
    committedAt: "2026-09-11T20:00:00.000Z",
  },
};

function harness(
  options: {
    domain?: "lifeops" | "gmail";
    success?: boolean;
    context?: Record<string, unknown>;
    afterReply?: () => void;
    renderMessage?: Memory;
    suppressClipboard?: boolean;
  } = {},
) {
  const context = options.context ?? {
    title: "  corrected 🦊  ",
    records: ["same", "same"],
    tail: `${"x".repeat(24000)}END`,
  };
  const callback = vi.fn(async () => []);
  const useModel = vi.fn(async () => "Model-authored reply.");
  const getMemories = vi.fn(async () => [
    { content: { text: "original" } },
    { content: { text: "correction" } },
  ]);
  let grounding: string | undefined;
  const action: Action = {
    name: "SAVE",
    description: "Save a reminder",
    tags: ["write"],
    suppressActionResultClipboard: options.suppressClipboard,
    validate: async () => true,
    handler: async (
      runtime,
      currentMessage,
      state,
      _options,
      actionCallback,
    ) => {
      await Promise.resolve();
      const reply = await renderGroundedActionReply({
        runtime,
        message: options.renderMessage ?? currentMessage,
        state,
        domain: options.domain ?? "lifeops",
        intent: "save corrected reminder",
        scenario: options.success === false ? "missing_schedule" : "created",
        fallback: "Action facts, never a delivered fallback.",
        context,
        additionalRules: ["Keep both occurrences and the exact quoted title."],
        preferCharacterVoice: true,
      });
      if (reply.kind === "deferred") grounding = reply.grounding;
      if (reply.kind === "model") await actionCallback?.({ text: reply.text });
      options.afterReply?.();
      return applyGroundedActionReply(
        {
          success: options.success ?? true,
          data: {
            originalResult: "untouched",
            ...(options.success === false ? { requiresInput: true } : {}),
          },
          promptData: { completeModelContract: "untouched" },
          promptDataMode: "replace-data",
          ...(options.success === false ? {} : { effectReceipts: [receipt] }),
        },
        reply,
      );
    },
  };
  const runtime = {
    agentId: message.entityId,
    actions: [action],
    character: {
      system: "Keep exact facts",
      bio: ["patient"],
      style: { all: ["clear"] },
    },
    getRoom: vi.fn(async () => null),
    getService: vi.fn(),
    getSetting: vi.fn(),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    useModel,
    getMemories,
  } as unknown as IAgentRuntime;
  return {
    runtime,
    useModel,
    getMemories,
    callback,
    context,
    grounding: () => grounding,
    run: (replyOwner?: "planner") =>
      executePlannedToolCall(
        runtime,
        {
          message,
          replyOwner,
          userRoles: ["OWNER"],
          callback,
        },
        { name: "SAVE", params: {} },
      ),
  };
}

describe("planner-owned LifeOps replies", () => {
  it("preserves complete action grounding and receipts without a narration model or callback", async () => {
    const h = harness();
    const result = await h.run("planner");
    expect(h.useModel).not.toHaveBeenCalled();
    expect(h.getMemories).not.toHaveBeenCalled();
    expect(h.callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      turnComplete: false,
      effectReceipts: [receipt],
    });
    expect(result.replyFailure).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(result.modelReplyFallback).toBeUndefined();
    expect(result.data?.replyGrounding).toBe(h.grounding());
    expect(result.promptData?.replyGrounding).toBe(h.grounding());
    const grounding = JSON.parse(String(h.grounding()));
    expect(grounding.context).toEqual(h.context);
    expect(grounding.currentUserMessage).toBe(message.content.text);
    expect(grounding.instructions).toContain(
      "Keep both occurrences and the exact quoted title.",
    );
    expect(JSON.parse(grounding.characterVoice)).toEqual(h.runtime.character);
    expect(grounding.canonicalFallback).toBe(
      "Action facts, never a delivered fallback.",
    );
    const roundTrip = JSON.parse(
      JSON.stringify(actionResultToPlannerToolResult(result)),
    );
    const wire = renderActionResultsForModel([roundTrip]).text;
    expect(wire).toContain("END");
    expect(wire).toContain("same");
    expect(roundTrip.data.replyGrounding).toBe(h.grounding());
    expect(roundTrip.effectReceipts).toEqual([receipt]);
  });

  it("keeps direct callers and other domains on the original complete-history renderer", async () => {
    for (const [domain, owner] of [
      ["lifeops", undefined],
      ["gmail", "planner"],
    ] as const) {
      const h = harness({ domain });
      const result = await h.run(owner);
      expect(h.useModel).toHaveBeenCalledTimes(1);
      expect(h.getMemories).toHaveBeenCalledTimes(1);
      expect(result.text).toBe("Model-authored reply.");
      expect(JSON.stringify(h.useModel.mock.calls)).toContain("correction");
    }
  });

  it("preserves clarification/failure state without fabricating success or delivering fallback prose", async () => {
    const h = harness({ success: false });
    const result = await h.run("planner");
    expect(result).toMatchObject({
      success: false,
      turnComplete: false,
      data: { requiresInput: true },
    });
    expect(JSON.parse(String(h.grounding())).scenario).toBe("missing_schedule");
    expect(h.callback).not.toHaveBeenCalled();
    expect(result.replyFailure).toBeUndefined();
  });

  it("does not share ownership with concurrent direct calls or another message", async () => {
    const planner = harness();
    const direct = harness();
    const other = harness({
      renderMessage: { ...message, id: crypto.randomUUID() },
    });
    await Promise.all([
      planner.run("planner"),
      direct.run(),
      other.run("planner"),
    ]);
    expect(planner.useModel).not.toHaveBeenCalled();
    expect(direct.useModel).toHaveBeenCalledTimes(1);
    expect(other.useModel).toHaveBeenCalledTimes(1);
    expect(getActionReplyOwner(message.id)).toBeUndefined();
  });

  it("revokes reply ownership before detached work can outlive the settled action", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<unknown> | undefined;
    const h = harness({
      afterReply: () => {
        late = gate.then(() => getActionReplyOwner(message.id));
      },
    });
    await h.run("planner");
    release();
    expect(await late).toBeUndefined();
  });

  it("does not defer a reply whose result is withheld from the planner", async () => {
    const h = harness({ suppressClipboard: true });
    await h.run("planner");
    expect(h.useModel).toHaveBeenCalledTimes(1);
    expect(h.grounding()).toBeUndefined();
  });

  it("does not accept reply ownership from user content or handler options", async () => {
    const h = harness();
    const result = await executePlannedToolCall(
      h.runtime,
      {
        message: {
          ...message,
          content: { ...message.content, data: { replyOwner: "planner" } },
        },
        userRoles: ["OWNER"],
      },
      { name: "SAVE", params: {} },
      { replyOwner: "planner" },
    );
    expect(result.text).toBe("Model-authored reply.");
    expect(h.useModel).toHaveBeenCalledTimes(1);
  });

  it("preserves a committed effect and reports invalid grounding without a partial reply", async () => {
    const context: Record<string, unknown> = {};
    context.circular = context;
    const h = harness({ context });
    const result = await h.run("planner");
    expect(result).toMatchObject({
      success: true,
      effectReceipts: [receipt],
      replyFailure: {
        code: "GROUNDED_REPLY_CONTEXT_INVALID",
        transient: false,
      },
    });
    expect(h.callback).not.toHaveBeenCalled();
    expect(h.useModel).not.toHaveBeenCalled();
    expect(h.runtime.reportError).toHaveBeenCalled();
  });
});
