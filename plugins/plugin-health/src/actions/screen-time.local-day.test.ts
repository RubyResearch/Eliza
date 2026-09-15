/**
 * Pins the OWNER_SCREENTIME "today" subaction to the owner's local calendar
 * day rather than the UTC day. Deterministic: the real runner drives in-memory
 * adapters that record the requested day while the clock is fixed at 22:30Z
 * and the process zone is switched per case; no live model or device.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { resolveDefaultTimeZone } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreateScreenTimeActionRunnerOptions,
  createScreenTimeActionRunner,
  type ScreenTimeActionService,
} from "./screen-time.js";

const NOW = "2026-09-13T22:30:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

const CASES = [
  { zone: "Asia/Tokyo", localToday: "2026-09-14" },
  { zone: "America/Los_Angeles", localToday: "2026-09-13" },
  { zone: "Pacific/Kiritimati", localToday: "2026-09-14" },
] as const;

const runtime = {
  agentId: "agent-screen-time",
  logger: { debug: vi.fn() },
} as unknown as IAgentRuntime;

const message = { content: { text: "screen time today" } } as Memory;

function makeService(): ScreenTimeActionService {
  return {
    getScreenTimeDaily: vi.fn(async () => []),
    getScreenTimeSummary: vi.fn(async () => ({ items: [], totalSeconds: 0 })),
    getScreenTimeWeeklyAverageByApp: vi.fn(async () => ({
      daysInWindow: 7,
      totalSeconds: 0,
      items: [],
    })),
  };
}

function makeRunner(service: ScreenTimeActionService) {
  const renderReply = vi.fn<CreateScreenTimeActionRunnerOptions["renderReply"]>(
    async ({ fallback }) => ({ kind: "model", text: fallback }),
  );
  const run = createScreenTimeActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (input) =>
      typeof input.content.text === "string" ? input.content.text : "",
    renderReply,
    resolveActionArgs: async <TSubaction extends string, TParams>() => ({
      ok: true as const,
      subaction: "today" as TSubaction,
      params: {} as TParams,
    }),
    isDarwin: () => true,
    getActivityReport: vi.fn(),
    getTimeOnApp: vi.fn(),
    getBrowserDomainActivity: vi.fn(),
    getBrowserActivitySnapshot: vi.fn(),
    resolveTimeZone: () => resolveDefaultTimeZone(),
  });
  return { run, renderReply };
}

describe("screen-time action local calendar day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = ORIGINAL_TZ;
  });

  it.each(CASES)(
    "TZ=$zone at 22:30Z requests and labels $localToday",
    async ({ zone, localToday }) => {
      process.env.TZ = zone;
      expect(resolveDefaultTimeZone()).toBe(zone);
      const service = makeService();
      const { run, renderReply } = makeRunner(service);

      const result = await run(runtime, message, undefined, {
        parameters: { subaction: "today" },
      });

      expect(service.getScreenTimeDaily).toHaveBeenCalledWith(
        expect.objectContaining({ date: localToday }),
      );
      expect(result).toMatchObject({
        success: true,
        data: { subaction: "today", date: localToday },
      });
      expect(renderReply).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: "screen_time_daily",
          fallback: `No screen time recorded for ${localToday}.`,
        }),
      );
    },
  );
});
