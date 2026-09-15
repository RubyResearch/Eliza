/**
 * Unit test for the HEALTH action's trajectory `purpose` tag and planning
 * output, with the optimized-prompt resolver pinned to identity so it runs
 * deterministically without a live model.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The health planner routes its instructions through
// `resolveOptimizedPromptForRuntime`. Pin it to the identity (return the
// baseline) so this unit test of the trajectory `purpose` tag is hermetic and
// does not depend on the OptimizedPromptService resolution in the test env.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    resolveOptimizedPromptForRuntime: (
      _runtime: unknown,
      _task: unknown,
      baseline: string,
    ) => baseline,
  };
});

import {
  type CreateHealthActionRunnerOptions,
  createHealthActionRunner,
  createOwnerHealthAction,
  type HealthActionRunJsonModelArgs,
  type HealthActionService,
} from "./health.js";

function makeRunner(
  service: HealthActionService,
  renderReply: CreateHealthActionRunnerOptions["renderReply"] = async ({
    fallback,
  }) => ({ kind: "model", text: fallback }),
  hasAccess: CreateHealthActionRunnerOptions["hasAccess"] = async () => true,
) {
  return createHealthActionRunner({
    hasAccess,
    createService: () => service,
    messageText: (message) =>
      typeof message.content.text === "string" ? message.content.text : "",
    renderReply,
    recentConversationTexts: async () => [],
    runJsonModel: async () => null,
    resolveTimeZone: () => "UTC",
  });
}

const runtime = {
  logger: { warn: vi.fn() },
} as unknown as IAgentRuntime;

const message = {
  content: { text: "health status" },
} as Memory;

describe("health action runner", () => {
  it("keeps an access refusal unsuccessful when its reply is unavailable", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(),
      getHealthSummary: vi.fn(),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const failure = {
      kind: "no_provider" as const,
      code: "NO_REPLY_PROVIDER",
      message: "No reply provider configured.",
      transient: false as const,
    };
    const renderReply = vi.fn(async () => ({
      kind: "unavailable" as const,
      failure,
    }));
    const callback = vi.fn(async () => []);
    const result = await makeRunner(service, renderReply, async () => false)(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "today" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      data: { error: "PERMISSION_DENIED" },
      replyFailure: failure,
      transcriptVisibility: "internal",
      turnComplete: false,
    });
    expect(result.text).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(renderReply).toHaveBeenCalledOnce();
    expect(service.getHealthConnectorStatus).not.toHaveBeenCalled();
  });

  it("retains health evidence without a callback when its reply is unavailable", async () => {
    const status = { available: true, backend: "healthkit" as const };
    const service = {
      getHealthConnectorStatus: vi.fn(async () => status),
      getHealthSummary: vi.fn(async () => ({
        providers: [],
        summaries: [],
        samples: [],
        workouts: [],
        sleepEpisodes: [],
        syncedAt: "2026-05-30T12:00:00.000Z",
      })),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const failure = {
      kind: "provider_issue" as const,
      code: "REPLY_PROVIDER_UNAVAILABLE",
      message: "Reply provider unavailable.",
      transient: false as const,
    };
    const renderReply = vi.fn(async () => ({
      kind: "unavailable" as const,
      failure,
    }));
    const callback = vi.fn(async () => []);
    const result = await makeRunner(service, renderReply)(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "status" } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      data: { subaction: "status", status },
      values: { success: true, healthBackendAvailable: true },
      replyFailure: failure,
      transcriptVisibility: "internal",
      turnComplete: false,
    });
    expect(result.text).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(renderReply).toHaveBeenCalledOnce();
    expect(service.getHealthConnectorStatus).toHaveBeenCalledOnce();
    expect(service.getHealthSummary).toHaveBeenCalledOnce();
  });

  it("creates the owner health action metadata in plugin-health", async () => {
    const validate = vi.fn(async () => true);
    const handler = vi.fn(async () => ({
      text: "health handled",
      success: true,
    }));
    const action = createOwnerHealthAction({ validate, handler });

    expect(action.name).toBe("OWNER_HEALTH");
    expect(action.similes).toContain("HEALTH");
    expect(action.routingHint).toContain("OWNER_HEALTH");
    expect(action.parameters?.map((parameter) => parameter.name)).toEqual([
      "action",
      "intent",
      "metric",
      "date",
      "days",
    ]);
    await expect(action.validate(runtime, message)).resolves.toBe(true);
    await expect(action.handler(runtime, message)).resolves.toMatchObject({
      text: "health handled",
      success: true,
    });
    expect(validate).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it("tags the planner LLM call with the health_checkin trajectory purpose (#8795)", async () => {
    // A natural-language health request with NO explicit subaction routes
    // through resolveHealthPlanWithLlm → runJsonModel. The trajectory purpose
    // must be "health_checkin" (not the generic "planner") so it buckets into
    // the health_checkin training dataset that feeds the optimization loop —
    // matching the resolveOptimizedPromptForRuntime("health_checkin", ...) call.
    const runJsonModel = vi.fn(
      async (
        _args: HealthActionRunJsonModelArgs,
      ): Promise<{ parsed: Record<string, unknown> }> => ({
        parsed: {
          subaction: "status",
          metric: null,
          days: null,
          shouldAct: true,
        },
      }),
    );
    const recentConversationTexts = vi.fn(async () => [
      "oldest retained turn",
      "newest retained turn",
    ]);
    const runner = createHealthActionRunner({
      hasAccess: async () => true,
      createService: () => ({
        getHealthConnectorStatus: vi.fn(async () => ({
          available: false,
          backend: "none" as const,
        })),
        getHealthSummary: vi.fn(async () => ({
          providers: [],
          summaries: [],
          samples: [],
          workouts: [],
          sleepEpisodes: [],
          syncedAt: "2026-05-30T12:00:00.000Z",
        })),
        getHealthTrend: vi.fn(),
        getHealthDataPoints: vi.fn(),
        getHealthDailySummary: vi.fn(),
      }),
      messageText: (m) =>
        typeof m.content.text === "string" ? m.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      recentConversationTexts,
      runJsonModel,
      resolveTimeZone: () => "UTC",
    });

    // resolveHealthPlanWithLlm short-circuits unless runtime.useModel exists.
    const plannerRuntime = {
      logger: { warn: vi.fn() },
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    // No `subaction` in options → the planner LLM call fires.
    await runner(
      plannerRuntime,
      { content: { text: "how have i been sleeping lately" } } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(runJsonModel).toHaveBeenCalledTimes(1);
    expect(recentConversationTexts).toHaveBeenCalledWith({
      runtime: plannerRuntime,
      message: expect.any(Object),
      state: undefined,
    });
    expect(runJsonModel.mock.calls[0][0]).toMatchObject({
      purpose: "health_checkin",
      actionType: "HEALTH.plan",
    });
  });

  it("denies access → PERMISSION_DENIED before touching the service (#8795)", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(),
      getHealthSummary: vi.fn(),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const runner = createHealthActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => false,
      createService: () => service,
      messageText: (m) =>
        typeof m.content.text === "string" ? m.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      recentConversationTexts: async () => [],
      runJsonModel: async () => null,
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "today" } },
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: "PERMISSION_DENIED" });
    expect(result.text).toContain("Health data is restricted to the owner");
    // No service work should run once access is denied.
    expect(service.getHealthConnectorStatus).not.toHaveBeenCalled();
  });

  it("planner shouldAct:false → planner_clarification carrying the clarifying text (#8795)", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(),
      getHealthSummary: vi.fn(),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const runJsonModel = vi.fn(
      async (): Promise<{ parsed: Record<string, unknown> }> => ({
        parsed: {
          subaction: null,
          metric: null,
          days: null,
          shouldAct: false,
          response: "Which metric — steps, sleep, or heart rate?",
        },
      }),
    );
    const runner = createHealthActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => service,
      messageText: (m) =>
        typeof m.content.text === "string" ? m.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      recentConversationTexts: async () => [],
      runJsonModel,
    });

    // resolveHealthPlanWithLlm only fires when runtime.useModel exists.
    const plannerRuntime = {
      logger: { warn: vi.fn() },
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    // No explicit subaction → the planner runs and returns shouldAct:false.
    const result = await runner(
      plannerRuntime,
      { content: { text: "tell me about my health" } } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(runJsonModel).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    // renderReply echoes the fallback, which is the planner's clarifying text.
    expect(result.text).toBe("Which metric — steps, sleep, or heart rate?");
    expect(result.values).toMatchObject({
      success: false,
      error: "PLANNER_SHOULDACT_FALSE",
      skipped: true,
    });
    expect(result.data).toMatchObject({
      skipped: true,
      error: "PLANNER_SHOULDACT_FALSE",
    });
    // Clarification short-circuits before any health data is fetched.
    expect(service.getHealthConnectorStatus).not.toHaveBeenCalled();
  });

  it("by_metric with no metric → MISSING_METRIC (#8795)", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(async () => ({
        available: true,
        backend: "healthkit" as const,
      })),
      getHealthSummary: vi.fn(async () => ({
        providers: [],
        summaries: [],
        samples: [],
        workouts: [],
        sleepEpisodes: [],
        syncedAt: "2026-05-30T12:00:00.000Z",
      })),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const runner = makeRunner(service);

    // Explicit by_metric subaction, but no metric param → MISSING_METRIC.
    const result = await runner(
      runtime,
      { content: { text: "how much of that metric" } } as Memory,
      undefined,
      { parameters: { subaction: "by_metric" } },
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: "MISSING_METRIC" });
    expect(result.text).toContain("Specify a metric");
    // Reached the metric guard, so no data points were ever requested.
    expect(service.getHealthDataPoints).not.toHaveBeenCalled();
  });

  it("runs status through injected service and renderer adapters", async () => {
    const service = {
      getHealthConnectorStatus: vi.fn(async () => ({
        available: false,
        backend: "none" as const,
      })),
      getHealthSummary: vi.fn(async () => ({
        providers: [],
        summaries: [],
        samples: [],
        workouts: [],
        sleepEpisodes: [],
        syncedAt: "2026-05-30T12:00:00.000Z",
      })),
      getHealthTrend: vi.fn(),
      getHealthDataPoints: vi.fn(),
      getHealthDailySummary: vi.fn(),
    } satisfies HealthActionService;
    const runner = makeRunner(service);

    const result = await runner(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "status" } },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("No HealthKit/Google Fit bridge available");
    expect(result.data).toMatchObject({
      subaction: "status",
      status: { available: false, backend: "none" },
      healthConnectors: [],
    });
  });
});
