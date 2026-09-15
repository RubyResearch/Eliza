/**
 * Preserves committed LifeOps outcomes when the reply renderer is unavailable.
 * Actions, receipt validation, and PGlite persistence are real; only reply
 * generation is a deterministic collaborator, so this is not live-model proof.
 */
import * as agent from "@elizaos/agent";
import type { ActionResult, AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { readLifeOpsMeetingPreferences } from "../lifeops/owner-profile.js";
import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";
import { runUpdateMeetingPreferencesHandler } from "./lib/scheduling-handler.js";
import { runLifeOperationHandler } from "./life.js";

const failure = {
  kind: "rate_limited" as const,
  code: "REPLY_RATE_LIMITED",
  message: "Reply provider rate limited.",
  transient: false as const,
};

function expectUnavailable(result: ActionResult) {
  expect(result).toMatchObject({
    success: true,
    replyFailure: failure,
    transcriptVisibility: "internal",
    turnComplete: false,
  });
  expect(result.text).toBeUndefined();
  expect(result.userFacingText).toBeUndefined();
  expect(result.verifiedUserFacing).toBeUndefined();
  expect(result.userFacingEffectReceiptIds).toBeUndefined();
}

describe("grounded reply outcomes — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let service: LifeOpsService;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    service = new LifeOpsService(runtime, { ownerEntityId: runtime.agentId });
  }, 180_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function message(text: string): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: { source: "autonomy", text },
    } as Memory;
  }

  it.each(["unavailable", "deferred"] as const)(
    "keeps one persisted definition and receipt with %s presentation",
    async (kind) => {
      const renderReply = vi
        .spyOn(agent, "renderGroundedActionReply")
        .mockResolvedValue(
          kind === "unavailable"
            ? { kind, failure }
            : { kind, grounding: "All action facts and reply rules" },
        );
      const callback = vi.fn(async () => []);
      const title = `Reply ${kind} daily task`;
      const result = await runLifeOperationHandler(
        runtime,
        message(`Remind me about ${title}`),
        undefined,
        {
          parameters: {
            action: "create",
            kind: "definition",
            title,
            intent: `Remind me about ${title}`,
            details: {
              confirmed: true,
              kind: "habit",
              cadence: { kind: "daily", windows: ["morning"] },
              timeZone: "UTC",
            },
          },
        },
        callback,
      );

      if (kind === "unavailable") {
        expectUnavailable(result);
      } else {
        expect(result).toMatchObject({
          success: true,
          transcriptVisibility: "internal",
          turnComplete: false,
          data: { replyGrounding: "All action facts and reply rules" },
        });
        expect(result.replyFailure).toBeUndefined();
        expect(result.userFacingText).toBeUndefined();
      }
      const records = (await service.listDefinitions()).filter(
        (record) => record.definition.title === title,
      );
      expect(records).toHaveLength(1);
      expect(result.data).toMatchObject({
        definition: { id: records[0].definition.id },
      });
      expect(result.effectReceipts).toMatchObject([
        {
          outcome: "applied",
          operation: "lifeops.definition.create",
          resource: { id: records[0].definition.id },
          commit: { kind: "durable" },
          idempotency: { replayed: false },
        },
      ]);
      expect(renderReply).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it("keeps one persisted entity contact and its applied receipt after reply failure", async () => {
    const renderReply = vi
      .spyOn(agent, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "unavailable", failure });
    const callback = vi.fn(async () => []);
    const result = await entityAction.handler(
      runtime,
      message("Add Reply Contact to my contacts"),
      undefined,
      {
        parameters: {
          subaction: "create",
          name: "Reply Contact",
          channel: "telegram",
          handle: "@reply_contact",
        },
      },
      callback,
    );

    expectUnavailable(result);
    const records = (await service.listRelationships({})).filter(
      (record) => record.primaryHandle === "@reply_contact",
    );
    expect(records).toHaveLength(1);
    expect(result.data).toMatchObject({ relationship: { id: records[0].id } });
    expect(result.effectReceipts).toMatchObject([
      {
        outcome: "applied",
        operation: "lifeops.entity.contact.save",
        resource: { id: records[0].id },
        commit: { kind: "durable" },
      },
    ]);
    expect(renderReply).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps the scheduling preference write and task evidence after reply failure", async () => {
    const renderReply = vi
      .spyOn(agent, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "unavailable", failure });
    const callback = vi.fn(async () => []);
    const result = await runUpdateMeetingPreferencesHandler(
      runtime,
      message("Make my default meetings 47 minutes"),
      undefined,
      { parameters: { defaultDurationMinutes: 47 } },
      callback,
    );

    expectUnavailable(result);
    expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
      defaultDurationMinutes: 47,
    });
    expect(result.data).toMatchObject({
      preferences: { defaultDurationMinutes: 47 },
      preferenceTaskId: expect.any(String),
      updatedFields: ["defaultDurationMinutes"],
    });
    expect(renderReply).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("delivers the exact model reply once and keeps its canonical entity receipt", async () => {
    const text = "Your contacts are ready to review.";
    const renderReply = vi
      .spyOn(agent, "renderGroundedActionReply")
      .mockResolvedValue({ kind: "model", text });
    const callback = vi.fn(async () => []);
    const result = await entityAction.handler(
      runtime,
      message("List my contacts"),
      undefined,
      { parameters: { subaction: "read" } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
    });
    expect(result.replyFailure).toBeUndefined();
    expect(result.effectReceipts).toHaveLength(1);
    expect(result.userFacingEffectReceiptIds).toEqual([
      result.effectReceipts?.[0].receiptId,
    ]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ text });
    expect(renderReply).toHaveBeenCalledOnce();
  });
});
