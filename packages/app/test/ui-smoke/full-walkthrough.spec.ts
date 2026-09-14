/**
 * full-walkthrough.spec.ts — the continuous, narrated, analyzed, recorded
 * full-journey walkthrough JOURNEY.md promised and #10198 / #10204 asked for.
 *
 * One ordered flow (see `walkthrough/journey.ts` for the step list) drives the
 * REAL app surface from cold launch through onboarding, the chat-native
 * tutorial, typed tutorial commands,
 * settings, wallet, a real chat conversation, view switching, a settings edit,
 * and back to the dashboard — at BOTH a desktop and a mobile viewport. Each step
 * captures a `NN-<step>.png` screenshot plus a per-step manifest (URL, viewport,
 * DOM markers, the console/network diagnostics that accrued, the assertions that
 * passed). The whole run is gated on page errors / console errors / 5xx.
 *
 * Lanes (WALKTHROUGH_LANE):
 *   - "mock" (default, keyless PR lane): conversations are page-mocked so chat is
 *     deterministic with no provider key.
 *   - "live": no conversation mock — the chat step hits the real backend agent +
 *     model booted by playwright-ui-live-stack.ts (ELIZA_UI_SMOKE_LIVE_STACK=1).
 *     The real-model trajectory is written to `<run>/<viewport>/trajectory/`.
 *
 * Artifacts land under `reports/walkthrough/<runId>/` (gitignored); the
 * committed verdict markdown is produced by `scripts/ai-qa/review-walkthrough.mjs`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestInfo, test } from "@playwright/test";
import {
  installJourneyRoutes,
  JOURNEY_STEPS,
  type Lane,
  VIEWPORT_PROFILES,
  type ViewportProfile,
  WalkthroughRecorder,
} from "./walkthrough/journey";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/app/test/ui-smoke → up 4 levels = repo root.
const REPO_ROOT = resolve(HERE, "../../../..");
const RUN_ID =
  process.env.WALKTHROUGH_RUN_ID?.trim() ||
  new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = resolve(REPO_ROOT, "reports", "walkthrough", RUN_ID);
const LANE: Lane = process.env.WALKTHROUGH_LANE === "live" ? "live" : "mock";

const VIEWPORT_FILTER = (process.env.WALKTHROUGH_VIEWPORTS ?? "desktop,mobile")
  .split(",")
  .map((v) => v.trim())
  .filter((v): v is "desktop" | "mobile" => v === "desktop" || v === "mobile");

// A stable wall clock for records — Playwright tests may run under fake timers
// elsewhere, but here we want real ISO stamps for the evidence bundle.
const nowIso = () => new Date().toISOString();

// Per-step budget. A single step should never consume the whole test budget —
// if a selector/wait hangs, fail that step fast (capture + record), then keep
// driving so the run always yields a complete, honest gate instead of a blank
// timeout. Generous enough for the heaviest navigation + model-wait step.
const STEP_TIMEOUT_MS = Number(
  process.env.WALKTHROUGH_STEP_TIMEOUT_MS || "120000",
);

function withStepTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `step '${label}' exceeded ${STEP_TIMEOUT_MS}ms budget (likely a hung wait)`,
            ),
          ),
        STEP_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

async function writeRunManifest(): Promise<void> {
  await mkdir(RUN_DIR, { recursive: true });
  const manifest = {
    runId: RUN_ID,
    lane: LANE,
    generatedAt: nowIso(),
    host: { platform: process.platform, arch: process.arch },
    git: { sha: process.env.WALKTHROUGH_GIT_SHA ?? null },
    command:
      process.env.WALKTHROUGH_COMMAND ??
      `playwright test full-walkthrough.spec.ts (lane=${LANE})`,
    provider: process.env.ELIZA_UI_SMOKE_LIVE_PROVIDER ?? null,
    model:
      process.env.ANTHROPIC_LARGE_MODEL ??
      process.env.OPENAI_LARGE_MODEL ??
      process.env.WALKTHROUGH_MODEL ??
      null,
    viewports: VIEWPORT_FILTER,
    steps: JOURNEY_STEPS.map((s) => ({
      n: s.n,
      id: s.id,
      title: s.title,
      expectation: s.expectation,
      desktopOnly: !!s.desktopOnly,
    })),
  };
  await writeFile(
    join(RUN_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

async function runJourneyAtViewport(
  browser: import("@playwright/test").Browser,
  profile: ViewportProfile,
  testInfo: TestInfo,
): Promise<void> {
  const context = await browser.newContext({
    viewport: profile.size,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    recordVideo:
      process.env.E2E_RECORD === "1"
        ? { dir: join(RUN_DIR, profile.id, "video"), size: profile.size }
        : undefined,
  });
  const page = await context.newPage();
  const recorder = new WalkthroughRecorder(
    page,
    LANE,
    profile,
    RUN_DIR,
    nowIso,
  );
  recorder.attach();
  const routes = await installJourneyRoutes(page, LANE);

  const failures: Array<{ step: string; error: string }> = [];

  try {
    for (const step of JOURNEY_STEPS) {
      recorder.beginStep(step);
      if (step.desktopOnly && profile.id !== "desktop") {
        await recorder.captureStep(
          step,
          {
            assertions: [],
            skipped: true,
            skipReason: "desktop-only step skipped at mobile viewport",
          },
          testInfo,
        );
        continue;
      }
      const stepStart = Date.now();
      console.log(`[walkthrough:${profile.id}] ▶ ${step.n}-${step.id} …`);
      try {
        const result = await withStepTimeout(
          step.run({ page, lane: LANE, viewport: profile, routes }),
          `${step.n}-${step.id}`,
        );
        await recorder.captureStep(step, result, testInfo);
        console.log(
          `[walkthrough:${profile.id}] ✓ ${step.n}-${step.id} (${Date.now() - stepStart}ms)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ step: `${step.n}-${step.id}`, error: message });
        console.log(
          `[walkthrough:${profile.id}] ✗ ${step.n}-${step.id} (${Date.now() - stepStart}ms): ${message.split("\n")[0]}`,
        );
        // Capture a best-effort failure screenshot so the bundle is complete.
        await recorder
          .captureStep(
            step,
            {
              assertions: [`FAILED: ${message.split("\n")[0]}`],
              dom: { failed: true },
            },
            testInfo,
          )
          .catch(() => undefined);
      }
    }
  } finally {
    await recorder.finalize();
    await context.close();
  }

  const gate = recorder.gateSummary();
  await writeFile(
    join(RUN_DIR, profile.id, "gate.json"),
    JSON.stringify({ failures, gate }, null, 2),
  );

  // Honest gate: complete artifacts above, hard failure here. The run fails on
  // any failed step, any page/console error, or any 5xx — exactly the issue's
  // failure conditions.
  if (failures.length > 0) {
    throw new Error(
      `[full-walkthrough:${profile.id}] ${failures.length} step(s) failed:\n` +
        failures
          .map((f) => `  - ${f.step}: ${f.error.split("\n")[0]}`)
          .join("\n"),
    );
  }
  if (!gate.ok) {
    throw new Error(
      `[full-walkthrough:${profile.id}] page diagnostics gate failed:\n` +
        `  page/console errors: ${JSON.stringify(gate.pageAndConsoleErrors, null, 2)}\n` +
        `  server (5xx) errors: ${JSON.stringify(gate.serverErrors, null, 2)}`,
    );
  }
}

test.describe("full walkthrough", () => {
  test.describe.configure({ mode: "default" });

  test.beforeAll(async () => {
    await writeRunManifest();
  });

  for (const viewportId of VIEWPORT_FILTER) {
    const profile = VIEWPORT_PROFILES[viewportId];
    test(`journey @ ${viewportId} (${LANE} lane)`, async ({
      browser,
    }, testInfo) => {
      // Ceiling only — a healthy journey finishes in ~8 min. Generous so the run
      // still completes (full gate) even if a few steps hit their per-step cap.
      test.setTimeout(1_800_000);
      await runJourneyAtViewport(browser, profile, testInfo);
    });
  }
});
