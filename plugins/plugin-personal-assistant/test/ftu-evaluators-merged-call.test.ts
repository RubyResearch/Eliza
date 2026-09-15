/**
 * Drives the REAL core EvaluatorService end to end with both new
 * personal-assistant evaluators registered: one merged schema-constrained
 * SMALL-model call, sections parsed per evaluator, processors persisting to
 * the real stores, and shouldRun closing both gates afterwards (no second
 * model call, no reprocessing). The model response is a deterministic stub —
 * everything else (service, evaluators, stores, cache) is the production code.
 */
import type {
  IAgentRuntime,
  JSONSchema,
  Memory,
  TaskWorker,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { EvaluatorService } from "../../../packages/core/src/services/evaluator.ts";
import { anticipationFeedbackEvaluator } from "../src/lifeops/anticipation/evaluator.ts";
import {
  listUnprocessedDispatches,
  readAnticipationStats,
  recordProactiveDispatch,
} from "../src/lifeops/anticipation/store.ts";
import { createFirstRunStateStore } from "../src/lifeops/first-run/state.ts";
import { ftuGoalDiscoveryEvaluator } from "../src/lifeops/ftu-goal/evaluator.ts";
import { createFtuGoalStateStore } from "../src/lifeops/ftu-goal/state.ts";
import { createOwnerFactStore } from "../src/lifeops/owner/fact-store.ts";
import { createOwnerRuntimeStub } from "./first-run-helpers.ts";

const ROOM_ID = "room-merged-call-1";

interface CapturedModelCall {
  prompt: string;
  schema: JSONSchema | undefined;
}

function createEvaluatorRuntime(modelOutput: Record<string, unknown>): {
  runtime: IAgentRuntime;
  calls: CapturedModelCall[];
  memories: Memory[];
} {
  const calls: CapturedModelCall[] = [];
  const memories: Memory[] = [];
  const workers = new Map<string, TaskWorker>();
  const runtime = createOwnerRuntimeStub({
    evaluators: [ftuGoalDiscoveryEvaluator, anticipationFeedbackEvaluator],
    registerTaskWorker: (worker: TaskWorker) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    getMemories: async ({ roomId }: { roomId: string }) =>
      memories.filter((memory) => memory.roomId === roomId),
    useModel: (async (
      _modelType: string,
      params: {
        messages?: Array<{ content: string }>;
        responseSchema?: JSONSchema;
      },
    ) => {
      calls.push({
        prompt: params.messages?.[0]?.content ?? "",
        schema: params.responseSchema,
      });
      return modelOutput;
    }) as never,
    emitEvent: (async () => {}) as never,
    reportError: (() => {}) as never,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
  } as never);
  return { runtime, calls, memories };
}

function ownerMessage(runtime: IAgentRuntime, text: string): Memory {
  return {
    id: "msg-merged-1",
    entityId: "owner-entity-1",
    roomId: ROOM_ID,
    agentId: runtime.agentId,
    content: { text },
    createdAt: Date.now(),
  } as never;
}

describe("FTU + anticipation evaluators through the real merged EvaluatorService call", () => {
  it("runs both evaluators in one model call, persists via processors, then never reprocesses", async () => {
    const { runtime, calls, memories } = createEvaluatorRuntime({
      ftu_goal_discovery: {
        goalFound: true,
        goal: "Stay on top of email and family follow-ups",
        confidence: 0.85,
      },
      anticipation_feedback: { outcome: "accepted" },
    });

    const firstRun = createFirstRunStateStore(runtime);
    await firstRun.begin("defaults");
    await firstRun.complete();
    await recordProactiveDispatch(runtime, {
      roomId: ROOM_ID,
      taskId: "gm-task",
      firedAt: new Date(Date.now() - 60_000).toISOString(),
      snippet: "Morning! Want a quick plan for today?",
    });

    const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
    const message = ownerMessage(
      runtime,
      "Yes please — mostly I need help staying on top of email and family follow-ups.",
    );
    memories.push(message);
    const result = await service.run(message, undefined, { didRespond: true });

    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.activeEvaluators.sort()).toEqual([
      "anticipation_feedback",
      "ftu_goal_discovery",
    ]);
    expect(result.processedEvaluators.sort()).toEqual([
      "anticipation_feedback",
      "ftu_goal_discovery",
    ]);

    // Exactly ONE merged model call, whose prompt and schema carry both
    // evaluator sections.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain(message.content.text);
    expect(calls[0]?.prompt).toContain("### ftu_goal_discovery");
    expect(calls[0]?.prompt).toContain("### anticipation_feedback");
    expect(Object.keys(calls[0]?.schema?.properties ?? {}).sort()).toEqual([
      "anticipation_feedback",
      "ftu_goal_discovery",
    ]);

    // Processor side effects hit the real stores.
    const facts = await createOwnerFactStore(runtime).read();
    expect(facts.primaryGoal?.value).toBe(
      "Stay on top of email and family follow-ups",
    );
    expect((await createFtuGoalStateStore(runtime).read()).status).toBe(
      "complete",
    );
    expect(await listUnprocessedDispatches(runtime, ROOM_ID)).toHaveLength(0);
    expect(await readAnticipationStats(runtime)).toMatchObject({
      accepted: 1,
      rejected: 0,
      ignored: 0,
    });

    // Second turn: both gates are closed — the service skips without another
    // model call and without touching the persisted state.
    const second = await service.run(
      ownerMessage(runtime, "thanks! also what's the weather"),
      undefined,
      { didRespond: true },
    );
    expect(second.skipped).toBe(true);
    expect(second.activeEvaluators).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(
      (await createOwnerFactStore(runtime).read()).primaryGoal?.value,
    ).toBe("Stay on top of email and family follow-ups");
  });

  it("keeps discovery open when the merged output is low-confidence", async () => {
    const { runtime, calls, memories } = createEvaluatorRuntime({
      ftu_goal_discovery: {
        goalFound: true,
        goal: "Maybe something with fitness?",
        confidence: 0.4,
      },
      anticipation_feedback: { outcome: "ignored" },
    });
    const firstRun = createFirstRunStateStore(runtime);
    await firstRun.begin("defaults");
    await firstRun.complete();

    const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
    const message = ownerMessage(
      runtime,
      "eh, I sometimes think about the gym",
    );
    memories.push(message);
    const result = await service.run(message, undefined, { didRespond: true });

    // Only the goal evaluator was active (no proactive marker), it ran, and
    // low confidence left the pipeline open for the next turn.
    expect(result.activeEvaluators).toEqual(["ftu_goal_discovery"]);
    expect(calls).toHaveLength(1);
    expect((await createFtuGoalStateStore(runtime).read()).status).toBe(
      "pending",
    );
    expect(
      (await createOwnerFactStore(runtime).read()).primaryGoal,
    ).toBeUndefined();
  });
});
