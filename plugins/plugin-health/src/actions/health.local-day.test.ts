/**
 * Pins the HEALTH action's "today" request and trend window to the owner's
 * local calendar day rather than the UTC day. Deterministic: the real runner
 * drives an in-memory service that records what was requested while the clock
 * is fixed at 22:30Z and the process zone is switched per case; no live model,
 * and the optimized-prompt resolver is pinned to identity.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { resolveDefaultTimeZone } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { LifeOpsHealthSummaryResponse } from "../contracts/health.js";
import {
  type CreateHealthActionRunnerOptions,
  createHealthActionRunner,
  type HealthActionService,
} from "./health.js";

const NOW = "2026-09-13T22:30:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

const CASES = [
  { zone: "Asia/Tokyo", localToday: "2026-09-14" },
  { zone: "America/Los_Angeles", localToday: "2026-09-13" },
  { zone: "Pacific/Kiritimati", localToday: "2026-09-14" },
] as const;

const runtime = {
  logger: { warn: vi.fn() },
  reportError: vi.fn(),
} as unknown as IAgentRuntime;

const message = { content: { text: "how did I sleep" } } as Memory;

function connectorSummary(
  date: string,
): LifeOpsHealthSummaryResponse["summaries"][number] {
  return {
    date,
    provider: "oura",
    steps: 10,
    activeMinutes: 5,
    sleepHours: 7,
    calories: null,
    distanceMeters: null,
    heartRateAvg: null,
    restingHeartRate: null,
    hrvMs: null,
    sleepScore: null,
    readinessScore: null,
    weightKg: null,
    bloodPressureSystolic: null,
    bloodPressureDiastolic: null,
    bloodOxygenPercent: null,
  };
}

function makeService(options: {
  backendAvailable: boolean;
  summaries?: LifeOpsHealthSummaryResponse["summaries"];
}) {
  return {
    getHealthConnectorStatus: vi.fn(async () => ({
      available: options.backendAvailable,
      backend: options.backendAvailable
        ? ("healthkit" as const)
        : ("none" as const),
    })),
    getHealthSummary: vi.fn(async () => ({
      providers: [
        {
          provider: "oura",
          connected: true,
        } as LifeOpsHealthSummaryResponse["providers"][number],
      ],
      summaries: options.summaries ?? [],
      samples: [],
      workouts: [],
      sleepEpisodes: [],
      syncedAt: NOW,
    })),
    getHealthTrend: vi.fn(async () => []),
    getHealthDataPoints: vi.fn(async () => []),
    getHealthDailySummary: vi.fn(async (date: string) => ({
      date,
      steps: 1200,
      activeMinutes: 30,
      sleepHours: 7.5,
      source: "healthkit" as const,
    })),
  } satisfies HealthActionService;
}

function makeRunner(service: HealthActionService) {
  const renderReply = vi.fn<CreateHealthActionRunnerOptions["renderReply"]>(
    async ({ fallback }) => ({ kind: "model", text: fallback }),
  );
  const run = createHealthActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (input) =>
      typeof input.content.text === "string" ? input.content.text : "",
    renderReply,
    recentConversationTexts: async () => [],
    runJsonModel: async () => null,
    resolveTimeZone: () => resolveDefaultTimeZone(),
  });
  return { run, renderReply };
}

describe("health action local calendar day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = ORIGINAL_TZ;
  });

  describe.each(CASES)("TZ=$zone at 22:30Z", ({ zone, localToday }) => {
    beforeEach(() => {
      process.env.TZ = zone;
      expect(resolveDefaultTimeZone()).toBe(zone);
    });

    it(`requests and labels the HealthKit day ${localToday} for "today"`, async () => {
      const service = makeService({ backendAvailable: true });
      const { run, renderReply } = makeRunner(service);

      const result = await run(runtime, message, undefined, {
        parameters: { subaction: "today" },
      });

      expect(service.getHealthDailySummary).toHaveBeenCalledWith(localToday);
      expect(result).toMatchObject({
        success: true,
        data: { subaction: "today", date: localToday },
      });
      expect(renderReply).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: "health_today",
          context: expect.objectContaining({ date: localToday }),
        }),
      );
    });

    it(`walks the trend window in ${zone}`, async () => {
      const service = makeService({ backendAvailable: true });
      const { run } = makeRunner(service);

      await run(runtime, message, undefined, {
        parameters: { subaction: "trend", days: 3 },
      });

      expect(service.getHealthTrend).toHaveBeenCalledWith(3, {
        timeZone: zone,
      });
    });

    it(`picks the connector summary for ${localToday} when no bridge is available`, async () => {
      const service = makeService({
        backendAvailable: false,
        summaries: [
          connectorSummary("2026-09-14"),
          connectorSummary("2026-09-13"),
        ],
      });
      const { run, renderReply } = makeRunner(service);

      const result = await run(runtime, message, undefined, {
        parameters: { subaction: "today" },
      });

      expect(result.success).toBe(true);
      expect(renderReply).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: "health_connector_today",
          context: {
            daily: expect.objectContaining({ date: localToday }),
          },
        }),
      );
    });
  });
});
