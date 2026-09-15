/** Tests the trajectory-to-training-corpus conversion (native-export.ts): boundary-row shape, schema/version tagging, and jsonl manifest written to a temp dir. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportScenarioNativeJsonl,
  recordedTrajectoryToNativeRows,
  rowPrivacyAttestation,
  SCENARIO_NATIVE_EXPORT_SCHEMA,
  SCENARIO_NATIVE_SOURCE_KIND,
} from "./native-export.ts";

// Synthetic `RecordedTrajectory` shaped like what
// `JsonFileTrajectoryRecorder` writes under <runDir>/trajectories/<agentId>/.
function syntheticTrajectory() {
  return {
    trajectoryId: "tj-test-1",
    agentId: "agent-test",
    roomId: "room-1",
    runId: "run-1",
    scenarioId: "todos.create-basic",
    rootMessage: {
      id: "msg-1",
      text: "add buy milk to my todos",
      sender: "user",
    },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    status: "finished" as const,
    stages: [
      // Tool-search stage: no model call, must be skipped.
      {
        stageId: "stage-search",
        kind: "toolSearch" as const,
        startedAt: 1_700_000_000_100,
        endedAt: 1_700_000_000_200,
        latencyMs: 100,
        toolSearch: {
          query: { text: "add buy milk" },
          results: [],
          tier: { tierA: [], tierB: [], omitted: 0 },
          durationMs: 100,
        },
      },
      // Planner model call: becomes one eliza_native_v1 row with a tool call.
      {
        stageId: "stage-planner",
        kind: "planner" as const,
        iteration: 1,
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_LARGE",
          modelName: "groq/llama-3.3-70b",
          provider: "groq",
          messages: [
            { role: "system", content: "You are an assistant." },
            { role: "user", content: "add buy milk to my todos" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "CREATE_TODO",
                description: "create a todo",
                parameters: {},
              },
            },
          ],
          toolChoice: "auto",
          response: "Added it.",
          toolCalls: [
            { id: "call_0", name: "CREATE_TODO", args: { text: "buy milk" } },
          ],
          usage: { promptTokens: 120, completionTokens: 14, totalTokens: 134 },
          finishReason: "tool_calls",
          costUsd: 0,
        },
      },
      // Tool execution stage: no model call, must be skipped.
      {
        stageId: "stage-tool",
        kind: "tool" as const,
        startedAt: 1_700_000_000_900,
        endedAt: 1_700_000_000_950,
        latencyMs: 50,
        tool: {
          name: "CREATE_TODO",
          args: { text: "buy milk" },
          result: { ok: true },
          success: true,
          durationMs: 50,
        },
      },
    ],
    metrics: {
      totalLatencyMs: 1000,
      totalPromptTokens: 120,
      totalCompletionTokens: 14,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      plannerIterations: 1,
      toolCallsExecuted: 1,
      toolCallFailures: 0,
      toolSearchCount: 1,
      evaluatorFailures: 0,
      finalDecision: "FINISH" as const,
    },
  };
}

function expectSingleNativeRow(
  rows: ReturnType<typeof recordedTrajectoryToNativeRows>,
) {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("expected one native export row");
  }
  return row;
}

describe("recordedTrajectoryToNativeRows scenario outcome", () => {
  it("omits scenario outcome fields when no outcome is supplied", () => {
    const rows = recordedTrajectoryToNativeRows(syntheticTrajectory() as never);
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBeUndefined();
    expect(row.metadata.scenario_status).toBeUndefined();
  });

  it("stamps a passing scenario outcome on each row", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
    );
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBe("passed");
    expect(row.metadata.scenario_status).toBe("passed");
  });

  it("stamps scenarioStatus='failed' so a failed scenario row is not scored gold", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "failed",
    );
    // The downstream scorer (native_success_and_score) treats scenarioStatus or
    // metadata.scenario_status in {failed,skipped} as success=False/score=0 →
    // rating="repair"/weight=0. Top-level status remains reserved for the
    // canonical native lifecycle contract.
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBe("failed");
    expect(row.metadata.trajectory_status).toBe("finished");
    expect(row.metadata.scenario_status).toBe("failed");
  });
});

describe("recordedTrajectoryToNativeRows", () => {
  it("emits one eliza_native_v1 boundary row per model-call stage", () => {
    const rows = recordedTrajectoryToNativeRows(syntheticTrajectory() as never);
    const row = expectSingleNativeRow(rows);
    expect(row.format).toBe("eliza_native_v1");
    expect(row.schemaVersion).toBe(1);
    expect(row.boundary).toBe("vercel_ai_sdk.generateText");
    // request has at least one user turn
    expect(Array.isArray(row.request.messages)).toBe(true);
    expect(
      (row.request.messages as Array<{ role?: string }>).some(
        (m) => m.role === "user",
      ),
    ).toBe(true);
    expect(row.request.tools).toBeDefined();
    // response has either text or toolCalls
    expect(row.response.text).toBe("Added it.");
    expect(row.response.toolCalls).toEqual([
      {
        toolCallId: "call_0",
        toolName: "CREATE_TODO",
        input: { text: "buy milk" },
      },
    ]);
    expect(row.response.finishReason).toBe("tool_calls");
    expect(row.response.usage).toEqual({
      promptTokens: 120,
      completionTokens: 14,
      totalTokens: 134,
    });
    // identity / bookkeeping
    expect(row.trajectoryId).toBe("tj-test-1");
    expect(row.agentId).toBe("agent-test");
    expect(row.scenarioId).toBe("todos.create-basic");
    expect(row.stepId).toBe("stage-planner");
    expect(row.callId).toBe("tj-test-1:stage-planner");
    expect(row.stepIndex).toBe(1);
    expect(row.callIndex).toBe(0);
    expect(row.provider).toBe("groq");
    expect(row.metadata.task_type).toBe("action_planner");
    expect(row.metadata.source_dataset).toBe("scenario_trajectory_boundary");
    expect(row.metadata.scenario_id).toBe("todos.create-basic");
    expect(row.metadata.source_run_id).toBe("run-1");
  });

  it("does not override a recorded planner purpose from a LifeOps prompt", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "lifeops.calendar-extract";
    traj.stages = [
      {
        stageId: "stage-calendar-extract",
        kind: "planner",
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_SMALL",
          modelName: "test-model",
          provider: "test",
          prompt:
            "Plan the calendar action for this request.\nCurrent request:\nSchedule lunch tomorrow.",
          response:
            '{"subaction":"create_event","shouldAct":true,"queries":[],"title":"Lunch"}',
          usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
          finishReason: "stop",
        },
      },
    ];

    const row = expectSingleNativeRow(
      recordedTrajectoryToNativeRows(traj as never),
    );
    expect(row.metadata.task_type).toBe("action_planner");
    expect(row.metadata.domain).toBeUndefined();
  });

  it("preserves LifeOps task/domain buckets from optimized-prompt purposes", () => {
    const taskKinds = [
      "schedule_plan",
      "reminder_dispatch",
      "inbox_triage",
      "meeting_prep",
      "morning_brief",
    ];
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "lifeops.capability-purpose-smoke";
    traj.stages = taskKinds.map((kind, index) => ({
      stageId: `stage-${kind}`,
      kind,
      startedAt: 1_700_000_000_300 + index,
      endedAt: 1_700_000_000_800 + index,
      latencyMs: 500,
      model: {
        modelType: "TEXT_SMALL",
        modelName: "test-model",
        provider: "test",
        prompt: `Capability prompt for ${kind}.`,
        response: `{"ok":true,"task":"${kind}"}`,
        usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
        finishReason: "stop",
      },
    }));

    const rows = recordedTrajectoryToNativeRows(traj as never);
    expect(rows.map((row) => row.metadata.task_type)).toEqual(taskKinds);
    expect(new Set(rows.map((row) => row.metadata.domain))).toEqual(
      new Set(["lifeops"]),
    );
  });

  it("preserves orchestrator goal-verification task/domain buckets", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "orchestrator.grilling-happy-path";
    traj.stages = [
      {
        stageId: "stage-goal-verify",
        kind: "evaluation",
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_SMALL",
          modelName: "test-model",
          provider: "test",
          prompt: [
            "You are a demanding engineering manager doing final sign-off on a coding sub-agent's work before the parent agent marks the task done.",
            "Acceptance criteria (each must hold for the task to pass):",
            "Completion evidence collected for the sub-agent (git diffstat/changeset, deliverable + final reply, verified URLs, test/build/typecheck output, artifact references):",
          ].join("\n"),
          response:
            '{"passed":false,"summary":"Need proof.","missing":["tests pass with pasted output"]}',
          usage: { promptTokens: 80, completionTokens: 12, totalTokens: 92 },
          finishReason: "stop",
        },
      },
    ];

    const row = expectSingleNativeRow(
      recordedTrajectoryToNativeRows(traj as never),
    );
    expect(row.metadata.task_type).toBe("goal_verification");
    expect(row.metadata.domain).toBe("agent-orchestrator");
  });

  it("skips stages without a usable request/response", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: unknown[];
    };
    traj.stages = [
      {
        stageId: "stage-empty",
        kind: "planner",
        startedAt: 1,
        endedAt: 2,
        latencyMs: 1,
        model: { modelType: "TEXT_LARGE", provider: "groq", response: "" },
      },
    ];
    expect(recordedTrajectoryToNativeRows(traj as never)).toHaveLength(0);
  });

  it("matches the minimal accepted shape from CANONICAL_RECORD.md", () => {
    const NATIVE_BOUNDARIES = new Set([
      "vercel_ai_sdk.generateText",
      "vercel_ai_sdk.streamText",
    ]);
    for (const row of recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
    )) {
      expect(row.format).toBe("eliza_native_v1");
      expect(NATIVE_BOUNDARIES.has(row.boundary)).toBe(true);
      const hasRequest =
        (Array.isArray(row.request.messages) &&
          (row.request.messages as Array<{ role?: string }>).some(
            (m) => m.role === "user",
          )) ||
        (typeof row.request.prompt === "string" &&
          row.request.prompt.length > 0);
      expect(hasRequest).toBe(true);
      const hasResponse =
        (typeof row.response.text === "string" &&
          row.response.text.trim().length > 0) ||
        (Array.isArray(row.response.toolCalls) &&
          row.response.toolCalls.length > 0);
      expect(hasResponse).toBe(true);
    }
  });
});

describe("exportScenarioNativeJsonl", () => {
  it("walks <runDir>/trajectories and writes JSONL, ignoring junk files", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      // A non-trajectory JSON and an unparseable file should be skipped, not fatal.
      writeFileSync(
        path.join(runDir, "trajectories", "matrix.json"),
        JSON.stringify({ totals: {} }),
        "utf-8",
      );
      writeFileSync(path.join(trajDir, "broken.json"), "{not json", "utf-8");

      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(1);
      const lines = readFileSync(outPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toBeDefined();
      if (!line) {
        throw new Error("expected one native JSONL line");
      }
      const parsed = JSON.parse(line);
      expect(parsed.format).toBe("eliza_native_v1");
      expect(parsed.metadata.source_dataset).toBe(
        "scenario_trajectory_boundary",
      );
      expect(parsed.privacyAttestation.schema).toBe(
        "eliza.privacy_filter_attestation.v1",
      );
      expect(parsed.metadata.privacy_attestation.schema).toBe(
        "eliza.privacy_filter_attestation.v1",
      );
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest).toMatchObject({
        schema: SCENARIO_NATIVE_EXPORT_SCHEMA,
        runDir,
        jsonlPath: outPath,
        counts: {
          trajectoryFiles: 3,
          parsedTrajectories: 1,
          skippedFiles: 2,
          rows: 1,
        },
        runIds: ["run-1"],
        scenarioIds: ["todos.create-basic"],
        agentIds: ["agent-test"],
      });
      expect(manifest.privacy).toMatchObject({
        reviewed: true,
        redactions: 0,
        residualFindings: 0,
      });
      const attestation = JSON.parse(
        readFileSync(
          path.join(runDir, "native.privacy-attestation.json"),
          "utf-8",
        ),
      );
      expect(attestation).toMatchObject({
        schema: "eliza.privacy_filter_attestation.v1",
        version: 1,
        passed: true,
        input_count: 1,
        output_count: 1,
        redaction_count: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets and coordinates before writing native JSONL", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-privacy-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      const trajectory = syntheticTrajectory() as ReturnType<
        typeof syntheticTrajectory
      >;
      const planner = trajectory.stages[1];
      if (!planner || !("model" in planner) || !planner.model) {
        throw new Error("synthetic planner stage missing");
      }
      planner.model.messages = [
        {
          role: "user",
          content:
            "My API key is sk-AbCdEfGhIj0123456789 and location: 37.7749, -122.4194.",
        },
      ];
      planner.model.response =
        "Stored ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa near lat: 48.8566, lng: 2.3522.";
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(trajectory),
        "utf-8",
      );

      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);

      expect(count).toBe(1);
      const body = readFileSync(outPath, "utf-8");
      expect(body).not.toContain("sk-AbCdEfGhIj0123456789");
      expect(body).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(body).not.toContain("37.7749");
      expect(body).not.toContain("48.8566");
      expect(body).toContain("<REDACTED:openai-key>");
      expect(body).toContain("<REDACTED:github-token>");
      expect(body).toContain("[REDACTED_GEO]");
      const attestation = JSON.parse(
        readFileSync(
          path.join(runDir, "native.privacy-attestation.json"),
          "utf-8",
        ),
      );
      expect(attestation.passed).toBe(true);
      expect(attestation.redaction_count).toBeGreaterThanOrEqual(4);
      expect(attestation.gate.residual_findings.count).toBe(0);
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest.privacy.redactions).toBe(attestation.redaction_count);
      expect(manifest.privacy.attestationPath).toBe(
        path.join(runDir, "native.privacy-attestation.json"),
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("redacts long coordinate objects without regex backtracking", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-coords-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      const trajectory = syntheticTrajectory() as ReturnType<
        typeof syntheticTrajectory
      >;
      const planner = trajectory.stages[1];
      if (!planner || !("model" in planner) || !planner.model) {
        throw new Error("synthetic planner stage missing");
      }
      planner.model.response = `{"coords":{"latitude":0,"longitude":0${',"A":+\t'.repeat(50_000)}}}`;
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(trajectory),
        "utf-8",
      );

      const outPath = path.join(runDir, "native.jsonl");
      expect(exportScenarioNativeJsonl(runDir, outPath)).toBe(1);
      const body = readFileSync(outPath, "utf-8");
      expect(body).toContain("[REDACTED_GEO]");
      expect(body).not.toContain('"latitude":0');
      const attestation = JSON.parse(
        readFileSync(
          path.join(runDir, "native.privacy-attestation.json"),
          "utf-8",
        ),
      );
      expect(attestation.redaction_count).toBeGreaterThanOrEqual(1);
      expect(attestation.categories.geo).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("redacts across many overlapping malformed coordinate candidates in linear time", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-coords2-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      const trajectory = syntheticTrajectory() as ReturnType<
        typeof syntheticTrajectory
      >;
      const planner = trajectory.stages[1];
      if (!planner || !("model" in planner) || !planner.model) {
        throw new Error("synthetic planner stage missing");
      }
      // Every "coords" marker starts a candidate whose scan runs to the end of
      // the unterminated tail; a non-monotonic cursor would rescan each
      // remaining suffix and go quadratic. The valid block at the front must
      // still be redacted, and the pair pattern catches the malformed tail.
      planner.model.response = `{"coords":{"latitude":3.25,"longitude":4.5}}${'"coords":{"latitude":0,"longitude":0,'.repeat(50_000)}`;
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(trajectory),
        "utf-8",
      );

      const outPath = path.join(runDir, "native.jsonl");
      expect(exportScenarioNativeJsonl(runDir, outPath)).toBe(1);
      const body = readFileSync(outPath, "utf-8");
      expect(body).toContain("[REDACTED_GEO]");
      expect(body).not.toContain("3.25");
      expect(body).not.toContain('latitude\\":0');
      const attestation = JSON.parse(
        readFileSync(
          path.join(runDir, "native.privacy-attestation.json"),
          "utf-8",
        ),
      );
      expect(attestation.categories.geo).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("labels scenario native exports as synthetic, not a reviewed real-user export (#13623)", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-src-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      expect(exportScenarioNativeJsonl(runDir, outPath)).toBe(1);

      const attestation = JSON.parse(
        readFileSync(
          path.join(runDir, "native.privacy-attestation.json"),
          "utf-8",
        ),
      );
      // A clean run still passes the gate, but is truthfully labeled synthetic
      // and NOT a real-user export.
      expect(attestation.passed).toBe(true);
      expect(attestation.sourceKind).toBe(SCENARIO_NATIVE_SOURCE_KIND);
      expect(attestation.sourceKind).toBe("scenario_synthetic");
      expect(attestation.source.kind).toBe("scenario_synthetic");
      expect(attestation.source.realUserExport).toBe(false);
      expect(attestation.privacy.realUserExport).toBe(false);
      expect(attestation.gate.sourceKind).toBe("scenario_synthetic");

      // The per-row marker reflects the real (clean) gate result.
      const row = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(row.privacyAttestation.reviewed).toBe(true);
      expect(row.privacyAttestation.passed).toBe(true);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("rowPrivacyAttestation reflects the real gate result, never a hardcoded pass (#13623)", () => {
    const passing = rowPrivacyAttestation(
      "native.privacy-attestation.json",
      true,
    );
    expect(passing.reviewed).toBe(true);
    expect(passing.passed).toBe(true);

    // A failed gate (residual survived) must NOT stamp reviewed/passed:true.
    const failing = rowPrivacyAttestation(
      "native.privacy-attestation.json",
      false,
    );
    expect(failing.reviewed).toBe(false);
    expect(failing.passed).toBe(false);
  });

  it("threads scenario outcomes so failed trajectories carry scenarioStatus='failed'", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-outcome-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      // The scenario mechanically finished (recorder status "finished") but
      // failed its assertions.
      const outcomes = new Map<string, "passed" | "failed" | "skipped">([
        ["todos.create-basic", "failed"],
      ]);
      const count = exportScenarioNativeJsonl(runDir, outPath, outcomes);
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.status).toBeUndefined();
      expect(parsed.scenarioStatus).toBe("failed");
      expect(parsed.metadata.scenario_status).toBe("failed");
      expect(parsed.metadata.trajectory_status).toBe("finished");
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest.counts).toMatchObject({
        rows: 1,
        passedRows: 0,
        failedRows: 1,
        unknownOutcomeRows: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("writes an empty file when there are no trajectories", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-empty-"));
    try {
      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(0);
      expect(readFileSync(outPath, "utf-8")).toBe("");
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest.counts).toMatchObject({
        trajectoryFiles: 0,
        parsedTrajectories: 0,
        skippedFiles: 0,
        rows: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("writes the jsonl, manifest, and privacy attestation atomically with no leftover temp files", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-atomic-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );

      const outPath = path.join(runDir, "native.jsonl");
      const manifestPath = path.join(runDir, "native.manifest.json");
      const attestationPath = path.join(
        runDir,
        "native.privacy-attestation.json",
      );

      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(1);

      // Every output now lands via writeFileAtomic (temp file + rename). The
      // rename must consume the temp file, so no `.native.*.tmp` sidecar may
      // survive in the output directory. A leftover temp would mean a
      // writeFileSync path slipped back in or the rename never fired.
      const leftovers = readdirSync(runDir).filter((entry) =>
        entry.endsWith(".tmp"),
      );
      expect(leftovers).toEqual([]);

      // The atomically-renamed files carry the fully-written final content.
      const rows = readFileSync(outPath, "utf-8").trim().split("\n");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0] as string).format).toBe("eliza_native_v1");
      expect(JSON.parse(readFileSync(manifestPath, "utf-8")).counts.rows).toBe(
        1,
      );
      expect(JSON.parse(readFileSync(attestationPath, "utf-8")).passed).toBe(
        true,
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("judge score serialization (#8795)", () => {
  it("stamps the numeric judge score on rows and metadata", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
      0.82,
    );
    const row = expectSingleNativeRow(rows);
    expect(row.judgeScore).toBe(0.82);
    expect(row.metadata.judge_score).toBe(0.82);
    // Survives JSON round-tripping as a number, not a detail string.
    const parsed = JSON.parse(JSON.stringify(row));
    expect(parsed.judgeScore).toBe(0.82);
    expect(parsed.metadata.judge_score).toBe(0.82);
  });

  it("omits judge score fields when no judge ran", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
    );
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "judgeScore")).toBe(false);
    expect(Object.hasOwn(row.metadata, "judge_score")).toBe(false);
  });

  it("threads per-scenario judge scores through exportScenarioNativeJsonl", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-judge-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      const outcomes = new Map<string, "passed" | "failed" | "skipped">([
        ["todos.create-basic", "passed"],
      ]);
      const judgeScores = new Map<string, number>([
        ["todos.create-basic", 0.9],
      ]);
      const count = exportScenarioNativeJsonl(
        runDir,
        outPath,
        outcomes,
        judgeScores,
      );
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.scenarioStatus).toBe("passed");
      expect(parsed.judgeScore).toBe(0.9);
      expect(parsed.metadata.judge_score).toBe(0.9);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("leaves rows for unjudged scenarios untouched", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-nojudge-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(
        runDir,
        outPath,
        new Map([["todos.create-basic", "passed" as const]]),
        new Map<string, number>([["some.other-scenario", 0.5]]),
      );
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.judgeScore).toBeUndefined();
      expect(parsed.metadata.judge_score).toBeUndefined();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("scenario tier serialization", () => {
  it("stamps the scenario tier on rows and metadata", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
      0.82,
      "T3",
    );
    const row = expectSingleNativeRow(rows);
    expect(row.tier).toBe("T3");
    expect(row.metadata.tier).toBe("T3");
  });

  it("threads per-scenario tiers through exportScenarioNativeJsonl", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-tier-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      const outcomes = new Map<string, "passed" | "failed" | "skipped">([
        ["todos.create-basic", "passed"],
      ]);
      const judgeScores = new Map<string, number>([
        ["todos.create-basic", 0.9],
      ]);
      const tiers = new Map<string, string>([["todos.create-basic", "T4"]]);
      const count = exportScenarioNativeJsonl(
        runDir,
        outPath,
        outcomes,
        judgeScores,
        tiers,
      );
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.tier).toBe("T4");
      expect(parsed.metadata.tier).toBe("T4");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("native export task provenance", () => {
  it.each([
    ["messageHandler", "RESPONSE_HANDLER", "should_respond"],
    ["planner", "ACTION_PLANNER", "action_planner"],
    ["planner", "TEXT_LARGE", "action_planner"],
  ])(
    "keeps %s in its recorded bucket when catalog and reply mention other tasks",
    (kind, modelType, expectedTask) => {
      const runDir = mkdtempSync(
        path.join(tmpdir(), "scenario-native-purpose-"),
      );
      try {
        const template = syntheticTrajectory();
        const planner = template.stages.find(
          (stage) => stage.kind === "planner",
        );
        if (!planner || !("model" in planner))
          throw new Error("Planner fixture is unavailable");
        const prompt =
          "Answer the current recall request. Authorized catalog: inbox_triage, goal_verification, calendar_extract. The user quotes: triage one inbox item.";
        const response =
          "The names inbox_triage and goal_verification describe available tools, not this request.";
        const trajectory = {
          ...template,
          stages: [
            {
              ...planner,
              kind,
              model: {
                ...planner.model,
                modelType,
                messages: [{ role: "user", content: prompt }],
                prompt,
                response,
              },
            },
          ],
        };
        const trajDir = path.join(runDir, "trajectories", "agent-test");
        mkdirSync(trajDir, { recursive: true });
        writeFileSync(
          path.join(trajDir, "purpose.json"),
          JSON.stringify(trajectory),
        );
        const outPath = path.join(runDir, "native.jsonl");
        exportScenarioNativeJsonl(runDir, outPath);
        const row = JSON.parse(readFileSync(outPath, "utf8").trim());
        expect(row.metadata.task_type).toBe(expectedTask);
        expect(row.metadata.domain).toBeUndefined();
        expect(JSON.stringify(row.request)).toContain(prompt);
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );
});
