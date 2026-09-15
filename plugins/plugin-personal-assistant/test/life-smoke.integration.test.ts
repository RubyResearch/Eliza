/**
 * Smoke tests for the LIFE action -- verifies the full handler chain
 * with a real PGLite-backed LifeOps service and real runtime, exercising
 * the handler path with and without explicit action parameters. Grounded
 * reply generation uses the production canonical fallback deterministically.
 *
 * These simulate what happens when the LLM selects the LIFE action
 * with various parameter combinations:
 *
 *   1. LLM provides `action` param (primary path, reliable)
 *   2. LLM omits `action` but provides `intent` (extractor path)
 *   3. LLM provides both (action wins)
 *   4. LLM provides malformed/missing params (error paths)
 *
 * Run: bunx vitest run eliza/plugins/plugin-personal-assistant/test/life-smoke.integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntime,
  ModelType,
  NoModelProviderConfiguredError,
} from "@elizaos/core";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { runLifeOperationHandler } from "../src/actions/life.js";
import { personalAssistantPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void> = async () => {};
let isolatedStateDir: string;
let isolatedConfigPath: string;
let groundedReplyModelInvocations = 0;
let conversationId: string;

beforeEach(() => {
  // Drafts persist by conversation; only turns within one scenario may reuse them.
  conversationId = randomUUID();
});

const canonicalFallbackPrefix = "Canonical fallback: ";

function parseCanonicalFallback(modelInput: unknown): string {
  if (typeof modelInput !== "object" || modelInput === null) {
    throw new Error("LIFE smoke model input must be an object");
  }

  const prompt = (modelInput as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") {
    throw new Error("LIFE smoke model prompt must be a string");
  }

  const lines = prompt.split("\n");
  const fallbackLines = lines.filter((line) =>
    line.startsWith(canonicalFallbackPrefix),
  );
  const fallbackLine = fallbackLines[0];
  if (
    fallbackLines.length !== 1 ||
    fallbackLine === undefined ||
    lines.at(-1) !== fallbackLine
  ) {
    throw new Error(
      "LIFE smoke model prompt must end with exactly one canonical fallback",
    );
  }

  let fallback: unknown;
  try {
    fallback = JSON.parse(fallbackLine.slice(canonicalFallbackPrefix.length));
  } catch (error) {
    throw new Error("LIFE smoke canonical fallback must be valid JSON", {
      cause: error,
    });
  }
  if (typeof fallback !== "string") {
    throw new Error("LIFE smoke canonical fallback must decode to text");
  }
  return fallback;
}

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedLifeSmokeEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "life-smoke-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );

  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }

  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreIsolatedLifeSmokeEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function send(params: Record<string, unknown>, messageText?: string) {
  return runLifeOperationHandler(
    runtime,
    {
      id: randomUUID(),
      roomId: conversationId,
      entityId: runtime.agentId,
      content: {
        source: "autonomy",
        text: messageText ?? (params.intent as string) ?? "test",
      },
    } as never,
    undefined,
    { parameters: params },
  );
}

// Owner chat (not "autonomy") exercises the confirmation gate — unlike `send`,
// an unconfirmed create here previews instead of persisting immediately.
function sendFromOwnerChat(
  params: Record<string, unknown>,
  messageId: string,
  messageText?: string,
) {
  return runLifeOperationHandler(
    runtime,
    {
      id: messageId,
      roomId: conversationId,
      entityId: runtime.agentId,
      content: {
        source: "discord",
        text: messageText ?? (params.intent as string) ?? "test",
      },
    } as never,
    undefined,
    { parameters: params },
  );
}

beforeAll(async () => {
  setIsolatedLifeSmokeEnv();
  const result = await createRealTestRuntime({
    plugins: [schedulingPlugin, personalAssistantPlugin],
  });
  runtime = result.runtime;
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, modelInput) => {
      groundedReplyModelInvocations += 1;
      return parseCanonicalFallback(modelInput);
    },
    "life-smoke-canonical-fallback",
  );
  // Registering the grounded-reply fixture makes the runtime aware of one
  // text provider. Keep the unrelated TEXT_LARGE extractor path in its exact
  // zero-key state so its existing typed fallback behavior does not turn into
  // the generic "specific delegate missing" error.
  runtime.registerModel(
    ModelType.TEXT_LARGE,
    async () => {
      throw new NoModelProviderConfiguredError();
    },
    "life-smoke-no-large-model",
  );
  cleanup = result.cleanup;
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreIsolatedLifeSmokeEnv();
  if (isolatedStateDir) {
    rmSync(isolatedStateDir, { recursive: true, force: true });
  }
});

describe("LIFE action smoke tests -- BRD acceptance criteria", () => {
  it("preserves the grounded canonical fallback through the deterministic model", () => {
    const fallback = 'Exact fallback with "quotes" and a newline\nkept.';
    expect(
      parseCanonicalFallback({
        prompt: [
          "Grounded LIFE reply",
          `${canonicalFallbackPrefix}${JSON.stringify(fallback)}`,
        ].join("\n"),
      }),
    ).toBe(fallback);
  });

  it.each([
    ["missing marker", "Grounded LIFE reply"],
    ["malformed JSON", `${canonicalFallbackPrefix}{not-json}`],
    ["non-string JSON", `${canonicalFallbackPrefix}${JSON.stringify(42)}`],
    [
      "marker before the final line",
      `${canonicalFallbackPrefix}${JSON.stringify("fallback")}\ntrailing text`,
    ],
    [
      "ambiguous duplicate markers",
      [
        `${canonicalFallbackPrefix}${JSON.stringify("first")}`,
        `${canonicalFallbackPrefix}${JSON.stringify("second")}`,
      ].join("\n"),
    ],
  ])("fails closed for %s", (_case, prompt) => {
    expect(() => parseCanonicalFallback({ prompt })).toThrow();
  });

  it("preserves the typed zero-key fallback for unrelated text extraction", async () => {
    await expect(
      runtime.useModel(ModelType.TEXT_LARGE, { prompt: "extract LIFE fields" }),
    ).rejects.toBeInstanceOf(NoModelProviderConfiguredError);
  });

  // -- AC-1: "I need help brushing my teeth twice a day" --

  it("AC-1: creates a twice-daily brushing habit via action param", async () => {
    const invocationsBefore = groundedReplyModelInvocations;
    const result = await send({
      action: "create",
      intent: "help me brush my teeth twice a day, morning and night",
      title: "Brush teeth",
      details: {
        kind: "habit",
        cadence: {
          kind: "times_per_day",
          slots: [
            {
              key: "morning",
              label: "Morning",
              minuteOfDay: 420,
              durationMinutes: 5,
            },
            {
              key: "night",
              label: "Night",
              minuteOfDay: 1320,
              durationMinutes: 5,
            },
          ],
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
    expect((result as { text: string }).text).toContain("Brush teeth");
    expect(groundedReplyModelInvocations).toBeGreaterThan(invocationsBefore);
  }, 60_000);

  // -- Regression (task_611a9f0b): an unconfirmed RECURRING create from owner
  //    chat must PREVIEW honestly and never claim success while nothing
  //    persisted; confirming it then writes a real definition. Before the fix
  //    the preview branch returned success:true, so a recurring create rendered
  //    "I've set it" with zero rows saved (a no-fabricate violation). --
  it("recurring create previews without fabricating success, then persists on confirm", async () => {
    const recurring = {
      action: "create" as const,
      intent: "remind me to wind down every night around 10pm",
      title: "Wind down",
      details: {
        kind: "habit",
        cadence: { kind: "daily", windows: ["evening"] },
      },
    };

    // Unconfirmed, from owner chat (not "autonomy") -> a PREVIEW, not a save.
    const preview = await sendFromOwnerChat(
      recurring,
      "00000000-0000-0000-0000-000000000011",
    );
    expect(preview).toMatchObject({ success: false });
    expect((preview as { data?: Record<string, unknown> }).data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });

    // Confirming the same recurring create persists a real definition.
    const saved = await sendFromOwnerChat(
      {
        ...recurring,
        details: { ...recurring.details, confirmed: true },
      },
      "00000000-0000-0000-0000-000000000012",
      "Yes, save it.",
    );
    expect(saved).toMatchObject({ success: true });
    expect((saved as { text: string }).text).toContain("Wind down");
  }, 60_000);

  // -- AC-2: Snooze a brushing reminder for 30 minutes --
  // Requires an existing occurrence in the DB. We create a definition first,
  // then get the overview to materialize occurrences, then snooze one.

  it("AC-2: snoozes via action param with 30m preset (end-to-end)", async () => {
    // First create a definition so we have an occurrence to snooze.
    // Uses times_per_day with explicit slots spread across the day so an
    // occurrence is always materializable regardless of when the test runs
    // (a single-window daily cadence would expire after the window passes).
    const createResult = await send({
      action: "create",
      intent: "brush teeth twice a day",
      title: "Brush teeth (snooze test)",
      details: {
        kind: "habit",
        cadence: {
          kind: "times_per_day",
          slots: [
            {
              key: "morning",
              label: "Morning",
              minuteOfDay: 420,
              durationMinutes: 5,
            },
            {
              key: "night",
              label: "Night",
              minuteOfDay: 1320,
              durationMinutes: 5,
            },
          ],
        },
        confirmed: true,
      },
    });
    expect(createResult).toMatchObject({ success: true });

    // Get overview to materialize occurrences and grab a concrete ID. Two
    // slots → two pending occurrences; pass the ID directly so the snooze
    // resolver doesn't have to disambiguate by name.
    const overviewResult = await send({
      action: "overview",
      intent: "give me an overview",
    });
    expect(overviewResult).toMatchObject({ success: true });
    const occurrences =
      (overviewResult?.data as { occurrences?: Array<{ id: string }> })
        ?.occurrences ?? [];
    expect(occurrences.length).toBeGreaterThan(0);
    const targetOccurrenceId = occurrences[0]?.id;
    expect(typeof targetOccurrenceId).toBe("string");

    const result = await send({
      action: "snooze",
      intent: "snooze brushing for 30 minutes",
      target: targetOccurrenceId,
      details: { preset: "30m" },
    });
    expect(result).toMatchObject({ success: true });
  }, 60_000);

  // -- AC-3: "Add one push-up and sit-up every day" (progressive) --

  it("AC-3: creates a progressive daily routine", async () => {
    const result = await send({
      action: "create",
      intent: "add one push-up every day, start at 10 and add one each day",
      title: "Daily pushups",
      details: {
        kind: "routine",
        cadence: { kind: "daily", windows: ["morning"] },
        progressionRule: {
          kind: "linear_increment",
          metric: "push-ups",
          start: 10,
          step: 1,
          unit: "reps",
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
  }, 60_000);

  // -- AC-4: "I want to call my mom every week" --

  it("AC-4: creates an explicitly named weekly goal", async () => {
    const result = await send({
      action: "create_goal",
      intent: "Actually create a goal called Call Mom every week",
      title: "Call Mom every week",
      details: {
        cadence: { kind: "weekly" },
        successCriteria: {
          summary: "Call Mom at least once every calendar week.",
          metric: "weekly_call_completed",
          target: { callsPerWeek: 1 },
          evidenceSignals: ["manual_checkin"],
        },
        supportStrategy: {
          approach: "weekly_nudge",
          message: "Have you called Mom this week?",
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
    // The handler should create the goal (confirmed: true) — the response
    // text may confirm the title or ask a follow-up depending on the LLM.
    // We verify goal creation succeeded via the success flag above.
    const text = (result as { text: string }).text;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  // -- AC-5: Calendar query --
  // Since the built-in Eliza calendar (#17914) every agent has one writable
  // calendar source without an external account, so an unconnected agent
  // answers from the (empty) built-in calendar instead of reporting
  // calendar access as unavailable.

  it("AC-5: calendar answers from the built-in calendar when no external calendar is connected", async () => {
    const result = await send({
      action: "calendar",
      intent: "what's on my calendar today",
    });

    expect(result).toMatchObject({
      success: true,
      text: expect.stringMatching(/calendar is clear|events? today/i),
    });
  }, 60_000);

  // -- AC-7: Email query --
  // Same as calendar: without Google connector, should report not connected.

  it("AC-7: email reports not connected when Google is not configured", async () => {
    const result = await send({
      action: "email",
      intent: "do I have any important emails?",
    });

    expect(result).toMatchObject({ success: false });
  }, 60_000);
});

describe("LIFE action -- robustness scenarios", () => {
  it("handles complete -> target not found gracefully", async () => {
    const result = await send({
      action: "complete",
      intent: "mark nonexistent done",
      target: "nonexistent",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("could not find"),
    });
  }, 60_000);

  it("handles create without title gracefully", async () => {
    const result = await send({
      action: "create",
      intent: "add something",
      details: {
        cadence: { kind: "daily", windows: ["morning"] },
        confirmed: true,
      },
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/call|name/i),
    });
  }, 60_000);

  it("handles create without cadence gracefully", async () => {
    const result = await send({
      action: "create",
      intent: "add pushups",
      title: "Pushups",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/when|schedule/i),
    });
  }, 60_000);

  it("handles Google not connected for calendar via the built-in calendar", async () => {
    // The built-in Eliza calendar (#17914) keeps calendar queries answerable
    // without Google; an unconnected agent reads its own (empty) calendar.
    const result = await send({
      action: "calendar",
      intent: "what's on my calendar",
    });
    expect(result).toMatchObject({
      success: true,
      text: expect.stringMatching(/calendar is clear|events? today/i),
    });
  }, 60_000);

  it("handles phone capture without number gracefully", async () => {
    const result = await send({
      action: "phone",
      intent: "text me reminders",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("phone number"),
    });
  }, 60_000);

  it("handles empty intent gracefully", async () => {
    const result = await send({ action: "overview", intent: "" }, "");
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/tell me|intent/i),
    });
  }, 60_000);

  it("handles missing action + intent", async () => {
    const result = await send({ intent: "asdfghjkl gibberish" });
    // Without explicit action and with gibberish, handler should clarify (noop)
    expect(result).toMatchObject({ success: true });
    expect((result as { data?: { noop?: boolean } }).data).toMatchObject({
      noop: true,
    });
  }, 60_000);

  it("action param takes precedence over classifier when both disagree", async () => {
    // "review the calendar" would classify as review_goal via regex,
    // but action says "calendar" -- action wins
    const result = await send({
      action: "calendar",
      intent: "review the calendar",
    });
    // The calendar action answers from the built-in Eliza calendar (empty for
    // this agent), proving the action param was used: review_goal would have
    // replied about goals, not the day's calendar.
    expect(result).toMatchObject({
      success: true,
      text: expect.stringMatching(/calendar is clear|events? today/i),
    });
  }, 60_000);
});
