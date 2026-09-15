/**
 * Unit test for the owner screen-time action factory, runner, and recap-rule
 * builder, exercised against in-memory adapters (no live model or device).
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildScreenTimeRecapRules,
  type CreateScreenTimeActionRunnerOptions,
  createOwnerScreenTimeAction,
  createScreenTimeActionRunner,
  type ScreenTimeActionService,
} from "./screen-time.js";

const runtime = {
  agentId: "agent-screen-time",
  logger: { debug: vi.fn() },
} as unknown as IAgentRuntime;

const message = {
  content: { text: "screen time today" },
} as Memory;

function makeService(): ScreenTimeActionService {
  return {
    getScreenTimeDaily: vi.fn(async () => [
      {
        id: "daily-1",
        agentId: "agent-screen-time",
        source: "app" as const,
        identifier: "com.example.Editor",
        date: "2026-05-30",
        totalSeconds: 3600,
        sessionCount: 2,
        metadata: {},
        createdAt: "2026-05-30T12:00:00.000Z",
        updatedAt: "2026-05-30T12:00:00.000Z",
      },
    ]),
    getScreenTimeSummary: vi.fn(async () => ({
      items: [],
      totalSeconds: 0,
    })),
    getScreenTimeWeeklyAverageByApp: vi.fn(async () => ({
      daysInWindow: 7,
      totalSeconds: 0,
      items: [],
    })),
  };
}

function makeRunner(
  service: ScreenTimeActionService,
  renderReply: CreateScreenTimeActionRunnerOptions["renderReply"] = async ({
    fallback,
  }) => ({ kind: "model", text: fallback }),
) {
  return createScreenTimeActionRunner({
    hasAccess: async () => true,
    createService: () => service,
    messageText: (input) =>
      typeof input.content.text === "string" ? input.content.text : "",
    renderReply,
    resolveTimeZone: () => "UTC",
    resolveActionArgs: async <TSubaction extends string, TParams>(input: {
      defaultSubaction?: TSubaction;
      options?: {
        parameters?: {
          subaction?: TSubaction;
          date?: string;
        };
      };
    }) => ({
      ok: true as const,
      subaction: (input.options?.parameters?.subaction ??
        input.defaultSubaction ??
        "today") as TSubaction,
      params: {
        date: input.options?.parameters?.date ?? "2026-05-30",
      } as unknown as TParams,
    }),
    isDarwin: () => false,
    getActivityReport: vi.fn(),
    getTimeOnApp: vi.fn(),
    getBrowserDomainActivity: vi.fn(),
    getBrowserActivitySnapshot: vi.fn(),
  });
}

describe("screen-time action runner", () => {
  it("retains screen-time evidence without a callback when its reply is unavailable", async () => {
    const service = makeService();
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
    const result = await makeRunner(service, renderReply)(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "today" } },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        subaction: "today",
        daily: [{ id: "daily-1", totalSeconds: 3600 }],
      },
      replyFailure: failure,
      transcriptVisibility: "internal",
      turnComplete: false,
    });
    expect(result.text).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(renderReply).toHaveBeenCalledOnce();
    expect(service.getScreenTimeDaily).toHaveBeenCalledOnce();
  });

  it("requests the complete screen-time summary when no pagination is supplied", async () => {
    const service = makeService();
    const runner = makeRunner(service);

    await runner(runtime, message, undefined, {
      parameters: { subaction: "summary" },
    });

    expect(service.getScreenTimeSummary).toHaveBeenCalledWith(
      expect.not.objectContaining({ topN: expect.anything() }),
    );
  });

  it("creates the owner screen-time action metadata in plugin-health", async () => {
    const validate = vi.fn(async () => true);
    const handler = vi.fn(async () => ({
      text: "screen-time handled",
      success: true,
    }));
    const action = createOwnerScreenTimeAction({ validate, handler });

    expect(action.name).toBe("OWNER_SCREENTIME");
    expect(action.similes).toContain("SCREEN_TIME");
    expect(action.descriptionCompressed).toContain("time_on_site");
    expect(action.parameters?.map((parameter) => parameter.name)).toEqual([
      "action",
      "source",
      "identifier",
      "date",
      "days",
      "limit",
      "windowDays",
      "windowHours",
      "appNameOrBundleId",
      "domain",
      "deviceId",
    ]);
    await expect(action.validate(runtime, message)).resolves.toBe(true);
    await expect(action.handler(runtime, message)).resolves.toMatchObject({
      text: "screen-time handled",
      success: true,
    });
    expect(validate).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it("runs daily screen-time through injected service and renderer adapters", async () => {
    const service = makeService();
    const runner = makeRunner(service);

    const result = await runner(
      runtime,
      message,
      undefined,
      { parameters: { subaction: "today", date: "2026-05-30" } },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Screen time for 2026-05-30");
    expect(result.data).toMatchObject({
      subaction: "today",
      date: "2026-05-30",
    });
    expect(service.getScreenTimeDaily).toHaveBeenCalledWith({
      date: "2026-05-30",
      source: undefined,
      identifier: undefined,
    });
  });

  it("denies access → PERMISSION_DENIED before resolving args (#8795)", async () => {
    const resolveActionArgs = vi.fn();
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => false,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      resolveActionArgs,
      isDarwin: () => false,
      getActivityReport: vi.fn(),
      getTimeOnApp: vi.fn(),
      getBrowserDomainActivity: vi.fn(),
      getBrowserActivitySnapshot: vi.fn(),
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: "PERMISSION_DENIED" });
    expect(result.text).toContain(
      "Screen time data is restricted to the owner",
    );
    // Access denial short-circuits before argument resolution.
    expect(resolveActionArgs).not.toHaveBeenCalled();
  });

  it("resolveActionArgs ok:false → INVALID_SUBACTION (#8795)", async () => {
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      resolveActionArgs: async () => ({
        ok: false as const,
        missing: ["appNameOrBundleId"],
        clarification: "Which app should I check?",
      }),
      isDarwin: () => false,
      getActivityReport: vi.fn(),
      getTimeOnApp: vi.fn(),
      getBrowserDomainActivity: vi.fn(),
      getBrowserActivitySnapshot: vi.fn(),
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.text).toBe("Which app should I check?");
    expect(result.data).toEqual({
      error: "INVALID_SUBACTION",
      missing: ["appNameOrBundleId"],
    });
  });

  it("time_on_app with empty app id → MISSING_APP (#8795)", async () => {
    const getTimeOnApp = vi.fn();
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      resolveActionArgs: async <TSubaction extends string, TParams>() => ({
        ok: true as const,
        subaction: "time_on_app" as TSubaction,
        // Blank app id reaches the (params.appNameOrBundleId ?? "").trim() guard.
        params: { appNameOrBundleId: "   " } as unknown as TParams,
      }),
      isDarwin: () => true,
      getActivityReport: vi.fn(),
      getTimeOnApp,
      getBrowserDomainActivity: vi.fn(),
      getBrowserActivitySnapshot: vi.fn(),
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: "MISSING_APP" });
    expect(result.text).toContain("Specify an app name or bundle id");
    // Empty target short-circuits before querying activity data.
    expect(getTimeOnApp).not.toHaveBeenCalled();
  });

  it("time_on_site with un-parseable domain → MISSING_DOMAIN (#8795)", async () => {
    const getBrowserDomainActivity = vi.fn();
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      resolveActionArgs: async <TSubaction extends string, TParams>() => ({
        ok: true as const,
        subaction: "time_on_site" as TSubaction,
        // A URL with no host normalizes to "" → MISSING_DOMAIN.
        params: { domain: "https://" } as unknown as TParams,
      }),
      isDarwin: () => false,
      getActivityReport: vi.fn(),
      getTimeOnApp: vi.fn(),
      getBrowserDomainActivity,
      getBrowserActivitySnapshot: vi.fn(),
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: "MISSING_DOMAIN" });
    expect(result.text).toContain("Specify a site domain");
    expect(getBrowserDomainActivity).not.toHaveBeenCalled();
  });

  it("browser_activity with empty snapshot → browser_activity_empty (#8795)", async () => {
    const getBrowserActivitySnapshot = vi.fn(async () => ({
      deviceId: null,
      windowEnd: "2026-05-30T12:00:00.000Z",
      domains: [],
    }));
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply: async ({ fallback }) => ({ kind: "model", text: fallback }),
      resolveActionArgs: async <TSubaction extends string, TParams>() => ({
        ok: true as const,
        subaction: "browser_activity" as TSubaction,
        params: {} as unknown as TParams,
      }),
      isDarwin: () => false,
      getActivityReport: vi.fn(),
      getTimeOnApp: vi.fn(),
      getBrowserDomainActivity: vi.fn(),
      getBrowserActivitySnapshot,
    });

    const result = await runner(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(getBrowserActivitySnapshot).toHaveBeenCalledTimes(1);
    expect(getBrowserActivitySnapshot).toHaveBeenCalledWith(runtime, {
      deviceId: undefined,
    });
    // Empty-domain snapshot succeeds with the empty-state scenario text.
    expect(result.success).toBe(true);
    expect(result.text).toContain("No browser activity has been reported yet");
    expect(result.data).toMatchObject({
      snapshot: { domains: [], deviceId: null },
    });
  });

  it("passes every activity-report app to reply rendering", async () => {
    const apps = Array.from({ length: 25 }, (_, index) => ({
      appName: `App ${index}`,
      bundleId: `com.example.app-${index}`,
      totalMs: index + 1,
    }));
    const renderReply = vi.fn(async ({ fallback }) => ({
      kind: "model" as const,
      text: fallback,
    }));
    const getActivityReport = vi.fn(async () => ({
      sinceMs: 1,
      untilMs: 2,
      totalMs: 325,
      apps,
    }));
    const runner = createScreenTimeActionRunner({
      resolveTimeZone: () => "UTC",
      hasAccess: async () => true,
      createService: () => makeService(),
      messageText: (input) =>
        typeof input.content.text === "string" ? input.content.text : "",
      renderReply,
      resolveActionArgs: async <TSubaction extends string, TParams>() => ({
        ok: true as const,
        subaction: "activity_report" as TSubaction,
        params: {} as unknown as TParams,
      }),
      isDarwin: () => true,
      getActivityReport,
      getTimeOnApp: vi.fn(),
      getBrowserDomainActivity: vi.fn(),
      getBrowserActivitySnapshot: vi.fn(),
    });

    const result = await runner(runtime, message, undefined, undefined);

    expect(getActivityReport).toHaveBeenCalledWith(
      runtime,
      "agent-screen-time",
      { windowMs: 24 * 60 * 60_000 },
    );
    expect(renderReply).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ apps }) }),
    );
    expect(result.data).toMatchObject({ apps });
  });

  it("swaps in optimized screentime_recap instructions for reply rendering", () => {
    const optimizedRuntime = {
      getService: (name: string) =>
        name === "optimized_prompt"
          ? {
              getPrompt: (task: string) =>
                task === "screentime_recap"
                  ? {
                      prompt:
                        "OPTIMIZED: lead with largest app delta and one focus adjustment.",
                      optimizerSource: "gepa",
                    }
                  : null,
            }
          : null,
    } as unknown as IAgentRuntime;

    const rules = buildScreenTimeRecapRules(optimizedRuntime);

    expect(rules.join("\n")).toContain(
      "OPTIMIZED: lead with largest app delta and one focus adjustment.",
    );
    expect(rules.join("\n")).not.toContain(
      "Summarize the owner's screen-time and propose one focus adjustment.",
    );
  });
});
