/**
 * End-to-end trajectory capture verification.
 *
 * Reproduces and guards the dual-writer failure where the agent bridge and core
 * service both handled one capture despite owning incompatible step/reward
 * shapes. The installed bridge owns lifecycle, writes, and reads together;
 * this suite proves its real PGlite row and HTTP read boundary stay coherent.
 *
 * The test drives the exact provider/LLM capture primitives used by the runtime,
 * drains every queue, reads the active and completed metrics from SQL, exercises
 * the real viewer read routes, and checks a clean idle diagnostic tail.
 */

import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type Action,
  AgentRuntime,
  ChannelType,
  DefaultMessageService,
  drainPostDeliveryTasks,
  executePlannedToolCall,
  getTrajectoryContext,
  type Memory,
  ModelType,
  type Plugin,
  type Provider,
  runWithTrajectoryContext,
  TrajectoriesService,
  trajectoriesPlugin,
  tryHandleTrajectoryReadRoutes,
  type UUID,
  withEvaluatorStep,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../api/server.ts";
import {
  type DevTrajectoryRecoveryRegistration,
  type DevTrajectoryRecoveryTransport,
  prepareDevTrajectoryRecovery,
} from "./dev-trajectory-recovery.ts";
import type { DevTrajectoryRecoveryOwner } from "./dev-trajectory-recovery-protocol.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge.ts";
import {
  asRecord,
  createBaseTrajectory,
  ensureTrajectoriesTable,
  executeRawSql,
  extractRows,
  loadTrajectoryById,
  loadTrajectoryByStepId,
  parseMetadata,
  saveTrajectory,
} from "./trajectory-internals.ts";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { loadPersistedTrajectoryRows } from "./trajectory-query.ts";
import { getSteps } from "./trajectory-steps-reader.ts";
import {
  clearAllSteps,
  deleteStepsForTrajectories,
  upsertStep,
} from "./trajectory-steps-writer.ts";
import {
  __getTrajectoryBridgeStateCountsForTests,
  annotateTrajectoryStep,
  clearPersistedTrajectoryRows,
  DatabaseTrajectoryLogger,
  flushTrajectoryWrites,
  startTrajectoryStepInDatabase,
} from "./trajectory-storage.ts";

interface CapturedLlmCall {
  provider?: string;
  model?: string;
  purpose?: string;
}
interface TrajectoryDetailLike {
  steps?: Array<{
    stepId?: string;
    parentStepId?: string;
    childSteps?: string[];
    evaluatorName?: string;
    kind?: string;
    llmCalls?: CapturedLlmCall[];
    providerAccesses?: Array<{
      providerId?: string;
      providerName?: string;
      timestamp?: number;
      purpose?: string;
      data?: Record<string, unknown>;
    }>;
    action?: {
      actionName?: string;
      success?: boolean;
      result?: Record<string, unknown>;
    };
  }>;
  metrics?: { episodeLength?: number; finalStatus?: string };
}
interface TrajLogger {
  setEnabled?: (enabled: boolean) => void;
  startTrajectory: (
    agentId: string,
    opts?: {
      agentId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<string>;
  startStep: DatabaseTrajectoryLogger["startStep"];
  getCurrentStepId?: (trajectoryId: string) => string | null;
  logLlmCall: (params: Record<string, unknown>) => void;
  logProviderAccess: (params: Record<string, unknown>) => void;
  endTrajectory: (trajectoryId: string, status?: string) => Promise<void>;
  flushWriteQueue?: (trajectoryId: string) => Promise<void>;
  listTrajectories: (opts?: { limit?: number; offset?: number }) => Promise<{
    trajectories: Array<{ id: string; llmCallCount: number }>;
    total: number;
  }>;
  getTrajectoryDetail: (id: string) => Promise<TrajectoryDetailLike | null>;
  deleteTrajectories: (ids: string[]) => Promise<number>;
  exportTrajectories: (options: {
    format: "jsonl" | "json";
    trajectoryIds?: string[];
  }) => Promise<{ data: string }>;
}

type LifecycleTrajLogger = TrajLogger & {
  releaseTrajectoryOwnership: (stepIdOrTrajectoryId: string) => void;
  stop: () => Promise<void>;
};

type TrajectoryEventHandler = (
  payload: Record<string, unknown>,
) => Promise<void>;

function trajectoryEventHandler(
  event: "MESSAGE_RECEIVED" | "RUN_STARTED" | "MESSAGE_SENT" | "RUN_ENDED",
): TrajectoryEventHandler {
  const handlers = (
    trajectoriesPlugin.events as Record<string, TrajectoryEventHandler[]>
  )[event];
  const handler = handlers?.[0];
  if (!handler) throw new Error(`Missing trajectories ${event} handler`);
  return handler;
}

async function readRoute(pathname: string): Promise<{
  status: number;
  body: unknown;
}> {
  const state = { status: 0, body: undefined as unknown };
  const response = {
    statusCode: 0,
    setHeader() {},
    end(payload?: string) {
      state.status = response.statusCode;
      state.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
  const url = new URL(`http://localhost${pathname}`);
  const handled = await tryHandleTrajectoryReadRoutes({
    pathname: url.pathname,
    method: "GET",
    url,
    runtime,
    res: response,
  });
  expect(handled).toBe(true);
  return state;
}

async function readMetrics(
  trajectoryId: string,
): Promise<Record<string, unknown>> {
  const result = await executeRawSql(
    runtime,
    `SELECT metrics_json FROM trajectories WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
  );
  const row = asRecord(extractRows(result)[0]);
  return parseMetadata(row?.metrics_json);
}

function llmCall(
  stepId: string,
  provider: string,
  model: string,
  text: string,
) {
  return {
    stepId,
    model,
    modelType: "TEXT_LARGE",
    provider,
    systemPrompt: "You are a test agent.",
    userPrompt: "Say hello.",
    prompt: "Say hello.",
    response: text,
    temperature: 0,
    maxTokens: 64,
    purpose: "action",
    actionType: "runtime.useModel",
    latencyMs: 12,
    promptTokens: 8,
    completionTokens: 4,
  };
}

function directResponseEnvelope(replyText: string) {
  return {
    text: "",
    toolCalls: [
      {
        id: "terminal-owner-response",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          thought: "Direct answer.",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          replyText,
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      },
    ],
    finishReason: "tool_calls",
  };
}

function recordLoggerCapture(
  logger: LifecycleTrajLogger,
  captureType: "llm" | "provider",
  stepId: string,
  label: string,
): void {
  if (captureType === "llm") {
    logger.logLlmCall(llmCall(stepId, "openai", label, `capture ${label}`));
    return;
  }
  logger.logProviderAccess({
    stepId,
    providerName: label,
    purpose: "context",
    data: { label },
  });
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

function sharedDatabaseRuntime(agentId: string): AgentRuntime {
  const source = runtime as unknown as Record<string, unknown>;
  return {
    agentId,
    runtimeInstanceId: crypto.randomUUID(),
    adapter: source.adapter,
    actions: [],
    getSetting: () => null,
    getRoom: async () => null,
    getService: () => null,
    getServicesByType: () => [],
    reportError: vi.fn(),
    logger: runtime.logger,
  } as unknown as AgentRuntime;
}

type TestSqlExecutor = {
  execute: (query: unknown) => Promise<unknown>;
};

type TestRuntimeDb = TestSqlExecutor & {
  transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) => Promise<T>;
};

function transactionGatedRuntime(agentId: string): {
  runtime: AgentRuntime;
  transactions: { count: number };
  gate: {
    arm: () => void;
    entered: Promise<void>;
    release: () => void;
  };
} {
  const gatedRuntime = sharedDatabaseRuntime(agentId);
  const baseDb = (gatedRuntime as unknown as { adapter: { db: TestRuntimeDb } })
    .adapter.db;
  let armed = false;
  let used = false;
  let markEntered: () => void = () => {};
  let releaseTransaction: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  const transactions = { count: 0 };
  const gatedDb: TestRuntimeDb = {
    execute: baseDb.execute.bind(baseDb),
    transaction: async <T>(
      callback: (tx: TestSqlExecutor) => Promise<T>,
    ): Promise<T> => {
      transactions.count += 1;
      if (armed && !used) {
        used = true;
        markEntered();
        await released;
      }
      return baseDb.transaction(callback);
    },
  };
  (gatedRuntime as unknown as { adapter: { db: TestRuntimeDb } }).adapter = {
    db: gatedDb,
  };
  return {
    runtime: gatedRuntime,
    transactions,
    gate: {
      arm: () => {
        armed = true;
      },
      entered,
      release: releaseTransaction,
    },
  };
}

async function installedDatabaseLogger(
  agentId: string,
  installedRuntime = sharedDatabaseRuntime(agentId),
): Promise<{
  runtime: AgentRuntime;
  logger: LifecycleTrajLogger;
}> {
  let enabled = true;
  const candidate = {
    isEnabled: () => enabled,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    logLlmCall: () => {},
    logProviderAccess: () => {},
    stop: async () => {},
  };
  Object.assign(installedRuntime as unknown as Record<string, unknown>, {
    getService: () => candidate,
    getServicesByType: () => [candidate],
  });
  await installDatabaseTrajectoryLogger(installedRuntime);
  const installed = candidate as unknown as LifecycleTrajLogger;
  installed.setEnabled?.(true);
  return { runtime: installedRuntime, logger: installed };
}

async function databaseLogger(
  mode: "public" | "installed",
  agentId: string,
  loggerRuntime = sharedDatabaseRuntime(agentId),
): Promise<{ runtime: AgentRuntime; logger: LifecycleTrajLogger }> {
  if (mode === "installed") {
    return installedDatabaseLogger(agentId, loggerRuntime);
  }
  await ensureTrajectoriesTable(loggerRuntime);
  const logger = new DatabaseTrajectoryLogger(
    loggerRuntime,
  ) as LifecycleTrajLogger;
  logger.setEnabled?.(true);
  return { runtime: loggerRuntime, logger };
}

async function shutdownLogger(
  mode: "public" | "installed",
  target: AgentRuntime,
) {
  if (mode === "public") return databaseLogger(mode, target.agentId, target);
  const native = new TrajectoriesService(target);
  native.setEnabled(true);
  await native.initialize();
  Object.assign(target, {
    getService: () => native,
    getServicesByType: () => [native],
  });
  await installDatabaseTrajectoryLogger(target);
  await ensureTrajectoriesTable(target);
  native.setEnabled(true);
  return { runtime: target, logger: native as unknown as LifecycleTrajLogger };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function recoveryLogger(
  mode: "public" | "installed",
  prior?: AgentRuntime,
) {
  const target = sharedDatabaseRuntime(prior?.agentId ?? crypto.randomUUID());
  if (prior)
    Object.assign(target, { runtimeInstanceId: prior.runtimeInstanceId });
  const fixture = await shutdownLogger(mode, target);
  if (mode === "public")
    Object.assign(target, {
      getService: () => fixture.logger,
      getServicesByType: () => [fixture.logger],
    });
  return fixture;
}

function recoveryTransport(owners: DevTrajectoryRecoveryOwner[] = []) {
  let registered!: DevTrajectoryRecoveryOwner;
  const registerOwner = vi.fn(
    async (
      owner: DevTrajectoryRecoveryOwner,
    ): Promise<DevTrajectoryRecoveryRegistration> => {
      registered = structuredClone(owner);
      return { owner, recoveryBatchId: crypto.randomUUID(), owners };
    },
  );
  const acknowledgeRecovery = vi.fn(async () => {});
  return {
    registerOwner,
    acknowledgeRecovery,
    get owner() {
      return registered;
    },
  };
}

function interceptRecoverySql(
  target: AgentRuntime,
  intercept: (
    text: string,
    run: () => Promise<unknown>,
    transaction: boolean,
  ) => Promise<unknown>,
) {
  const source = (
    target as unknown as {
      adapter: TestRuntimeDb & {
        db: TestRuntimeDb;
        getPgliteDataDir: () => string;
        getConnection: () => Promise<unknown>;
      };
    }
  ).adapter;
  const base = source.db;
  const db: TestRuntimeDb = {
    execute: (query) =>
      intercept(sqlText(query), () => base.execute(query), false),
    transaction: (callback) =>
      base.transaction((tx) =>
        callback({
          execute: (query) =>
            intercept(sqlText(query), () => tx.execute(query), true),
        }),
      ),
  };
  Object.assign(target, {
    adapter: {
      db,
      getPgliteDataDir: source.getPgliteDataDir.bind(source),
      getConnection: async () => {
        await source.getConnection();
        return db;
      },
    },
  });
}

let runtime: AgentRuntime;
let pgliteDir: string;
const prevPgliteDir = process.env.PGLITE_DATA_DIR;

const viewsAction: Action = {
  name: "VIEWS",
  description: "Open a named test view after model-assisted resolution.",
  contexts: ["general"],
  parameters: [
    {
      name: "view",
      description: "View to open.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (actionRuntime, _message, _state, options) => {
    const resolution = await actionRuntime.useModel(ModelType.TEXT_SMALL, {
      prompt: "Resolve the requested calendar view.",
    });
    const parameters = asRecord(options?.parameters);
    if (typeof parameters?.view !== "string") {
      throw new Error("VIEWS fixture requires a string view parameter");
    }
    const view = parameters.view;
    return {
      success: true,
      text: `Opened ${view}.`,
      data: { actionName: "VIEWS", view, resolution },
    };
  },
};

const trajectoryActionPlugin: Plugin = {
  name: "trajectory-action-round-trip",
  description: "Deterministic nested-model action for trajectory persistence.",
  actions: [viewsAction],
  models: {
    [ModelType.TEXT_SMALL]: async () => "calendar",
  },
};

beforeAll(async () => {
  // Mirror @elizaos/core/testing createTestRuntime inline (the testing subpath
  // is not aliased in the agent's vitest config). Real PGLite-backed runtime;
  // trajectories load by default (enableTrajectories defaults on).
  pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-traj-e2e-"));
  process.env.PGLITE_DATA_DIR = pgliteDir;

  runtime = new AgentRuntime({
    character: { name: "TrajCapture" },
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  const pluginSqlModule = (await import(
    ["@elizaos", "plugin-sql"].join("/")
  )) as { default?: Plugin; elizaPlugin?: Plugin };
  const pluginSql = pluginSqlModule.default ?? pluginSqlModule.elizaPlugin;
  if (!pluginSql) throw new Error("plugin-sql did not export a plugin");
  await runtime.registerPlugin(pluginSql);
  await runtime.registerPlugin(trajectoryActionPlugin);
  await runtime.initialize();

  // The "trajectories" native-feature service (enabled by default) starts
  // asynchronously after DB init — the real boot waits via
  // waitForTrajectoriesService before installing the bridge.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !runtime.getService("trajectories")) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // The boot wiring under test (prepareRuntimeForTrajectoryCapture installs this).
  await installDatabaseTrajectoryLogger(runtime);
  (
    runtime.getService("trajectories") as unknown as TrajLogger | null
  )?.setEnabled?.(true);
}, 180_000);

afterAll(async () => {
  try {
    await runtime?.stop();
  } catch (error) {
    // error-policy:J6 test teardown must continue to restore the environment.
    void error;
  }
  if (prevPgliteDir === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = prevPgliteDir;
  }
  if (pgliteDir) {
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch (error) {
      // error-policy:J6 temporary PGlite cleanup is best-effort at suite exit.
      void error;
    }
  }
});

describe("trajectory capture -> DB -> viewer", () => {
  it("serves stored trajectory text to its HTTP owner and denies a non-owner", async () => {
    const keys = [
      "ELIZA_STATE_DIR",
      "ELIZA_CONFIG_PATH",
      "ELIZA_PERSIST_CONFIG_PATH",
      "ELIZA_API_BIND_HOST",
      "ELIZA_API_TOKEN",
      "ELIZA_API_AUTH_TOKEN",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_REQUIRE_LOCAL_AUTH",
      "AGENT_SERVER_SHARED_SECRET",
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      process.env.ELIZA_STATE_DIR = pgliteDir;
      process.env.ELIZA_CONFIG_PATH = path.join(
        pgliteDir,
        "http-test-config.json",
      );
      process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
      process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
      for (const key of [
        "ELIZA_API_TOKEN",
        "ELIZA_API_AUTH_TOKEN",
        "ELIZA_CLOUD_PROVISIONED",
        "ELIZA_REQUIRE_LOCAL_AUTH",
        "AGENT_SERVER_SHARED_SECRET",
      ])
        delete process.env[key];
      setAgentHostBridge({
        ...defaultAgentHostBridge,
        resolveHttpRequestAuthorization: async (req) => ({
          ok: true,
          role:
            req.headers.authorization === "Bearer trajectory-owner-fixture"
              ? "OWNER"
              : "USER",
          identityId: "synthetic-http-principal",
        }),
      });
      const logger = runtime.getService(
        "trajectories",
      ) as unknown as TrajLogger;
      const trajectoryId = await logger.startTrajectory(runtime.agentId);
      const stepId = logger.startStep(trajectoryId);
      const exactResponse = "HTTP owner fixture: exact Unicode ✓\nsecond line";
      logger.logLlmCall(
        llmCall(stepId, "fixture", "fixture-model", exactResponse),
      );
      await logger.endTrajectory(trajectoryId, "completed");
      await flushTrajectoryWrites(runtime);
      api = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const url = `http://127.0.0.1:${api.port}/api/trajectories/${trajectoryId}`;
      const headers = { "x-forwarded-for": "203.0.113.10" };
      const rejected = await fetch(url, { headers });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({ error: "Owner role required" });
      const accepted = await fetch(url, {
        headers: {
          ...headers,
          Authorization: "Bearer trajectory-owner-fixture",
        },
      });
      expect(accepted.status).toBe(200);
      const detail = await accepted.json();
      expect(detail).toMatchObject({ llmCalls: [{ response: exactResponse }] });
      const stored = await logger.getTrajectoryDetail(trajectoryId);
      expect(stored).toMatchObject({
        steps: [{ llmCalls: [{ response: exactResponse }] }],
      });
    } finally {
      await api?.close();
      _resetAgentHostBridge();
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  describe.each(["public", "installed"] as const)(
    "%s supervised dev recovery",
    (mode) => {
      it("settles only confirmed dead execution rows, preserving sibling, terminal and legacy payloads", async () => {
        const dead = await recoveryLogger(mode);
        const registration = recoveryTransport();
        await expect(
          prepareDevTrajectoryRecovery(dead.runtime, registration),
        ).resolves.toBe("prepared");
        const active = await dead.logger.startTrajectory(dead.runtime.agentId, {
          metadata: {
            runtimeExecutionOwnerId: "caller-forged",
            note: "preserve metadata",
          },
        });
        const noStep = await dead.logger.startTrajectory(dead.runtime.agentId);
        const child = dead.logger.startStep(active);
        dead.logger.logLlmCall(
          llmCall(
            child,
            "cerebras",
            "recovery",
            "Preserve exact recorded response.",
          ),
        );
        const terminal = await dead.logger.startTrajectory(
          dead.runtime.agentId,
        );
        const legacy = await dead.logger.startTrajectory(dead.runtime.agentId);
        await flushTrajectoryWrites(dead.runtime);
        await executeRawSql(
          dead.runtime,
          `UPDATE trajectories SET metadata_json = (metadata_json::jsonb - 'runtimeTrajectoryOwnerId' - 'runtimeExecutionOwnerId') WHERE id = '${legacy}'`,
        );
        const live = await recoveryLogger(mode, dead.runtime);
        const liveRegistration = recoveryTransport();
        await prepareDevTrajectoryRecovery(live.runtime, liveRegistration);
        const liveId = await live.logger.startTrajectory(live.runtime.agentId);
        await flushTrajectoryWrites(live.runtime);
        await live.logger.endTrajectory(terminal, "completed");
        const before = await loadTrajectoryById(dead.runtime, active);
        expect(before?.metadata.runtimeExecutionOwnerId).toBe(
          registration.owner.runtimeExecutionOwnerId,
        );
        expect(liveRegistration.owner.runtimeExecutionOwnerId).not.toBe(
          registration.owner.runtimeExecutionOwnerId,
        );
        expect(liveRegistration.owner.runtimeInstanceId).toBe(
          registration.owner.runtimeInstanceId,
        );
        const terminalBefore = await loadTrajectoryById(dead.runtime, terminal);
        const liveBefore = await loadTrajectoryById(live.runtime, liveId);
        const legacyBefore = await loadTrajectoryById(dead.runtime, legacy);
        // A routed capture or reused explicit ID must not transfer execution ownership.
        await live.logger.startTrajectory(active, {
          agentId: live.runtime.agentId,
          metadata: {
            runtimeExecutionOwnerId:
              liveRegistration.owner.runtimeExecutionOwnerId,
          },
        });
        await flushTrajectoryWrites(live.runtime);
        expect(
          (await loadTrajectoryById(dead.runtime, active))?.metadata,
        ).toEqual(before?.metadata);
        const replacement = await recoveryLogger(mode, dead.runtime);
        const recovery = recoveryTransport([registration.owner]);
        await prepareDevTrajectoryRecovery(replacement.runtime, recovery);
        const after = await loadTrajectoryById(dead.runtime, active);
        expect(after).toMatchObject({
          status: "terminated",
          metadata: before?.metadata,
          steps: before?.steps,
          metrics: { ...before?.metrics, finalStatus: "terminated" },
        });
        expect((await loadTrajectoryById(dead.runtime, noStep))?.status).toBe(
          "terminated",
        );
        expect(await loadTrajectoryById(dead.runtime, terminal)).toEqual(
          terminalBefore,
        );
        expect(await loadTrajectoryById(live.runtime, liveId)).toEqual(
          liveBefore,
        );
        expect(await loadTrajectoryById(dead.runtime, legacy)).toEqual(
          legacyBefore,
        );
        expect(recovery.acknowledgeRecovery).toHaveBeenCalledOnce();
        const concurrentReplacement = await recoveryLogger(mode, dead.runtime);
        await prepareDevTrajectoryRecovery(
          concurrentReplacement.runtime,
          recoveryTransport([registration.owner]),
        );
        expect(await loadTrajectoryById(dead.runtime, active)).toEqual(after);
      });

      it("gates starts and implicit captures until registration and recovery acknowledgement complete", async () => {
        const fixture = await recoveryLogger(mode);
        const registered = deferred<DevTrajectoryRecoveryRegistration>();
        const contacted = deferred<DevTrajectoryRecoveryOwner>();
        const ack = deferred<void>();
        const ackEntered = deferred<void>();
        const transport: DevTrajectoryRecoveryTransport = {
          registerOwner: vi.fn(async (owner) => {
            contacted.resolve(owner);
            return registered.promise;
          }),
          acknowledgeRecovery: vi.fn(async () => {
            ackEntered.resolve();
            await ack.promise;
          }),
        };
        const preparation = prepareDevTrajectoryRecovery(
          fixture.runtime,
          transport,
        );
        expect(prepareDevTrajectoryRecovery(fixture.runtime, transport)).toBe(
          preparation,
        );
        const owner = await contacted.promise;
        const id = await fixture.logger.startTrajectory(
          fixture.runtime.agentId,
        );
        const implicit = crypto.randomUUID();
        const implicitStart = startTrajectoryStepInDatabase({
          runtime: fixture.runtime,
          stepId: implicit,
          source: "runtime",
        });
        fixture.logger.logLlmCall(
          llmCall(implicit, "cerebras", "gated", "Accepted capture."),
        );
        expect(await loadTrajectoryById(fixture.runtime, id)).toBeNull();
        registered.resolve({
          owner,
          owners: [],
          recoveryBatchId: "batch-gate",
        });
        await ackEntered.promise;
        expect(await loadTrajectoryById(fixture.runtime, id)).toBeNull();
        ack.resolve();
        await preparation;
        await implicitStart;
        await flushTrajectoryWrites(fixture.runtime);
        expect(
          (await loadTrajectoryById(fixture.runtime, id))?.metadata
            .runtimeExecutionOwnerId,
        ).toBe(owner.runtimeExecutionOwnerId);
        const implicitRow = await loadTrajectoryByStepId(
          fixture.runtime,
          implicit,
        );
        expect(implicitRow?.metadata.runtimeExecutionOwnerId).toBe(
          owner.runtimeExecutionOwnerId,
        );
        expect(
          implicitRow?.steps.flatMap((step) => step.llmCalls)[0]?.response,
        ).toBe("Accepted capture.");
        expect(transport.registerOwner).toHaveBeenCalledOnce();
      });
    },
  );

  describe("supervised dev recovery failure boundaries", () => {
    it("allows two replacement runtimes to reconcile the same batch without overwriting terminal data", async () => {
      const dead = await recoveryLogger("installed");
      const initial = recoveryTransport();
      await prepareDevTrajectoryRecovery(dead.runtime, initial);
      const id = await dead.logger.startTrajectory(dead.runtime.agentId);
      await flushTrajectoryWrites(dead.runtime);
      const replacements = await Promise.all([
        recoveryLogger("installed", dead.runtime),
        recoveryLogger("installed", dead.runtime),
      ]);
      const bothEnumerated = deferred<void>();
      let candidates = 0;
      let updates = 0;
      for (const replacement of replacements)
        interceptRecoverySql(
          replacement.runtime,
          async (text, run, transaction) => {
            const result = await run();
            if (
              !transaction &&
              /SELECT id, metadata_json FROM trajectories/.test(text)
            ) {
              candidates++;
              if (candidates === 2) bothEnumerated.resolve();
              await bothEnumerated.promise;
            }
            if (
              transaction &&
              /UPDATE trajectories SET status = 'terminated'/.test(text)
            )
              updates++;
            return result;
          },
        );
      const transports = replacements.map(() =>
        recoveryTransport([initial.owner]),
      );
      await Promise.all(
        replacements.map((replacement, index) =>
          prepareDevTrajectoryRecovery(replacement.runtime, transports[index]),
        ),
      );
      expect(candidates).toBe(2);
      expect(updates).toBe(1);
      expect((await loadTrajectoryById(dead.runtime, id))?.status).toBe(
        "terminated",
      );
      for (const transport of transports)
        expect(transport.acknowledgeRecovery).toHaveBeenCalledOnce();
    });

    it("retains authority when a matching execution has malformed row ownership", async () => {
      const dead = await recoveryLogger("installed");
      const initial = recoveryTransport();
      await prepareDevTrajectoryRecovery(dead.runtime, initial);
      const id = await dead.logger.startTrajectory(dead.runtime.agentId);
      await flushTrajectoryWrites(dead.runtime);
      await executeRawSql(
        dead.runtime,
        `UPDATE trajectories SET metadata_json = metadata_json::jsonb - 'runtimeTrajectoryOwnerId' WHERE id = '${id}'`,
      );
      const before = await loadTrajectoryById(dead.runtime, id);
      const replacement = await recoveryLogger("installed", dead.runtime);
      const transport = recoveryTransport([initial.owner]);
      await expect(
        prepareDevTrajectoryRecovery(replacement.runtime, transport),
      ).rejects.toMatchObject({ code: "DEV_TRAJECTORY_RECOVERY_REJECTED" });
      expect(await loadTrajectoryById(dead.runtime, id)).toEqual(before);
      expect(transport.acknowledgeRecovery).not.toHaveBeenCalled();
    });

    it("rejects an adapter change while registration is in flight", async () => {
      const fixture = await recoveryLogger("installed");
      const offered = deferred<DevTrajectoryRecoveryRegistration>();
      const contacted = deferred<DevTrajectoryRecoveryOwner>();
      const ack = vi.fn(async () => {});
      const preparation = prepareDevTrajectoryRecovery(fixture.runtime, {
        registerOwner: async (owner) => {
          contacted.resolve(owner);
          return offered.promise;
        },
        acknowledgeRecovery: ack,
      });
      const owner = await contacted.promise;
      const original = (fixture.runtime as unknown as { adapter: object })
        .adapter;
      Object.assign(fixture.runtime, { adapter: Object.create(original) });
      offered.resolve({
        owner,
        owners: [],
        recoveryBatchId: "changed-adapter",
      });
      await expect(preparation).rejects.toMatchObject({
        code: "DEV_TRAJECTORY_RECOVERY_REJECTED",
      });
      expect(ack).not.toHaveBeenCalled();
    });

    it("keeps capture fenced when the supervisor does not acknowledge a recovered batch", async () => {
      const fixture = await recoveryLogger("installed");
      const transport = recoveryTransport();
      transport.acknowledgeRecovery.mockRejectedValueOnce(
        new Error("IPC disconnected before recovery ack"),
      );
      await expect(
        prepareDevTrajectoryRecovery(fixture.runtime, transport),
      ).rejects.toThrow("IPC disconnected");
      const id = await fixture.logger.startTrajectory(fixture.runtime.agentId);
      await expect(flushTrajectoryWrites(fixture.runtime)).rejects.toThrow(
        "IPC disconnected",
      );
      expect(await loadTrajectoryById(fixture.runtime, id)).toBeNull();
    });

    it.each([
      "foreign-agent",
      "foreign-installation",
      "foreign-storage",
      "current-execution",
      "wrong-echo",
    ])(
      "rejects %s authority before SQL and fences further starts",
      async (kind) => {
        const dead = await recoveryLogger("installed");
        const initial = recoveryTransport();
        await prepareDevTrajectoryRecovery(dead.runtime, initial);
        const id = await dead.logger.startTrajectory(dead.runtime.agentId);
        await flushTrajectoryWrites(dead.runtime);
        const before = await loadTrajectoryById(dead.runtime, id);
        const replacement = await recoveryLogger("installed", dead.runtime);
        const ack = vi.fn(async () => {});
        const register = vi.fn(async (owner: DevTrajectoryRecoveryOwner) => {
          const prior = structuredClone(initial.owner);
          if (kind === "foreign-agent") prior.agentId = crypto.randomUUID();
          if (kind === "foreign-installation")
            prior.runtimeInstanceId = crypto.randomUUID();
          if (kind === "foreign-storage") prior.storageScope.inode = "0";
          return {
            owner: kind === "wrong-echo" ? initial.owner : owner,
            owners: [kind === "current-execution" ? owner : prior],
            recoveryBatchId: "bad-batch",
          };
        });
        const transport = { registerOwner: register, acknowledgeRecovery: ack };
        await expect(
          prepareDevTrajectoryRecovery(replacement.runtime, transport),
        ).rejects.toMatchObject({ code: "DEV_TRAJECTORY_RECOVERY_REJECTED" });
        const rejectedId = await replacement.logger.startTrajectory(
          replacement.runtime.agentId,
        );
        await expect(
          flushTrajectoryWrites(replacement.runtime),
        ).rejects.toMatchObject({ code: "DEV_TRAJECTORY_RECOVERY_REJECTED" });
        expect(
          await loadTrajectoryById(replacement.runtime, rejectedId),
        ).toBeNull();
        expect(await loadTrajectoryById(dead.runtime, id)).toEqual(before);
        expect(ack).not.toHaveBeenCalled();
        await expect(
          prepareDevTrajectoryRecovery(replacement.runtime, transport),
        ).rejects.toMatchObject({ code: "DEV_TRAJECTORY_RECOVERY_REJECTED" });
        expect(register).toHaveBeenCalledOnce();
      },
    );

    it("rolls back a failed settlement, withholds acknowledgement, and allows a fresh replacement to retry", async () => {
      const dead = await recoveryLogger("installed");
      const initial = recoveryTransport();
      await prepareDevTrajectoryRecovery(dead.runtime, initial);
      const id = await dead.logger.startTrajectory(dead.runtime.agentId);
      await flushTrajectoryWrites(dead.runtime);
      const before = await loadTrajectoryById(dead.runtime, id);
      const replacement = await recoveryLogger("installed", dead.runtime);
      interceptRecoverySql(
        replacement.runtime,
        async (text, run, transaction) => {
          const result = await run();
          if (
            transaction &&
            /UPDATE trajectories SET status = 'terminated'/.test(text)
          )
            throw new Error("injected recovery transaction rollback");
          return result;
        },
      );
      const transport = recoveryTransport([initial.owner]);
      await expect(
        prepareDevTrajectoryRecovery(replacement.runtime, transport),
      ).rejects.toThrow("injected recovery transaction rollback");
      expect(await loadTrajectoryById(dead.runtime, id)).toEqual(before);
      expect(transport.acknowledgeRecovery).not.toHaveBeenCalled();
      const retry = await recoveryLogger("installed", dead.runtime);
      await prepareDevTrajectoryRecovery(retry.runtime, transport);
      expect((await loadTrajectoryById(dead.runtime, id))?.status).toBe(
        "terminated",
      );
      expect(transport.acknowledgeRecovery).toHaveBeenCalledOnce();
    });

    it.each(["row-token", "terminal"])(
      "preserves a concurrent %s change between enumeration and the row lock",
      async (change) => {
        const dead = await recoveryLogger("installed");
        const initial = recoveryTransport();
        await prepareDevTrajectoryRecovery(dead.runtime, initial);
        const id = await dead.logger.startTrajectory(dead.runtime.agentId);
        await flushTrajectoryWrites(dead.runtime);
        const replacement = await recoveryLogger("installed", dead.runtime);
        let changed = false;
        let expected: Awaited<ReturnType<typeof loadTrajectoryById>> = null;
        interceptRecoverySql(
          replacement.runtime,
          async (text, run, transaction) => {
            const result = await run();
            if (
              !transaction &&
              !changed &&
              /SELECT id, metadata_json FROM trajectories/.test(text)
            ) {
              changed = true;
              if (change === "row-token")
                await executeRawSql(
                  dead.runtime,
                  `UPDATE trajectories SET metadata_json = jsonb_set(metadata_json::jsonb, '{runtimeTrajectoryOwnerId}', '"${crypto.randomUUID()}"') WHERE id = '${id}'`,
                );
              else await dead.logger.endTrajectory(id, "completed");
              expected = await loadTrajectoryById(dead.runtime, id);
            }
            return result;
          },
        );
        const transport = recoveryTransport([initial.owner]);
        const preparation = prepareDevTrajectoryRecovery(
          replacement.runtime,
          transport,
        );
        if (change === "row-token") {
          await expect(preparation).rejects.toMatchObject({
            code: "DEV_TRAJECTORY_RECOVERY_REJECTED",
          });
          expect(transport.acknowledgeRecovery).not.toHaveBeenCalled();
        } else await preparation;
        expect(changed).toBe(true);
        expect(expected).not.toBeNull();
        expect(await loadTrajectoryById(dead.runtime, id)).toEqual(expected);
      },
    );

    it("recovers all owned rows across bounded pages", async () => {
      const dead = await recoveryLogger("installed");
      const initial = recoveryTransport();
      await prepareDevTrajectoryRecovery(dead.runtime, initial);
      const ids: string[] = [];
      for (let i = 0; i < 203; i++)
        ids.push(await dead.logger.startTrajectory(dead.runtime.agentId));
      await flushTrajectoryWrites(dead.runtime);
      const replacement = await recoveryLogger("installed", dead.runtime);
      let pages = 0;
      interceptRecoverySql(
        replacement.runtime,
        async (text, run, transaction) => {
          if (
            !transaction &&
            /SELECT id, metadata_json FROM trajectories/.test(text)
          )
            pages++;
          return run();
        },
      );
      await prepareDevTrajectoryRecovery(
        replacement.runtime,
        recoveryTransport([initial.owner]),
      );
      expect(pages).toBe(2);
      const rows = extractRows(
        await executeRawSql(
          dead.runtime,
          `SELECT id, status FROM trajectories WHERE agent_id = '${dead.runtime.agentId}'`,
        ),
      );
      expect(rows).toHaveLength(ids.length);
      expect(rows.every((row) => asRecord(row)?.status === "terminated")).toBe(
        true,
      );
    }, 30_000);

    it.each(["postgres", "memory"])(
      "leaves ordinary %s capture unchanged without registering a dev owner",
      async (kind) => {
        const fixture = await recoveryLogger("public");
        const adapter = (
          fixture.runtime as unknown as { adapter: { db: TestRuntimeDb } }
        ).adapter;
        Object.assign(fixture.runtime, {
          adapter: {
            db: adapter.db,
            ...(kind === "memory" ? { getPgliteDataDir: () => null } : {}),
          },
        });
        const transport = recoveryTransport();
        await expect(
          prepareDevTrajectoryRecovery(fixture.runtime, transport),
        ).resolves.toBe("unsupported-storage");
        const id = await fixture.logger.startTrajectory(
          fixture.runtime.agentId,
          { metadata: { runtimeExecutionOwnerId: crypto.randomUUID() } },
        );
        await flushTrajectoryWrites(fixture.runtime);
        expect(
          (await loadTrajectoryById(fixture.runtime, id))?.metadata
            .runtimeExecutionOwnerId,
        ).toBeUndefined();
        expect(transport.registerOwner).not.toHaveBeenCalled();
      },
    );

    it("fails closed for a known persistent path that cannot be resolved", async () => {
      const fixture = await recoveryLogger("installed");
      const adapter = (
        fixture.runtime as unknown as { adapter: { db: TestRuntimeDb } }
      ).adapter;
      Object.assign(fixture.runtime, {
        adapter: {
          db: adapter.db,
          getPgliteDataDir: () => path.join(pgliteDir, "missing-directory"),
          getConnection: async () => adapter.db,
        },
      });
      const transport = recoveryTransport();
      await expect(
        prepareDevTrajectoryRecovery(fixture.runtime, transport),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(transport.registerOwner).not.toHaveBeenCalled();
      const id = await fixture.logger.startTrajectory(fixture.runtime.agentId);
      await expect(
        flushTrajectoryWrites(fixture.runtime),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await loadTrajectoryById(fixture.runtime, id)).toBeNull();
    });
  });

  describe.each(["public", "installed"] as const)(
    "%s bridge graceful shutdown",
    (mode) => {
      it("settles its own starts without changing other runtimes, terminal results, or legacy ownership", async () => {
        const ownRuntime = sharedDatabaseRuntime(crypto.randomUUID());
        const owner = await shutdownLogger(mode, ownRuntime);
        const sibling = await shutdownLogger(
          mode,
          sharedDatabaseRuntime(ownRuntime.agentId),
        );
        // The host can reuse an installation identity across process generations.
        Object.assign(sibling.runtime, {
          runtimeInstanceId: ownRuntime.runtimeInstanceId,
        });
        const other = await shutdownLogger(
          mode,
          sharedDatabaseRuntime(crypto.randomUUID()),
        );
        const noStep = await owner.logger.startTrajectory(ownRuntime.agentId, {
          metadata: {
            runtimeInstanceId: sibling.runtime.runtimeInstanceId,
            runtimeTrajectoryOwnerId: "forged",
          },
        });
        const active = await owner.logger.startTrajectory(ownRuntime.agentId);
        const child = owner.logger.startStep(active);
        owner.logger.logLlmCall(
          llmCall(
            child,
            "openai",
            "shutdown-owner",
            "Preserve this recorded response.",
          ),
        );
        const completed = await owner.logger.startTrajectory(
          ownRuntime.agentId,
        );
        await flushTrajectoryWrites(ownRuntime);
        await sibling.logger.endTrajectory(completed, "completed");
        const completedBefore = await loadTrajectoryById(ownRuntime, completed);
        const activeBefore = await loadTrajectoryById(ownRuntime, active);
        const siblingId = await sibling.logger.startTrajectory(
          sibling.runtime.agentId,
        );
        const otherId = await other.logger.startTrajectory(
          other.runtime.agentId,
        );
        await flushTrajectoryWrites(sibling.runtime);
        await flushTrajectoryWrites(other.runtime);
        owner.logger.startStep(siblingId);
        await flushTrajectoryWrites(ownRuntime);
        const siblingBefore = await loadTrajectoryById(
          sibling.runtime,
          siblingId,
        );
        // Explicit IDs are also used by legacy/direct instrumentation. Reusing
        // one must not transfer ownership through attacker-controlled metadata.
        await owner.logger.startTrajectory(siblingId, {
          agentId: ownRuntime.agentId,
          metadata: {
            runtimeInstanceId: ownRuntime.runtimeInstanceId,
            runtimeTrajectoryOwnerId: "takeover",
          },
        });
        const legacyId = crypto.randomUUID();
        await saveTrajectory(
          ownRuntime,
          createBaseTrajectory(
            legacyId,
            Date.now(),
            ownRuntime.agentId,
            "legacy",
            {
              runtimeInstanceId: ownRuntime.runtimeInstanceId,
              runtimeTrajectoryOwnerId:
                activeBefore?.metadata.runtimeTrajectoryOwnerId,
            },
          ),
        );
        const unstampedId = crypto.randomUUID();
        await saveTrajectory(
          ownRuntime,
          createBaseTrajectory(unstampedId, Date.now(), ownRuntime.agentId),
        );
        const implicitId = crypto.randomUUID();
        await startTrajectoryStepInDatabase({
          runtime: ownRuntime,
          stepId: implicitId,
          source: "shutdown-direct",
        });
        const annotatedId = crypto.randomUUID();
        await annotateTrajectoryStep({
          runtime: ownRuntime,
          stepId: annotatedId,
          kind: "action",
          script: "recorded annotation",
        });
        await flushTrajectoryWrites(ownRuntime);
        const siblingAfterStart = await loadTrajectoryById(
          sibling.runtime,
          siblingId,
        );
        expect(siblingAfterStart?.metadata).toEqual(siblingBefore?.metadata);

        await Promise.all([owner.logger.stop(), owner.logger.stop()]);
        const stopped = await loadTrajectoryById(ownRuntime, active);
        expect(stopped?.status).toBe("terminated");
        expect(stopped?.metrics.finalStatus).toBe("terminated");
        expect(stopped?.steps).toEqual(activeBefore?.steps);
        expect(stopped?.metadata).toEqual(activeBefore?.metadata);
        expect(stopped?.endTime).toBeGreaterThanOrEqual(
          stopped?.startTime ?? Infinity,
        );
        expect(await loadTrajectoryById(ownRuntime, noStep)).toMatchObject({
          status: "terminated",
          steps: [],
          metadata: { runtimeInstanceId: ownRuntime.runtimeInstanceId },
        });
        expect((await loadTrajectoryById(ownRuntime, implicitId))?.status).toBe(
          "terminated",
        );
        expect(
          (await loadTrajectoryById(ownRuntime, annotatedId))?.status,
        ).toBe("terminated");
        expect(await loadTrajectoryById(ownRuntime, completed)).toEqual(
          completedBefore,
        );
        expect(await loadTrajectoryById(sibling.runtime, siblingId)).toEqual(
          siblingAfterStart,
        );
        expect((await loadTrajectoryById(other.runtime, otherId))?.status).toBe(
          "active",
        );
        expect((await loadTrajectoryById(ownRuntime, legacyId))?.status).toBe(
          "active",
        );
        expect(
          (await loadTrajectoryById(ownRuntime, unstampedId))?.status,
        ).toBe("active");
        await owner.logger.stop();
        expect(await loadTrajectoryById(ownRuntime, active)).toEqual(stopped);
        await sibling.logger.stop();
        await other.logger.stop();
      });

      it("drains an accepted pending start and captures before stopping", async () => {
        const gated = transactionGatedRuntime(crypto.randomUUID());
        const owner = await shutdownLogger(mode, gated.runtime);
        gated.gate.arm();
        const id = await owner.logger.startTrajectory(owner.runtime.agentId);
        const child = owner.logger.startStep(id);
        owner.logger.logLlmCall(
          llmCall(child, "openai", "pending-shutdown", "Accepted before stop."),
        );
        await gated.gate.entered;
        let stopped = false;
        const stopping = owner.logger.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        const stoppedBeforeRelease = stopped;
        const rejected = await owner.logger.startTrajectory(
          owner.runtime.agentId,
        );
        gated.gate.release();
        await stopping;
        expect(stoppedBeforeRelease).toBe(false);
        const saved = await loadTrajectoryById(owner.runtime, id);
        expect(saved?.status).toBe("terminated");
        expect(saved?.steps.flatMap((step) => step.llmCalls)).toEqual([
          expect.objectContaining({ response: "Accepted before stop." }),
        ]);
        expect(await loadTrajectoryById(owner.runtime, rejected)).toBeNull();
      });

      it("rolls back failed shutdown atomically and retains ownership for a coalesced retry", async () => {
        const target = sharedDatabaseRuntime(crypto.randomUUID());
        const owner = await shutdownLogger(mode, target);
        const id = await owner.logger.startTrajectory(target.agentId);
        const child = owner.logger.startStep(id);
        owner.logger.logLlmCall(
          llmCall(
            child,
            "openai",
            "shutdown-rollback",
            "Keep every recorded byte.",
          ),
        );
        await flushTrajectoryWrites(target);
        const before = await loadTrajectoryById(target, id);
        const baseDb = (target as unknown as { adapter: { db: TestRuntimeDb } })
          .adapter.db;
        let fail = true;
        let shutdownUpdates = 0;
        Object.assign(target, {
          adapter: {
            db: {
              execute: baseDb.execute.bind(baseDb),
              transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) =>
                baseDb.transaction((tx) =>
                  callback({
                    execute: async (query: unknown) => {
                      const result = await tx.execute(query);
                      if (
                        /UPDATE trajectories SET status = 'terminated'/.test(
                          sqlText(query),
                        )
                      ) {
                        shutdownUpdates += 1;
                        if (fail)
                          throw new Error(
                            "injected shutdown failure after update",
                          );
                      }
                      return result;
                    },
                  }),
                ),
            },
          },
        });
        const results = await Promise.allSettled([
          owner.logger.stop(),
          owner.logger.stop(),
        ]);
        expect(results.map((result) => result.status)).toEqual([
          "rejected",
          "rejected",
        ]);
        expect(shutdownUpdates).toBe(1);
        expect(await loadTrajectoryById(target, id)).toEqual(before);
        fail = false;
        await Promise.all([owner.logger.stop(), owner.logger.stop()]);
        expect(shutdownUpdates).toBe(2);
        const after = await loadTrajectoryById(target, id);
        expect(after?.status).toBe("terminated");
        expect(after?.metrics).toEqual({
          ...before?.metrics,
          finalStatus: "terminated",
        });
        expect(after?.steps).toEqual(before?.steps);
        expect(after?.metadata).toEqual(before?.metadata);
        await owner.logger.stop();
        expect(shutdownUpdates).toBe(2);
      });

      it("does not claim a same-ID start that another runtime inserts first", async () => {
        const gated = transactionGatedRuntime(crypto.randomUUID());
        const owner = await shutdownLogger(mode, gated.runtime);
        const siblingRuntime = sharedDatabaseRuntime(owner.runtime.agentId);
        Object.assign(siblingRuntime, {
          runtimeInstanceId: owner.runtime.runtimeInstanceId,
        });
        const sibling = await shutdownLogger(mode, siblingRuntime);
        const id = crypto.randomUUID();
        gated.gate.arm();
        await owner.logger.startTrajectory(id, {
          agentId: owner.runtime.agentId,
        });
        await gated.gate.entered;
        await sibling.logger.startTrajectory(id, {
          agentId: sibling.runtime.agentId,
        });
        await flushTrajectoryWrites(sibling.runtime);
        const before = await loadTrajectoryById(sibling.runtime, id);
        gated.gate.release();
        await expect(
          flushTrajectoryWrites(owner.runtime),
        ).rejects.toMatchObject({ code: "TRAJECTORY_START_CONFLICT" });
        await expect(owner.logger.stop()).rejects.toThrow(
          "Trajectory shutdown persistence failed",
        );
        await owner.logger.stop();
        expect(await loadTrajectoryById(sibling.runtime, id)).toEqual(before);
        await sibling.logger.stop();
        expect((await loadTrajectoryById(sibling.runtime, id))?.status).toBe(
          "terminated",
        );
      });

      it("releases deleted ownership and retains a later same-ID creator", async () => {
        const target = sharedDatabaseRuntime(crypto.randomUUID());
        const owner = await shutdownLogger(mode, target);
        const deleted = await owner.logger.startTrajectory(target.agentId);
        const reused = await owner.logger.startTrajectory(target.agentId);
        await flushTrajectoryWrites(target);
        const previousToken = (await loadTrajectoryById(target, reused))
          ?.metadata.runtimeTrajectoryOwnerId;
        expect(await owner.logger.deleteTrajectories([deleted, reused])).toBe(
          2,
        );
        await owner.logger.startTrajectory(reused, { agentId: target.agentId });
        await flushTrajectoryWrites(target);
        expect(
          (await loadTrajectoryById(target, reused))?.metadata
            .runtimeTrajectoryOwnerId,
        ).not.toBe(previousToken);
        const baseDb = (target as unknown as { adapter: { db: TestRuntimeDb } })
          .adapter.db;
        const lockedIds: string[] = [];
        Object.assign(target, {
          adapter: {
            db: {
              execute: baseDb.execute.bind(baseDb),
              transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) =>
                baseDb.transaction((tx) =>
                  callback({
                    execute: async (query: unknown) => {
                      const statement = sqlText(query);
                      if (
                        /FROM trajectories.*WHERE id =[\s\S]*FOR UPDATE/.test(
                          statement,
                        )
                      )
                        lockedIds.push(statement);
                      return tx.execute(query);
                    },
                  }),
                ),
            },
          },
        });
        await owner.logger.stop();
        expect(lockedIds).toHaveLength(1);
        expect(lockedIds[0]).toContain(reused);
        expect(await loadTrajectoryById(target, deleted)).toBeNull();
        expect((await loadTrajectoryById(target, reused))?.status).toBe(
          "terminated",
        );
      });

      it.each(["delete", "clear"] as const)(
        "rolls back malformed %s results without losing ownership",
        async (operation) => {
          const target = sharedDatabaseRuntime(crypto.randomUUID());
          const owner = await shutdownLogger(mode, target);
          const id = await owner.logger.startTrajectory(target.agentId);
          const step = owner.logger.startStep(id);
          owner.logger.logLlmCall(
            llmCall(step, "openai", "delete-result", "Must survive rollback."),
          );
          await flushTrajectoryWrites(target);
          const before = await loadTrajectoryById(target, id);
          const baseDb = (
            target as unknown as { adapter: { db: TestRuntimeDb } }
          ).adapter.db;
          let corruptResult = true;
          let ownershipReads = 0;
          Object.assign(target, {
            adapter: {
              db: {
                execute: baseDb.execute.bind(baseDb),
                transaction: <T>(
                  callback: (tx: TestSqlExecutor) => Promise<T>,
                ) =>
                  baseDb.transaction((tx) =>
                    callback({
                      execute: async (query: unknown) => {
                        const statement = sqlText(query);
                        const result = await tx.execute(query);
                        if (
                          corruptResult &&
                          /DELETE FROM trajectories/.test(statement)
                        )
                          return [{}];
                        if (
                          /FROM trajectories.*WHERE id =[\s\S]*FOR UPDATE/.test(
                            statement,
                          )
                        )
                          ownershipReads += 1;
                        return result;
                      },
                    }),
                  ),
              },
            },
          });
          const remove = () =>
            operation === "delete"
              ? owner.logger.deleteTrajectories([id])
              : clearPersistedTrajectoryRows(target);
          await expect(remove()).rejects.toMatchObject({
            code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
          });
          expect(await loadTrajectoryById(target, id)).toEqual(before);
          corruptResult = false;
          await owner.logger.stop();
          expect((await loadTrajectoryById(target, id))?.status).toBe(
            "terminated",
          );
          expect(ownershipReads).toBe(1);
          expect(await remove()).toBe(1);
          expect(await loadTrajectoryById(target, id)).toBeNull();
        },
      );
    },
  );

  it.each(["public", "installed"] as const)(
    "%s child start preserves prior model bytes without resending unrelated captures",
    async (mode) => {
      const target = sharedDatabaseRuntime(crypto.randomUUID());
      const baseDb = (target as unknown as { adapter: { db: TestRuntimeDb } })
        .adapter.db;
      const statements: string[] = [];
      let recording = false;
      (target as unknown as { adapter: { db: TestRuntimeDb } }).adapter = {
        db: {
          execute: baseDb.execute.bind(baseDb),
          transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) =>
            baseDb.transaction((tx) =>
              callback({
                execute: (query) => {
                  if (recording) statements.push(sqlText(query));
                  return tx.execute(query);
                },
              }),
            ),
        },
      };
      const { logger } = await databaseLogger(mode, target.agentId, target);
      try {
        const id = await logger.startTrajectory(target.agentId);
        const root = logger.startStep(id);
        const prior = logger.startStep(id, { parentStepId: root });
        const text = "  Complete unrelated capture: α 'quoted'\n".repeat(4096);
        logger.logLlmCall(llmCall(prior, "test", "prior-complete-call", text));
        await flushTrajectoryWrites(target, id);
        const before = await loadTrajectoryById(target, id);
        recording = true;
        const child = logger.startStep(id, { parentStepId: root });
        await flushTrajectoryWrites(target, id);
        recording = false;
        const after = await loadTrajectoryById(target, id);
        expect(after?.steps.find((step) => step.stepId === prior)).toEqual(
          before?.steps.find((step) => step.stepId === prior),
        );
        expect(
          after?.steps.find((step) => step.stepId === prior)?.llmCalls[0]
            ?.response,
        ).toBe(text);
        expect(
          after?.steps.find((step) => step.stepId === root)?.childSteps,
        ).toEqual([prior, child]);
        expect(
          after?.steps.find((step) => step.stepId === child)?.parentStepId,
        ).toBe(root);
        expect(after?.metrics.llmCallCount).toBe(1);
        const bytes = statements.reduce(
          (total, query) => total + Buffer.byteLength(query),
          0,
        );
        expect(
          statements.some((query) =>
            query.includes("Complete unrelated capture:"),
          ),
          `Child write resent prior model payload; ${bytes} SQL bytes across ${statements.length} statements`,
        ).toBe(false);
        await logger.endTrajectory(id, "completed");
      } finally {
        recording = false;
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s child-start conflict retries from current persisted parent links",
    async (mode) => {
      const gated = transactionGatedRuntime(crypto.randomUUID());
      const owner = await databaseLogger(
        mode,
        gated.runtime.agentId,
        gated.runtime,
      );
      const concurrent = await databaseLogger(mode, gated.runtime.agentId);
      try {
        const id = await owner.logger.startTrajectory(gated.runtime.agentId);
        const root = owner.logger.startStep(id);
        await flushTrajectoryWrites(gated.runtime, id);
        gated.transactions.count = 0;
        gated.gate.arm();
        const child = owner.logger.startStep(id, { parentStepId: root });
        await gated.gate.entered;
        const otherChild = concurrent.logger.startStep(id, {
          parentStepId: root,
        });
        await flushTrajectoryWrites(concurrent.runtime, id);
        gated.gate.release();
        await flushTrajectoryWrites(gated.runtime, id);
        const after = await loadTrajectoryById(gated.runtime, id);
        expect(after?.steps.map((step) => step.stepId)).toEqual([
          root,
          otherChild,
          child,
        ]);
        expect(
          after?.steps.find((step) => step.stepId === root)?.childSteps,
        ).toEqual([otherChild, child]);
        expect(gated.transactions.count).toBe(2);
        await owner.logger.endTrajectory(id, "completed");
      } finally {
        gated.gate.release();
        await owner.logger.stop();
        await concurrent.logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s child-start contention fails explicitly without partial links",
    async (mode) => {
      const target = sharedDatabaseRuntime(crypto.randomUUID());
      const concurrent = sharedDatabaseRuntime(target.agentId);
      const baseDb = (target as unknown as { adapter: { db: TestRuntimeDb } })
        .adapter.db;
      let conflictId: string | undefined;
      let attempts = 0;
      (target as unknown as { adapter: { db: TestRuntimeDb } }).adapter = {
        db: {
          execute: baseDb.execute.bind(baseDb),
          transaction: async <T>(
            callback: (tx: TestSqlExecutor) => Promise<T>,
          ) => {
            if (conflictId) {
              attempts += 1;
              await executeRawSql(
                concurrent,
                `UPDATE trajectories SET updated_at = CAST(updated_at AS TIMESTAMPTZ) + INTERVAL '1 millisecond' WHERE id = '${conflictId}'`,
              );
            }
            return baseDb.transaction(callback);
          },
        },
      };
      const { logger } = await databaseLogger(mode, target.agentId, target);
      let id: string | undefined;
      try {
        id = await logger.startTrajectory(target.agentId);
        const root = logger.startStep(id);
        await flushTrajectoryWrites(target, id);
        const before = await loadTrajectoryById(target, id);
        conflictId = id;
        logger.startStep(id, { parentStepId: root });
        await expect(flushTrajectoryWrites(target, id)).rejects.toMatchObject({
          code: "TRAJECTORY_WRITE_CONFLICT",
        });
        expect(attempts).toBe(3);
        expect((await loadTrajectoryById(target, id))?.steps).toEqual(
          before?.steps,
        );
        expect(target.reportError).toHaveBeenCalledWith(
          "TrajectoryStorage.write",
          expect.objectContaining({ code: "TRAJECTORY_WRITE_CONFLICT" }),
          expect.objectContaining({ diagnosticOnly: true }),
        );
      } finally {
        conflictId = undefined;
        if (id) await logger.endTrajectory(id, "completed");
        await logger.stop();
      }
    },
  );

  it.each(
    (["public", "installed"] as const).flatMap((mode) =>
      (["terminal", "deleted", "other-agent"] as const).map((change) => ({
        mode,
        change,
      })),
    ),
  )(
    "$mode child start rejects a $change parent changed during persistence",
    async ({ mode, change }) => {
      const gated = transactionGatedRuntime(crypto.randomUUID());
      const { logger } = await databaseLogger(
        mode,
        gated.runtime.agentId,
        gated.runtime,
      );
      let before: Awaited<ReturnType<typeof loadTrajectoryById>> = null;
      let id: string | undefined;
      try {
        id = await logger.startTrajectory(gated.runtime.agentId);
        const root = logger.startStep(id);
        await flushTrajectoryWrites(gated.runtime, id);
        before = await loadTrajectoryById(gated.runtime, id);
        gated.gate.arm();
        const child = logger.startStep(id, { parentStepId: root });
        await gated.gate.entered;
        if (change === "deleted") {
          await executeRawSql(
            gated.runtime,
            `DELETE FROM trajectories WHERE id = '${id}'`,
          );
        } else if (change === "terminal") {
          if (!before) throw new Error("Missing parent fixture");
          await saveTrajectory(
            sharedDatabaseRuntime(gated.runtime.agentId),
            { ...before, status: "completed", endTime: Date.now() },
            { changedStepIds: [], requireActiveExisting: true },
          );
        } else {
          const foreignAgentId = crypto.randomUUID();
          await executeRawSql(
            gated.runtime,
            `UPDATE trajectories SET agent_id = '${foreignAgentId}' WHERE id = '${id}'`,
          );
        }
        gated.gate.release();
        await expect(
          flushTrajectoryWrites(gated.runtime, id),
        ).rejects.toMatchObject({
          code:
            change === "deleted"
              ? "TRAJECTORY_PARENT_NOT_FOUND"
              : change === "terminal"
                ? "TRAJECTORY_OWNER_CLOSED"
                : "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
        });
        const after = await loadTrajectoryById(gated.runtime, id);
        if (change === "deleted" || change === "other-agent") {
          expect(after).toBeNull();
        } else {
          expect(after?.status).toBe("completed");
          expect(after?.steps).toEqual(before?.steps);
        }
        expect(
          extractRows(
            await executeRawSql(
              gated.runtime,
              `SELECT id FROM trajectory_steps WHERE id = '${child}'`,
            ),
          ),
        ).toEqual([]);
      } finally {
        gated.gate.release();
        // Restore this isolated fixture after asserting the failed write; then
        // drain a successful owner settlement before shutting down the logger.
        if (before && id) {
          if (change === "other-agent") {
            await executeRawSql(
              gated.runtime,
              `UPDATE trajectories SET agent_id = '${gated.runtime.agentId}' WHERE id = '${id}'`,
            );
          }
          await saveTrajectory(gated.runtime, before);
          await logger.endTrajectory(id, "completed");
        }
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger batches adjacent child starts with exact serial persistence equivalence",
    async (mode) => {
      const counted = transactionGatedRuntime(crypto.randomUUID());
      const { logger } = await databaseLogger(
        mode,
        counted.runtime.agentId,
        counted.runtime,
      );
      const snapshots = [];
      try {
        for (const serial of [true, false]) {
          const trajectoryId = await logger.startTrajectory(
            counted.runtime.agentId,
            { source: "child-start-batch-equivalence" },
          );
          const timestamp = 1_788_650_000_000;
          const rootId = logger.startStep(trajectoryId, { timestamp });
          await flushTrajectoryWrites(counted.runtime, trajectoryId);
          counted.transactions.count = 0;
          const childIds: string[] = [];
          for (let index = 0; index < 28; index += 1) {
            childIds.push(
              logger.startStep(trajectoryId, {
                // Repeated and non-monotonic event times remain caller-owned.
                timestamp: timestamp + (index % 7),
                parentStepId: index < 14 ? rootId : childIds[0],
                kind: index % 2 === 0 ? "llm" : "evaluator",
                ...(index % 2 === 1
                  ? { evaluatorName: `evaluator-${index}` }
                  : {}),
              }),
            );
            if (serial) {
              await flushTrajectoryWrites(counted.runtime, trajectoryId);
            }
          }
          await flushTrajectoryWrites(counted.runtime, trajectoryId);
          expect(counted.transactions.count).toBe(serial ? 28 : 1);
          const stored = await loadTrajectoryById(
            counted.runtime,
            trajectoryId,
          );
          expect(stored?.steps.map((step) => step.stepId)).toEqual([
            rootId,
            ...childIds,
          ]);
          const ids = new Map(
            [rootId, ...childIds].map((id, index) => [id, `step-${index}`]),
          );
          snapshots.push(
            stored?.steps.map((step) => ({
              ...step,
              stepId: ids.get(step.stepId),
              ...(step.parentStepId
                ? { parentStepId: ids.get(step.parentStepId) }
                : {}),
              ...(step.childSteps
                ? { childSteps: step.childSteps.map((id) => ids.get(id)) }
                : {}),
            })),
          );
          await logger.endTrajectory(trajectoryId, "completed");
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
      } finally {
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger preserves capture barriers between child-start batches",
    async (mode) => {
      const counted = transactionGatedRuntime(crypto.randomUUID());
      const { logger } = await databaseLogger(
        mode,
        counted.runtime.agentId,
        counted.runtime,
      );
      try {
        const trajectoryId = await logger.startTrajectory(
          counted.runtime.agentId,
        );
        const rootId = logger.startStep(trajectoryId);
        await flushTrajectoryWrites(counted.runtime, trajectoryId);
        counted.transactions.count = 0;
        const first = logger.startStep(trajectoryId, { parentStepId: rootId });
        const second = logger.startStep(trajectoryId, { parentStepId: rootId });
        const reply = "  Keep the full result, including whitespace.\n".repeat(
          200,
        );
        logger.logLlmCall(llmCall(first, "test", "child-start-barrier", reply));
        const third = logger.startStep(trajectoryId, { parentStepId: second });
        const fourth = logger.startStep(trajectoryId, { parentStepId: third });
        logger.logProviderAccess({
          stepId: fourth,
          providerName: "after-child-batch",
          purpose: "context",
          data: { text: reply },
        });
        await flushTrajectoryWrites(counted.runtime, trajectoryId);
        expect(counted.transactions.count).toBe(4);
        const stored = await loadTrajectoryById(counted.runtime, trajectoryId);
        expect(stored?.steps.map((step) => step.stepId)).toEqual([
          rootId,
          first,
          second,
          third,
          fourth,
        ]);
        expect(
          stored?.steps.find((step) => step.stepId === first)?.llmCalls[0]
            ?.response,
        ).toBe(reply);
        expect(
          stored?.steps.find((step) => step.stepId === fourth)
            ?.providerAccesses[0]?.data,
        ).toEqual({ text: reply });
        expect(
          stored?.steps.find((step) => step.stepId === second)?.childSteps,
        ).toEqual([third]);
        expect(
          stored?.steps.find((step) => step.stepId === third)?.childSteps,
        ).toEqual([fourth]);
        await logger.endTrajectory(trajectoryId, "completed");
      } finally {
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger separates child starts arriving after a batch enters persistence",
    async (mode) => {
      const gated = transactionGatedRuntime(crypto.randomUUID());
      const { logger } = await databaseLogger(
        mode,
        gated.runtime.agentId,
        gated.runtime,
      );
      try {
        const trajectoryId = await logger.startTrajectory(
          gated.runtime.agentId,
        );
        const rootId = logger.startStep(trajectoryId);
        await flushTrajectoryWrites(gated.runtime, trajectoryId);
        gated.transactions.count = 0;
        gated.gate.arm();
        const first = logger.startStep(trajectoryId, { parentStepId: rootId });
        const second = logger.startStep(trajectoryId, { parentStepId: rootId });
        await gated.gate.entered;
        const third = logger.startStep(trajectoryId, { parentStepId: second });
        const fourth = logger.startStep(trajectoryId, { parentStepId: third });
        gated.gate.release();
        await flushTrajectoryWrites(gated.runtime, trajectoryId);
        expect(gated.transactions.count).toBe(2);
        const stored = await loadTrajectoryById(gated.runtime, trajectoryId);
        expect(stored?.steps.map((step) => step.stepId)).toEqual([
          rootId,
          first,
          second,
          third,
          fourth,
        ]);
        expect(
          stored?.steps.find((step) => step.stepId === rootId)?.childSteps,
        ).toEqual([first, second]);
        expect(
          stored?.steps.find((step) => step.stepId === second)?.childSteps,
        ).toEqual([third]);
        await logger.endTrajectory(trajectoryId, "completed");
      } finally {
        gated.gate.release();
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger does not merge child-start batches from different logger owners",
    async (mode) => {
      const counted = transactionGatedRuntime(crypto.randomUUID());
      const first = await databaseLogger(
        mode,
        counted.runtime.agentId,
        counted.runtime,
      );
      const second = await databaseLogger(
        mode,
        counted.runtime.agentId,
        counted.runtime,
      );
      try {
        const trajectoryId = await first.logger.startTrajectory(
          counted.runtime.agentId,
        );
        const rootId = first.logger.startStep(trajectoryId);
        await flushTrajectoryWrites(counted.runtime, trajectoryId);
        counted.transactions.count = 0;
        const ids = [
          first.logger.startStep(trajectoryId, { parentStepId: rootId }),
          first.logger.startStep(trajectoryId, { parentStepId: rootId }),
          second.logger.startStep(trajectoryId, { parentStepId: rootId }),
          second.logger.startStep(trajectoryId, { parentStepId: rootId }),
        ];
        await flushTrajectoryWrites(counted.runtime, trajectoryId);
        expect(counted.transactions.count).toBe(2);
        const stored = await loadTrajectoryById(counted.runtime, trajectoryId);
        expect(stored?.steps.map((step) => step.stepId)).toEqual([
          rootId,
          ...ids,
        ]);
        expect(
          stored?.steps.find((step) => step.stepId === rootId)?.childSteps,
        ).toEqual(ids);
        await first.logger.endTrajectory(trajectoryId, "completed");
      } finally {
        await second.logger.stop();
        await first.logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger exposes child-start batch rollback without partial parent links",
    async (mode) => {
      const batchRuntime = sharedDatabaseRuntime(crypto.randomUUID());
      const baseDb = (
        batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }
      ).adapter.db;
      let failNext = false;
      const failure = new Error("child-start transaction failure");
      (batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }).adapter =
        {
          db: {
            execute: baseDb.execute.bind(baseDb),
            transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) =>
              baseDb.transaction(async (tx) => {
                const result = await callback(tx);
                if (failNext) {
                  failNext = false;
                  throw failure;
                }
                return result;
              }),
          },
        };
      const { logger } = await databaseLogger(
        mode,
        batchRuntime.agentId,
        batchRuntime,
      );
      try {
        const trajectoryId = await logger.startTrajectory(batchRuntime.agentId);
        const rootId = logger.startStep(trajectoryId);
        await flushTrajectoryWrites(batchRuntime, trajectoryId);
        const before = await loadTrajectoryById(batchRuntime, trajectoryId);
        failNext = true;
        const first = logger.startStep(trajectoryId, { parentStepId: rootId });
        logger.startStep(trajectoryId, { parentStepId: first });
        await expect(
          flushTrajectoryWrites(batchRuntime, trajectoryId),
        ).rejects.toMatchObject({
          code: "TRAJECTORY_SAVE_FAILED",
          cause: failure,
        });
        expect(
          (await loadTrajectoryById(batchRuntime, trajectoryId))?.steps,
        ).toEqual(before?.steps);
        expect(batchRuntime.reportError).toHaveBeenCalledWith(
          "TrajectoryStorage.write",
          expect.objectContaining({
            code: "TRAJECTORY_SAVE_FAILED",
            cause: failure,
          }),
          expect.objectContaining({ diagnosticOnly: true }),
        );
        // A reported failed batch must not chain-block later independent work.
        const later = logger.startStep(trajectoryId, { parentStepId: rootId });
        await flushTrajectoryWrites(batchRuntime, trajectoryId);
        const after = await loadTrajectoryById(batchRuntime, trajectoryId);
        expect(after?.steps.map((step) => step.stepId)).toEqual([
          rootId,
          later,
        ]);
        expect(
          after?.steps.find((step) => step.stepId === rootId)?.childSteps,
        ).toEqual([later]);
        await logger.endTrajectory(trajectoryId, "completed");
      } finally {
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger keeps in-flight batches separate and retries them against concurrent writes",
    async (mode) => {
      const agentId = crypto.randomUUID();
      const gated = transactionGatedRuntime(agentId);
      const first = await databaseLogger(mode, agentId, gated.runtime);
      const second = await databaseLogger(mode, agentId);
      const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
      try {
        const trajectoryId = await first.logger.startTrajectory(agentId, {
          source: "batch-race",
        });
        const stepId = first.logger.startStep(trajectoryId);
        await flushTrajectoryWrites(first.runtime, trajectoryId);
        const capture = (providerId: string) => ({
          stepId,
          providerId,
          providerName: "batch-race",
          purpose: "context",
          data: { text: providerId },
        });
        gated.gate.arm();
        first.logger.logProviderAccess(capture(ids[0]));
        first.logger.logProviderAccess(capture(ids[1]));
        await gated.gate.entered;
        // These arrivals must not mutate a batch already inside persistence.
        first.logger.logProviderAccess(capture(ids[2]));
        first.logger.logProviderAccess(capture(ids[3]));
        second.logger.logProviderAccess(capture(ids[4]));
        await flushTrajectoryWrites(second.runtime);
        gated.gate.release();
        await flushTrajectoryWrites(first.runtime);
        const detail = await first.logger.getTrajectoryDetail(trajectoryId);
        expect(
          detail?.steps
            ?.flatMap((step) => step.providerAccesses ?? [])
            .map((access) => access.providerId),
        ).toEqual([ids[4], ...ids.slice(0, 4)]);
        await first.logger.endTrajectory(trajectoryId, "completed");
      } finally {
        gated.gate.release();
        await second.logger.stop();
        await first.logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger exposes batch rollback and accepts a complete explicit retry",
    async (mode) => {
      const batchRuntime = sharedDatabaseRuntime(crypto.randomUUID());
      const baseDb = (
        batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }
      ).adapter.db;
      let failNext = false;
      const failure = new Error("batch transaction failure");
      (batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }).adapter =
        {
          db: {
            execute: baseDb.execute.bind(baseDb),
            transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) =>
              baseDb.transaction(async (tx) => {
                const result = await callback(tx);
                if (failNext) {
                  failNext = false;
                  throw failure;
                }
                return result;
              }),
          },
        };
      const { logger } = await databaseLogger(
        mode,
        batchRuntime.agentId,
        batchRuntime,
      );
      try {
        const trajectoryId = await logger.startTrajectory(
          batchRuntime.agentId,
          { source: "batch-rollback" },
        );
        const stepId = logger.startStep(trajectoryId);
        await flushTrajectoryWrites(batchRuntime, trajectoryId);
        const captures = Array.from({ length: 3 }, () => ({
          stepId,
          providerId: crypto.randomUUID(),
          providerName: "batch-rollback",
          purpose: "context",
          data: { text: "Keep the entire batch." },
        }));
        failNext = true;
        for (const capture of captures) logger.logProviderAccess(capture);
        await expect(
          flushTrajectoryWrites(batchRuntime, trajectoryId),
        ).rejects.toMatchObject({
          code: "TRAJECTORY_SAVE_FAILED",
          cause: failure,
        });
        const rolledBack = await loadTrajectoryById(batchRuntime, trajectoryId);
        expect(
          rolledBack?.steps.flatMap((step) => step.providerAccesses),
        ).toHaveLength(0);
        expect(batchRuntime.reportError).toHaveBeenCalledWith(
          "TrajectoryStorage.write",
          expect.objectContaining({
            code: "TRAJECTORY_SAVE_FAILED",
            cause: failure,
          }),
          expect.objectContaining({ diagnosticOnly: true }),
        );
        for (const capture of captures) logger.logProviderAccess(capture);
        await flushTrajectoryWrites(batchRuntime, trajectoryId);
        const retried = await loadTrajectoryById(batchRuntime, trajectoryId);
        expect(
          retried?.steps
            .flatMap((step) => step.providerAccesses)
            .map((access) => access.providerId),
        ).toEqual(captures.map((capture) => capture.providerId));
        await logger.endTrajectory(trajectoryId, "completed");
      } finally {
        await logger.stop();
      }
    },
  );

  it.each(["public", "installed"] as const)(
    "%s logger batches adjacent providers without crossing another capture",
    async (mode) => {
      const batchRuntime = sharedDatabaseRuntime(crypto.randomUUID());
      const baseDb = (
        batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }
      ).adapter.db;
      const transaction = vi.fn();
      (batchRuntime as unknown as { adapter: { db: TestRuntimeDb } }).adapter =
        {
          db: {
            execute: baseDb.execute.bind(baseDb),
            transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) => {
              transaction();
              return baseDb.transaction(callback);
            },
          },
        };
      const { logger } = await databaseLogger(
        mode,
        batchRuntime.agentId,
        batchRuntime,
      );
      const trajectoryId = await logger.startTrajectory(batchRuntime.agentId, {
        source: "test",
      });
      const stepId = logger.startStep(trajectoryId);
      await flushTrajectoryWrites(batchRuntime, trajectoryId);
      transaction.mockClear();

      const timestamp = Date.now();
      const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
      const text = "  Repeated provider evidence must remain exact.\n".repeat(
        200,
      );
      for (const providerId of ids) {
        logger.logProviderAccess({
          stepId,
          providerId,
          timestamp,
          providerName: "same-provider",
          purpose: "context",
          data: { text },
        });
      }
      await flushTrajectoryWrites(batchRuntime, trajectoryId);
      expect(transaction).toHaveBeenCalledTimes(1);
      const detail = await logger.getTrajectoryDetail(trajectoryId);
      const accesses = detail?.steps?.flatMap(
        (step) => step.providerAccesses ?? [],
      );
      expect(accesses?.map((access) => access.providerId)).toEqual(ids);
      expect(
        accesses?.every(
          (access) =>
            access.timestamp === timestamp && access.data?.text === text,
        ),
      ).toBe(true);
      expect(
        (await loadTrajectoryById(batchRuntime, trajectoryId))?.steps.reduce(
          (sum, step) => sum + step.providerAccesses.length,
          0,
        ),
      ).toBe(40);

      transaction.mockClear();
      const firstId = crypto.randomUUID();
      const lastId = crypto.randomUUID();
      logger.logProviderAccess({
        stepId,
        providerId: firstId,
        providerName: "before-llm",
        purpose: "context",
        data: {},
      });
      logger.logLlmCall(
        llmCall(stepId, "test", "barrier", "Preserve this model result."),
      );
      logger.logProviderAccess({
        stepId,
        providerId: lastId,
        providerName: "after-llm",
        purpose: "context",
        data: {},
      });
      await flushTrajectoryWrites(batchRuntime, trajectoryId);
      expect(transaction).toHaveBeenCalledTimes(3);
      const after = await logger.getTrajectoryDetail(trajectoryId);
      expect(
        after?.steps
          ?.flatMap((step) => step.providerAccesses ?? [])
          .map((access) => access.providerId),
      ).toEqual([...ids, firstId, lastId]);
      expect(after?.steps?.flatMap((step) => step.llmCalls ?? [])).toHaveLength(
        1,
      );

      transaction.mockClear();
      for (const providerId of ids) {
        logger.logProviderAccess({
          stepId,
          providerId,
          timestamp,
          providerName: "same-provider",
          purpose: "context",
          data: { text },
        });
      }
      await flushTrajectoryWrites(batchRuntime, trajectoryId);
      expect(transaction).not.toHaveBeenCalled();
      await logger.endTrajectory(trajectoryId, "completed");
      await logger.stop();
    },
  );

  it("retains complete provider context through SQL, viewer reads and native export", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "provider-budget-test",
    });
    const stepId = logger.startStep(trajectoryId);
    const data = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `chunk-${index}`,
        "x".repeat(70_000),
      ]),
    );

    logger.logProviderAccess({
      stepId,
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
      query: { message: "Find my workout correction" },
      startedAt: 1000,
      endedAt: 1004,
      durationMs: 4,
      data,
    });
    logger.logLlmCall({
      ...llmCall(stepId, "test", "provider-roundtrip", "Complete answer"),
      messages: [{ role: "user", content: "  Full model input\n" }],
      tools: [{ name: "REPLY", description: "Complete tool definition" }],
    });
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);

    const row = asRecord(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT payload FROM trajectory_steps WHERE id = '${stepId.replaceAll("'", "''")}'`,
        ),
      )[0],
    );
    const payload = parseMetadata(row?.payload);
    const persistedAccess = Array.isArray(payload.providerAccesses)
      ? asRecord(payload.providerAccesses[0])
      : null;
    expect(persistedAccess).toMatchObject({
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
    });
    expect(persistedAccess?.providerId).toBeTypeOf("string");
    expect(persistedAccess?.timestamp).toBeTypeOf("number");
    expect(persistedAccess?.data).toBeTypeOf("object");

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    const readback = detail?.steps?.find((step) => step.stepId === stepId)
      ?.providerAccesses?.[0];
    expect(readback).toMatchObject({
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
    });
    expect(readback?.providerId).toBeTypeOf("string");
    expect(readback?.timestamp).toBeTypeOf("number");
    expect(readback?.data).toBeTypeOf("object");

    const route = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(route.status).toBe(200);
    const accesses = asRecord(route.body)?.providerAccesses;
    expect(accesses).toEqual([
      expect.objectContaining({
        ...readback,
        stepId,
        trajectoryId,
        query: { message: "Find my workout correction" },
        startedAt: 1000,
        endedAt: 1004,
        durationMs: 4,
        data,
      }),
    ]);
    const summary = await readRoute(
      `/api/trajectories/${trajectoryId}?includePayloads=0`,
    );
    const summaryAccesses = asRecord(summary.body)?.providerAccesses;
    expect(summaryAccesses).toEqual([
      expect.objectContaining({ stepId, trajectoryId, durationMs: 4 }),
    ]);
    expect(JSON.stringify(summaryAccesses)).not.toContain("chunk-0");
    expect(JSON.stringify(summaryAccesses)).not.toContain(
      "Find my workout correction",
    );
    const exported = await logger.exportTrajectories({
      format: "jsonl",
      trajectoryIds: [trajectoryId],
    });
    const native = JSON.parse(exported.data.trim());
    expect(native.request.system).toBe("You are a test agent.");
    expect(native.request.messages).toEqual([
      { role: "user", content: "  Full model input\n" },
    ]);
    expect(asRecord(route.body)?.llmCalls).toEqual([
      expect.objectContaining({
        messages: [{ role: "user", content: "  Full model input\n" }],
        tools: [{ name: "REPLY", description: "Complete tool definition" }],
      }),
    ]);

    await logger.endTrajectory(trajectoryId, "completed");
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);
  });

  it("persists provider/LLM appends with valid active and completed metrics", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
      metadata: { roomId: "room-traj-test" },
    });
    expect(typeof trajectoryId).toBe("string");
    expect(trajectoryId.length).toBeGreaterThan(0);

    const stepId = logger.startStep(trajectoryId);
    const reportError = vi.spyOn(runtime, "reportError");

    logger.logProviderAccess({
      stepId,
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });

    // The exact capture primitive runtime.recordUseModelTrajectory invokes,
    // for a local-inference provider AND a cloud provider.
    logger.logLlmCall(
      llmCall(stepId, "local-inference", "eliza-1-2b", "hello from local"),
    );
    logger.logLlmCall(llmCall(stepId, "openai", "gpt-5.5", "hello from cloud"));

    // Flush the async step-write queue the bridge enqueues.
    await flushTrajectoryWrites(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await logger.flushWriteQueue?.(trajectoryId);

    expect(await readMetrics(trajectoryId)).toMatchObject({
      episodeLength: 1,
      finalStatus: "active",
    });
    const activeDetail = await logger.getTrajectoryDetail(trajectoryId);
    expect(activeDetail?.metrics?.finalStatus).toBe("active");
    const activeProviders = (activeDetail?.steps ?? []).flatMap(
      (step) => step.providerAccesses ?? [],
    );
    expect(activeProviders).toContainEqual(
      expect.objectContaining({ providerName: "facts" }),
    );

    await logger.endTrajectory(trajectoryId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await logger.flushWriteQueue?.(trajectoryId);
    expect(await readMetrics(trajectoryId)).toMatchObject({
      episodeLength: 1,
      finalStatus: "completed",
    });

    // Read back via the SAME SQL read API the viewer + collection use.
    const list = await logger.listTrajectories({ limit: 50, offset: 0 });
    expect(list.total).toBeGreaterThan(0);
    const found = list.trajectories.find((t) => t.id === trajectoryId);
    expect(
      found,
      "trajectory must be listed by the viewer reader",
    ).toBeTruthy();
    expect(
      found?.llmCallCount ?? 0,
      "BOTH local + cloud LLM calls must be counted",
    ).toBeGreaterThanOrEqual(2);

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.metrics?.finalStatus).toBe("completed");
    expect(detail?.metrics?.episodeLength).toBeGreaterThanOrEqual(1);
    const calls = (detail?.steps ?? []).flatMap((s) => s.llmCalls ?? []);
    const providers = new Set(
      calls.map((c) => c.provider).filter((p): p is string => Boolean(p)),
    );
    expect(providers.has("local-inference"), "local call persisted").toBe(true);
    expect(providers.has("openai"), "cloud call persisted").toBe(true);
    expect((detail?.steps ?? []).every((step) => step.action == null)).toBe(
      true,
    );

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    expect(listBody?.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: trajectoryId, llmCallCount: 2 }),
      ]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    const detailBody = asRecord(detailRoute.body);
    expect(detailBody?.toolEvents).toEqual([]);
    expect(detailBody?.llmCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "local-inference" }),
        expect.objectContaining({ provider: "openai" }),
      ]),
    );
    expect(detailBody?.providerAccesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerName: "facts" }),
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);
    const detachedFailures = reportError.mock.calls.filter(
      ([scope, error]) =>
        scope === "TrajectoriesService.detachedWrite" ||
        (error instanceof Error &&
          error.message.includes("TRAJECTORY_ROW_INVALID")),
    );
    expect(detachedFailures).toEqual([]);
  });

  it("keeps one successful VIEWS action and its nested model call on the completed parent", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const reportError = vi.spyOn(runtime, "reportError");
    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
      metadata: { roomId: "room-views-trajectory" },
    });
    const parentStepId = logger.startStep(trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);

    const roomId = crypto.randomUUID() as UUID;
    const worldId = crypto.randomUUID() as UUID;
    await runtime.ensureWorldExists({
      id: worldId,
      agentId: runtime.agentId,
      name: "Trajectory Action World",
    });
    await runtime.ensureRoomExists({
      id: roomId,
      agentId: runtime.agentId,
      worldId,
      source: "client_chat",
      type: ChannelType.DM,
      channelId: `client_chat:${roomId}`,
    });
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId,
      createdAt: Date.now(),
      content: { text: "Open my calendar", source: "chat" },
      metadata: { trajectoryId, trajectoryStepId: parentStepId },
    } as Memory;

    const result = await runWithTrajectoryContext(
      { trajectoryId, trajectoryStepId: parentStepId, purpose: "planner" },
      () =>
        executePlannedToolCall(
          runtime,
          { message, activeContexts: ["general"] },
          { name: "VIEWS", params: { view: "calendar" } },
        ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      data: { actionName: "VIEWS", view: "calendar", resolution: "calendar" },
    });
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 3,
      activeOwners: 1,
    });

    const terminalization = logger.endTrajectory(trajectoryId, "completed");
    logger.logProviderAccess({
      stepId: parentStepId,
      providerName: "delivery-receipt",
      purpose: "post-delivery",
      data: { delivered: true },
    });
    await terminalization;
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stepRowsResult = await executeRawSql(
      runtime,
      `SELECT id, parent_step_id, payload
       FROM trajectory_steps
       WHERE trajectory_id = '${trajectoryId.replaceAll("'", "''")}'
       ORDER BY ordinal ASC`,
    );
    const stepRows = extractRows(stepRowsResult).map(asRecord);
    const persistedActionStep = stepRows.find((row) => {
      const payload = parseMetadata(row?.payload);
      return asRecord(payload.action)?.actionName === "VIEWS";
    });
    expect(persistedActionStep, JSON.stringify(stepRows)).toMatchObject({
      parent_step_id: parentStepId,
    });

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.metrics?.finalStatus).toBe("completed");
    const actionSteps = (detail?.steps ?? []).filter(
      (step) => step.action?.actionName === "VIEWS",
    );
    expect(actionSteps).toHaveLength(1);
    expect(actionSteps[0]).toMatchObject({
      parentStepId,
      action: {
        actionName: "VIEWS",
        success: true,
        result: {
          success: true,
          data: { actionName: "VIEWS", view: "calendar" },
        },
      },
    });
    expect(actionSteps[0]?.llmCalls).toEqual([
      expect.objectContaining({ purpose: "action" }),
    ]);
    expect(
      (detail?.steps ?? []).find((step) => step.stepId === parentStepId)
        ?.providerAccesses,
    ).toEqual([]);
    // Same-instant post-delivery races are intentionally debug-only; aged late
    // captures retain full reportError coverage in trajectory-bridge.test.ts.
    expect(
      reportError.mock.calls.filter(
        ([scope]) => scope === "TrajectoryStorage.lateCapture",
      ),
    ).toEqual([]);

    const rowResult = await executeRawSql(
      runtime,
      `SELECT id, status, start_time, end_time, duration_ms
       FROM trajectories
       WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
    );
    const row = asRecord(extractRows(rowResult)[0]);
    expect(row?.status).toBe("completed");
    expect(Number.isFinite(Number(row?.end_time))).toBe(true);
    expect(Number.isFinite(Number(row?.duration_ms))).toBe(true);
    expect(Number(row?.end_time)).toBeGreaterThanOrEqual(
      Number(row?.start_time),
    );
    expect(Number(row?.duration_ms)).toBeGreaterThanOrEqual(0);

    const orphanResult = await executeRawSql(
      runtime,
      "SELECT id FROM trajectories WHERE id LIKE 'action-%' AND status = 'active'",
    );
    expect(extractRows(orphanResult)).toEqual([]);

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    expect(listBody?.trajectories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: trajectoryId })]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    const detailBody = asRecord(detailRoute.body);
    expect(detailBody?.toolEvents).toEqual([
      expect.objectContaining({
        actionName: "VIEWS",
        status: "completed",
        success: true,
      }),
    ]);
    expect(detailBody?.llmCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);
    const idleRows = await executeRawSql(
      runtime,
      "SELECT id FROM trajectories WHERE status = 'active' AND id LIKE 'action-%'",
    );
    expect(extractRows(idleRows)).toEqual([]);
    expect(
      reportError.mock.calls.filter(
        ([scope]) =>
          scope === "TrajectoriesService.detachedWrite" ||
          scope === "TrajectoryActionStep.complete" ||
          scope === "TrajectoryActionStep.normalize",
      ),
    ).toEqual([]);
  });

  it("persists RUN_ENDED errors as terminated and renders them as errors", async () => {
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Fail this run", source: "chat" },
    } as Memory;

    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message,
      source: "test",
    });
    const metadata = asRecord(message.metadata);
    const trajectoryId = metadata?.trajectoryId;
    expect(typeof trajectoryId).toBe("string");
    if (typeof trajectoryId !== "string") return;

    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: message.id,
      status: "error",
    });
    await flushTrajectoryWrites(runtime, trajectoryId);

    const rowResult = await executeRawSql(
      runtime,
      `SELECT status, metrics_json FROM trajectories
       WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
    );
    const row = asRecord(extractRows(rowResult)[0]);
    expect(row?.status).toBe("terminated");
    expect(parseMetadata(row?.metrics_json).finalStatus).toBe("terminated");

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    const trajectories = Array.isArray(listBody?.trajectories)
      ? listBody.trajectories
      : [];
    expect(trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: trajectoryId, status: "error" }),
      ]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    expect(asRecord(asRecord(detailRoute.body)?.trajectory)?.status).toBe(
      "error",
    );
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("persists evaluator ownership through the real child-step bridge", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "evaluator-test",
    });
    const parentStepId = logger.startStep(trajectoryId);

    await runWithTrajectoryContext(
      { trajectoryId, trajectoryStepId: parentStepId },
      () =>
        withEvaluatorStep(runtime, "real-quality-gate", async () => {
          const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
          expect(evaluatorStepId).not.toBe(parentStepId);
          expect(typeof evaluatorStepId).toBe("string");
          logger.logLlmCall({
            ...llmCall(
              evaluatorStepId ?? "missing-evaluator-step",
              "openai",
              "gpt-evaluator",
              "evaluator result",
            ),
            purpose: "evaluation",
            actionType: "evaluator.real-quality-gate",
          });
        }),
    );
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.endTrajectory(trajectoryId, "completed");

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    const evaluatorStep = detail?.steps?.find(
      (step) => step.evaluatorName === "real-quality-gate",
    );
    expect(evaluatorStep).toMatchObject({
      parentStepId,
      kind: "evaluator",
      evaluatorName: "real-quality-gate",
      llmCalls: [expect.objectContaining({ model: "gpt-evaluator" })],
    });
    expect(
      detail?.steps?.find((step) => step.stepId === parentStepId)?.childSteps,
    ).toEqual([evaluatorStep?.stepId]);
  });

  it.each(["simple", "action"] as const)(
    "keeps %s-run post-turn telemetry inside one evaluator child before the terminal write",
    async (variant) => {
      const logger = runtime.getService(
        "trajectories",
      ) as unknown as LifecycleTrajLogger;
      const reportError = vi.spyOn(runtime, "reportError");
      const reportCallStart = reportError.mock.calls.length;
      const endSpy = vi.spyOn(logger, "endTrajectory");
      const message = {
        id: crypto.randomUUID(),
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: crypto.randomUUID(),
        createdAt: Date.now(),
        content: { text: `${variant} post-turn ordering`, source: "chat" },
      } as Memory;
      await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
      const metadata = asRecord(message.metadata);
      const trajectoryId = metadata?.trajectoryId;
      const parentStepId = metadata?.trajectoryStepId;
      expect(typeof trajectoryId).toBe("string");
      expect(typeof parentStepId).toBe("string");
      if (
        typeof trajectoryId !== "string" ||
        typeof parentStepId !== "string"
      ) {
        return;
      }

      await flushTrajectoryWrites(runtime, trajectoryId);
      const initialDetail = await logger.getTrajectoryDetail(trajectoryId);
      const initialParentKind = initialDetail?.steps?.find(
        (step) => step.stepId === parentStepId,
      )?.kind;

      if (variant === "action") {
        const actionResult = await runWithTrajectoryContext(
          {
            trajectoryId,
            trajectoryStepId: parentStepId,
            purpose: "planner",
          },
          () =>
            executePlannedToolCall(
              runtime,
              { message, activeContexts: ["general"] },
              { name: "VIEWS", params: { view: "calendar" } },
            ),
        );
        expect(actionResult).toMatchObject({
          success: true,
          data: { actionName: "VIEWS", view: "calendar" },
        });
      }

      await trajectoryEventHandler("RUN_STARTED")({
        runtime,
        messageId: message.id,
      });
      await trajectoryEventHandler("MESSAGE_SENT")({
        runtime,
        message,
      });
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );

      let releaseEvaluation!: () => void;
      let markEvaluationStarted!: () => void;
      const evaluationGate = new Promise<void>((resolve) => {
        releaseEvaluation = resolve;
      });
      const evaluationStarted = new Promise<void>((resolve) => {
        markEvaluationStarted = resolve;
      });
      const evaluationWork = runWithTrajectoryContext(
        { trajectoryId, trajectoryStepId: parentStepId },
        () =>
          withEvaluatorStep(runtime, "post_turn", async () => {
            markEvaluationStarted();
            await evaluationGate;
            const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
            expect(evaluatorStepId).not.toBe(parentStepId);
            expect(typeof evaluatorStepId).toBe("string");
            const capturedStepId = evaluatorStepId ?? "missing-evaluator-step";
            logger.logProviderAccess({
              stepId: capturedStepId,
              providerName: "post-turn-context",
              purpose: "evaluation",
              data: { variant },
            });
            logger.logLlmCall({
              ...llmCall(
                capturedStepId,
                "openai",
                `post-turn-${variant}`,
                "evaluation complete",
              ),
              purpose: "evaluation",
              actionType: "evaluator.post_turn",
            });
          }),
      );
      await evaluationStarted;
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );

      releaseEvaluation();
      await evaluationWork;
      await trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: message.id,
        status: "completed",
      });
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);

      const detail = await logger.getTrajectoryDetail(trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId,
        kind: "evaluator",
        providerAccesses: [
          expect.objectContaining({ providerName: "post-turn-context" }),
        ],
        llmCalls: [
          expect.objectContaining({
            model: `post-turn-${variant}`,
            purpose: "evaluation",
          }),
        ],
      });
      expect(
        detail?.steps?.find((step) => step.stepId === parentStepId)?.kind,
      ).toBe(initialParentKind);
      expect(
        detail?.steps?.filter((step) => step.action?.actionName === "VIEWS"),
      ).toHaveLength(variant === "action" ? 1 : 0);
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(1);
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "completed",
      );
      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
      expect(
        reportError.mock.calls
          .slice(reportCallStart)
          .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
      ).toEqual([]);
      expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
        stepMappings: 0,
        activeOwners: 0,
      });
      endSpy.mockRestore();
      reportError.mockRestore();
    },
  );

  it("keeps concurrent-room evaluator children independently active until each run ends", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as LifecycleTrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    const reportCallStart = reportError.mock.calls.length;
    const endSpy = vi.spyOn(logger, "endTrajectory");
    const turns = await Promise.all(
      ["first", "second"].map(async (label) => {
        const message = {
          id: crypto.randomUUID(),
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          roomId: crypto.randomUUID(),
          createdAt: Date.now(),
          content: { text: `${label} concurrent room`, source: "chat" },
        } as Memory;
        await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
        const metadata = asRecord(message.metadata);
        const trajectoryId = metadata?.trajectoryId;
        const parentStepId = metadata?.trajectoryStepId;
        expect(typeof trajectoryId).toBe("string");
        expect(typeof parentStepId).toBe("string");
        if (
          typeof trajectoryId !== "string" ||
          typeof parentStepId !== "string"
        ) {
          throw new Error(`Missing ${label} trajectory metadata`);
        }
        await trajectoryEventHandler("RUN_STARTED")({
          runtime,
          messageId: message.id,
        });
        await trajectoryEventHandler("MESSAGE_SENT")({
          runtime,
          message,
        });
        let release!: () => void;
        let markStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const work = runWithTrajectoryContext(
          { trajectoryId, trajectoryStepId: parentStepId },
          () =>
            withEvaluatorStep(runtime, "post_turn", async () => {
              markStarted();
              await gate;
              const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
              if (!evaluatorStepId) {
                throw new Error(`Missing ${label} evaluator step`);
              }
              logger.logProviderAccess({
                stepId: evaluatorStepId,
                providerName: `post-turn-${label}`,
                purpose: "evaluation",
                data: { roomId: message.roomId },
              });
              logger.logLlmCall({
                ...llmCall(
                  evaluatorStepId,
                  "openai",
                  `concurrent-${label}`,
                  `${label} evaluation`,
                ),
                purpose: "evaluation",
              });
            }),
        );
        return {
          label,
          message,
          trajectoryId,
          release,
          started,
          work,
        };
      }),
    );
    await Promise.all(turns.map((turn) => turn.started));
    expect(
      await Promise.all(
        turns.map(
          async (turn) =>
            (await loadTrajectoryById(runtime, turn.trajectoryId))?.status,
        ),
      ),
    ).toEqual(["active", "active"]);

    turns[0].release();
    await turns[0].work;
    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: turns[0].message.id,
      status: "completed",
    });
    expect(
      (await loadTrajectoryById(runtime, turns[0].trajectoryId))?.status,
    ).toBe("completed");
    expect(
      (await loadTrajectoryById(runtime, turns[1].trajectoryId))?.status,
    ).toBe("active");

    turns[1].release();
    await turns[1].work;
    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: turns[1].message.id,
      status: "completed",
    });
    await flushTrajectoryWrites(runtime);
    for (const turn of turns) {
      await logger.flushWriteQueue?.(turn.trajectoryId);
      const detail = await logger.getTrajectoryDetail(turn.trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId: expect.any(String),
        providerAccesses: expect.arrayContaining([
          expect.objectContaining({ providerName: `post-turn-${turn.label}` }),
        ]),
        llmCalls: expect.arrayContaining([
          expect.objectContaining({ model: `concurrent-${turn.label}` }),
        ]),
      });
      expect(
        endSpy.mock.calls.filter(([id]) => id === turn.trajectoryId),
      ).toHaveLength(1);
      expect(
        (await loadTrajectoryById(runtime, turn.trajectoryId))?.status,
      ).toBe("completed");
      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
    }
    const activeRows = await executeRawSql(
      runtime,
      `SELECT id FROM trajectories WHERE id IN (${turns
        .map((turn) => `'${turn.trajectoryId.replaceAll("'", "''")}'`)
        .join(", ")}) AND status = 'active'`,
    );
    expect(extractRows(activeRows)).toEqual([]);
    expect(
      reportError.mock.calls
        .slice(reportCallStart)
        .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
    ).toEqual([]);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    endSpy.mockRestore();
    reportError.mockRestore();
  });

  it("drains a real message-service post-turn provider and model before the PGlite terminal", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as LifecycleTrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    const reportCallStart = reportError.mock.calls.length;
    const endSpy = vi.spyOn(logger, "endTrajectory");
    let releaseModel!: () => void;
    let markModelStarted!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const providerName = `POST_TURN_TERMINAL_${crypto.randomUUID()}`;
    const actionName = `POST_TURN_TERMINAL_ACTION_${crypto.randomUUID()}`;
    const provider: Provider = {
      name: providerName,
      description: "Test-only post-turn context.",
      private: true,
      get: async () => ({
        text: "post-turn provider context",
        data: { proof: "provider-captured-before-terminal" },
      }),
    };
    const afterAction: Action = {
      name: actionName,
      description: "Run gated post-turn telemetry.",
      similes: [],
      examples: [],
      mode: "ALWAYS_AFTER",
      validate: async () => true,
      handler: async (actionRuntime, actionMessage) => {
        const context = getTrajectoryContext();
        expect(context?.purpose).toBe("evaluation");
        await actionRuntime.composeState(
          actionMessage,
          [providerName],
          true,
          true,
        );
        await actionRuntime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Complete the gated post-turn diagnostic.",
        });
        return { success: true, text: "post-turn complete" };
      },
    };
    runtime.registerProvider(provider);
    runtime.registerAction(afterAction);
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [0.1, 0.2, 0.3],
      "terminal-owner-embedding",
      10_000,
    );
    runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => directResponseEnvelope("Delivery completed immediately."),
      "terminal-owner-response",
      10_000,
    );
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => {
        markModelStarted();
        await modelGate;
        return "post-turn model complete";
      },
      "terminal-owner-post-turn",
      10_000,
    );

    const entityId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: crypto.randomUUID() as UUID,
      userName: "Terminal Owner User",
      name: "Terminal Owner User",
      source: "client_chat",
      type: ChannelType.DM,
      channelId: `client_chat:${roomId}`,
    });
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt: Date.now(),
      content: {
        text: "remember this real message-service terminal proof",
        source: "client_chat",
        channelType: "DM",
      },
    } as Memory;
    const deliveries: string[] = [];
    const service = new DefaultMessageService();

    try {
      const result = await service.handleMessage(
        runtime,
        message,
        async (content) => {
          if (content.text) deliveries.push(content.text);
          return [];
        },
      );
      await modelStarted;
      expect(result.trajectoryTerminalOwner).toBe("run");
      expect(deliveries).toContain("Delivery completed immediately.");

      const metadata = asRecord(message.metadata);
      const trajectoryId = metadata?.trajectoryId;
      const parentStepId = metadata?.trajectoryStepId;
      expect(typeof trajectoryId).toBe("string");
      expect(typeof parentStepId).toBe("string");
      if (
        typeof trajectoryId !== "string" ||
        typeof parentStepId !== "string"
      ) {
        throw new Error("Message service did not retain trajectory ownership");
      }
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);
      const activeDetail = await logger.getTrajectoryDetail(trajectoryId);
      const parentKind = activeDetail?.steps?.find(
        (step) => step.stepId === parentStepId,
      )?.kind;
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(0);

      releaseModel();
      await drainPostDeliveryTasks(runtime);
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);

      const detail = await logger.getTrajectoryDetail(trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId,
        kind: "evaluator",
        llmCalls: expect.arrayContaining([
          expect.objectContaining({
            provider: "terminal-owner-post-turn",
            purpose: "evaluation",
          }),
        ]),
      });
      expect(
        detail?.steps?.flatMap((step) => step.providerAccesses ?? []),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerName })]),
      );
      expect(
        detail?.steps?.find((step) => step.stepId === parentStepId)?.kind,
      ).toBe(parentKind);
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(1);
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "completed",
      );

      const listRoute = await readRoute("/api/trajectories");
      expect(listRoute.status).toBe(200);
      expect(asRecord(listRoute.body)?.trajectories).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: trajectoryId })]),
      );
      const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
      expect(detailRoute.status).toBe(200);
      expect(asRecord(detailRoute.body)?.llmCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "terminal-owner-post-turn" }),
        ]),
      );
      expect(asRecord(detailRoute.body)?.providerAccesses).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerName })]),
      );

      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await drainPostDeliveryTasks(runtime);
      await flushTrajectoryWrites(runtime, trajectoryId);
      expect(
        reportError.mock.calls
          .slice(reportCallStart)
          .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
      ).toEqual([]);
      expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
        stepMappings: 0,
        activeOwners: 0,
      });
    } finally {
      const providerIndex = runtime.providers.indexOf(provider);
      if (providerIndex >= 0) runtime.providers.splice(providerIndex, 1);
      const actionIndex = runtime.actions.indexOf(afterAction);
      if (actionIndex >= 0) runtime.actions.splice(actionIndex, 1);
      for (const modelType of [
        ModelType.TEXT_EMBEDDING,
        ModelType.RESPONSE_HANDLER,
        ModelType.TEXT_LARGE,
      ]) {
        const modelKey = String(modelType);
        const registrations = runtime.models.get(modelKey);
        if (!registrations) continue;
        const retained = registrations.filter(
          (registration) =>
            !registration.provider.startsWith("terminal-owner-"),
        );
        if (retained.length === 0) runtime.models.delete(modelKey);
        else runtime.models.set(modelKey, retained);
      }
      endSpy.mockRestore();
      reportError.mockRestore();
      releaseModel();
    }
  });

  it("keeps dedicated steps authoritative for long captures, scripts, skills, evaluators, and exports", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const startedAt = Date.now();
    const trajectoryId = crypto.randomUUID();
    const parentStepId = crypto.randomUUID();
    const evaluatorStepId = crypto.randomUUID();
    const actionStepId = crypto.randomUUID();
    const longScript = "return input;\n".repeat(6_000);
    expect(longScript.length).toBeGreaterThan(65_536);

    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "test",
      {
        roomId: "room-authority",
        entityId: "entity-authority",
        conversationId: "conversation-authority",
      },
    );
    trajectory.steps[0] = {
      ...trajectory.steps[0],
      stepId: parentStepId,
      childSteps: [evaluatorStepId, actionStepId],
    };
    trajectory.steps.push({
      stepId: evaluatorStepId,
      parentStepId,
      stepNumber: 1,
      timestamp: startedAt + 1,
      kind: "evaluator",
      evaluatorName: "quality-gate",
      llmCalls: Array.from({ length: 260 }, (_, index) => ({
        ...llmCall(evaluatorStepId, "openai", "gpt-5.5", `evaluation-${index}`),
        callId: `${evaluatorStepId}-call-${index}`,
        timestamp: startedAt + index + 2,
        purpose: "evaluation",
        actionType: "evaluator.quality-gate",
      })),
      providerAccesses: [],
      usedSkills: ["calendar-review"],
      skillInvocations: [
        {
          skillSlug: "calendar-review",
          durationMs: 4,
          parentStepId,
          success: true,
          startedAt: startedAt + 1,
          mode: "guidance",
          result: "accepted",
        },
      ],
    });
    trajectory.steps.push({
      stepId: actionStepId,
      parentStepId,
      stepNumber: 2,
      timestamp: startedAt + 300,
      kind: "action",
      llmCalls: [
        {
          ...llmCall(
            actionStepId,
            "openai",
            "gpt-script",
            "script-backed action",
          ),
          callId: `${actionStepId}-call`,
          timestamp: startedAt + 300,
        },
      ],
      providerAccesses: [],
      script: longScript,
      action: {
        attemptId: `${actionStepId}-attempt`,
        timestamp: startedAt + 300,
        actionType: "action",
        actionName: "VIEWS",
        parameters: { view: "calendar" },
        success: true,
        result: { opened: "calendar" },
      },
    });
    trajectory.metrics = { successRate: 1, errorCount: 0 };
    trajectory.status = "completed";
    trajectory.endTime = startedAt + 500;
    trajectory.updatedAt = new Date(startedAt + 500).toISOString();
    await saveTrajectory(runtime, trajectory);

    const reloadedRuntime = sharedDatabaseRuntime(runtime.agentId);
    const byChild = await loadTrajectoryByStepId(reloadedRuntime, actionStepId);
    expect(byChild?.id).toBe(trajectoryId);
    expect(byChild?.steps).toHaveLength(3);
    expect(byChild?.steps[1]).toMatchObject({
      evaluatorName: "quality-gate",
      usedSkills: ["calendar-review"],
      skillInvocations: [
        expect.objectContaining({
          skillSlug: "calendar-review",
          success: true,
        }),
      ],
    });
    expect(byChild?.steps[1]?.llmCalls).toHaveLength(260);
    expect(byChild?.steps[2]?.script).toBe(longScript);

    const legacyResult = await executeRawSql(
      runtime,
      `SELECT steps_json, llm_call_count FROM trajectories
       WHERE id = '${trajectoryId}'`,
    );
    const legacyRow = asRecord(extractRows(legacyResult)[0]);
    const legacySteps = (
      typeof legacyRow?.steps_json === "string"
        ? JSON.parse(legacyRow.steps_json)
        : legacyRow?.steps_json
    ) as Array<{
      script?: string;
      scriptHash?: string;
    }>;
    expect(legacySteps[2]?.script).toBe(longScript);
    expect(legacySteps[2]?.scriptHash).toBeUndefined();
    expect(Number(legacyRow?.llm_call_count)).toBe(261);

    const publicStepId = crypto.randomUUID();
    const authorityAdapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const authorityDb = authorityAdapter.db;
    const incrementalSql: string[] = [];
    authorityAdapter.db = {
      execute: async (query) => {
        incrementalSql.push(sqlText(query));
        return authorityDb.execute(query);
      },
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        authorityDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              incrementalSql.push(sqlText(query));
              return tx.execute(query);
            },
          }),
        ),
    };
    try {
      await upsertStep(runtime, trajectoryId, {
        stepId: publicStepId,
        parentStepId,
        stepNumber: 3,
        timestamp: startedAt + 400,
        llmCalls: [
          {
            ...llmCall(
              publicStepId,
              "openai",
              "gpt-public",
              "public CQRS capture",
            ),
            callId: `${publicStepId}-call`,
            timestamp: startedAt + 400,
          },
        ],
        providerAccesses: [],
        kind: "action",
        action: {
          attemptId: `${publicStepId}-attempt`,
          timestamp: startedAt + 400,
          actionType: "action",
          actionName: "PUBLIC_CQRS",
          parameters: {},
          success: true,
          result: { persisted: true },
        },
      });
    } finally {
      authorityAdapter.db = authorityDb;
    }
    expect(
      incrementalSql.filter((text) =>
        /INSERT INTO trajectory_steps\s*\(/i.test(text),
      ),
    ).toHaveLength(1);
    expect(
      incrementalSql.some((text) => /DELETE FROM trajectory_steps/i.test(text)),
    ).toBe(false);
    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.steps).toHaveLength(4);
    expect(detail?.metrics).toMatchObject({
      successRate: 1,
      errorCount: 0,
      episodeLength: 4,
      finalStatus: "completed",
    });
    expect(
      detail?.steps?.find((step) => step.stepId === publicStepId)?.action,
    ).toMatchObject({ actionName: "PUBLIC_CQRS", success: true });

    const exported = await logger.exportTrajectories({
      format: "jsonl",
      trajectoryIds: [trajectoryId],
    });
    const exportedRows = String(exported.data)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exportedRows).toHaveLength(262);
    const exportedMetadata = exportedRows.map((row) => asRecord(row.metadata));
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(metadata?.trajectory_step)?.evaluatorName === "quality-gate",
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some((metadata) => {
        const usedSkills = asRecord(metadata?.trajectory_step)?.usedSkills;
        return (
          Array.isArray(usedSkills) && usedSkills.includes("calendar-review")
        );
      }),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(asRecord(metadata?.trajectory_step)?.action)?.actionName ===
          "PUBLIC_CQRS",
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(metadata?.trajectory_step)?.script === longScript,
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) => asRecord(metadata?.trajectory_metrics)?.successRate === 1,
      ),
    ).toBe(true);

    const storedList = await logger.listTrajectories({ limit: 500, offset: 0 });
    expect(storedList.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: trajectoryId,
          roomId: "room-authority",
          entityId: "entity-authority",
          conversationId: "conversation-authority",
          llmCallCount: 262,
          stepCount: 4,
        }),
      ]),
    );

    const listRoute = await readRoute("/api/trajectories");
    expect(asRecord(listRoute.body)?.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: trajectoryId,
          roomId: "room-authority",
          entityId: "entity-authority",
          llmCallCount: 262,
          metadata: expect.objectContaining({
            conversationId: "conversation-authority",
          }),
        }),
      ]),
    );
  });

  it("rolls back partial step replacement and preserves two-agent isolation", async () => {
    const baseDb = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter.db;
    let stepInsert = 0;
    const faultDb = {
      execute: baseDb.execute.bind(baseDb),
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        baseDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              const text = sqlText(query);
              if (
                /INSERT INTO trajectory_steps/i.test(text) &&
                ++stepInsert === 2
              ) {
                throw new Error("injected second-step failure");
              }
              return tx.execute(query);
            },
          }),
        ),
    };
    const faultRuntime = sharedDatabaseRuntime(runtime.agentId);
    (faultRuntime as unknown as { adapter: { db: unknown } }).adapter = {
      db: faultDb,
    };
    const trajectoryId = crypto.randomUUID();
    const startedAt = Date.now();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "fault-test",
    );
    trajectory.steps.push({
      stepId: crypto.randomUUID(),
      stepNumber: 1,
      timestamp: startedAt + 1,
      llmCalls: [],
      providerAccesses: [],
    });
    await expect(saveTrajectory(faultRuntime, trajectory)).rejects.toThrow(
      "Could not save trajectory steps",
    );
    const rolledBack = await executeRawSql(
      runtime,
      `SELECT id FROM trajectories WHERE id = '${trajectoryId}'`,
    );
    expect(extractRows(rolledBack)).toEqual([]);
    await saveTrajectory(runtime, trajectory);
    expect(
      (await loadTrajectoryById(runtime, trajectoryId))?.steps,
    ).toHaveLength(2);

    const otherRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const otherLogger = new DatabaseTrajectoryLogger(otherRuntime);
    const otherTrajectoryId = crypto.randomUUID();
    const other = createBaseTrajectory(
      otherTrajectoryId,
      startedAt + 10,
      otherRuntime.agentId,
      "other-agent",
    );
    await saveTrajectory(otherRuntime, other);

    const ownRows = await loadPersistedTrajectoryRows(otherRuntime);
    expect(ownRows.map((row) => row.id)).toContain(otherTrajectoryId);
    expect(ownRows.map((row) => row.id)).not.toContain(trajectoryId);
    expect(await otherLogger.getTrajectoryDetail(trajectoryId)).toBeNull();
    expect(
      (
        await otherLogger.listTrajectories({ limit: 500, offset: 0 })
      ).trajectories.map((item) => item.id),
    ).not.toContain(trajectoryId);
    expect(
      String(
        (
          await otherLogger.exportTrajectories({
            format: "jsonl",
            trajectoryIds: [trajectoryId],
          })
        ).data,
      ),
    ).not.toContain(trajectoryId);
    expect((await getSteps(otherRuntime, trajectoryId)).steps).toEqual([]);

    const forged = {
      ...trajectory,
      agentId: otherRuntime.agentId,
      updatedAt: new Date().toISOString(),
    };
    await expect(saveTrajectory(otherRuntime, forged)).rejects.toMatchObject({
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
    });
    expect(await otherLogger.deleteTrajectories([trajectoryId])).toBe(0);
    expect(await deleteStepsForTrajectories(otherRuntime, [trajectoryId])).toBe(
      0,
    );
    expect(await clearAllSteps(otherRuntime)).toBe(1);
    expect((await getSteps(runtime, trajectoryId)).steps).toHaveLength(2);
    expect(await otherLogger.deleteTrajectories([otherTrajectoryId])).toBe(1);
  });

  it("retries terminal durability once, claims concurrent endings, and rejects late or malformed capture", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    reportError.mockClear();
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Retry terminal persistence", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
    const trajectoryId = asRecord(message.metadata)?.trajectoryId;
    expect(typeof trajectoryId).toBe("string");
    if (typeof trajectoryId !== "string") return;

    const adapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const baseDb = adapter.db;
    let failTerminalWrite = true;
    adapter.db = {
      execute: baseDb.execute.bind(baseDb),
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        baseDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              if (
                failTerminalWrite &&
                /(?:INSERT INTO|UPDATE)\s+trajectories/i.test(sqlText(query))
              ) {
                failTerminalWrite = false;
                throw new Error("injected terminal write failure");
              }
              return tx.execute(query);
            },
          }),
        ),
    };
    try {
      await trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: message.id,
        status: "error",
      });
    } finally {
      adapter.db = baseDb;
    }
    const terminalRow = asRecord(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT status FROM trajectories WHERE id = '${trajectoryId}'`,
        ),
      )[0],
    );
    expect(terminalRow?.status).toBe("terminated");
    expect(
      reportError.mock.calls.some(
        ([scope, , context]) =>
          scope === "TrajectoriesPlugin.endRetry" &&
          asRecord(context)?.diagnosticOnly === true,
      ),
    ).toBe(true);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    const concurrentMessage = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Concurrent terminal events", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message: concurrentMessage,
    });
    const endSpy = vi.spyOn(logger, "endTrajectory");
    await Promise.all([
      trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: concurrentMessage.id,
        status: "completed",
      }),
      trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: concurrentMessage.id,
        status: "error",
      }),
    ]);
    expect(endSpy).toHaveBeenCalledTimes(1);
    endSpy.mockRestore();

    const countBeforeMissingId = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total FROM trajectories
             WHERE agent_id = '${runtime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    const missingIdMessage = {
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "No id", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message: missingIdMessage,
    });
    const countAfterMissingId = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total FROM trajectories
             WHERE agent_id = '${runtime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    expect(countAfterMissingId).toBe(countBeforeMissingId);
    expect(asRecord(missingIdMessage.metadata)?.trajectoryId).toBeUndefined();

    const captureTrajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
    });
    const childStepId = logger.startStep(captureTrajectoryId);
    logger.logLlmCall({ stepId: childStepId, model: "missing-contract" });
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "missing-data",
      purpose: "context",
    });
    logger.logLlmCall({
      ...llmCall(childStepId, "openai", "malformed-optional", "reject me"),
      promptTokens: "0" as unknown as number,
    });
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "malformed-duration",
      purpose: "context",
      data: {},
      durationMs: "0" as unknown as number,
    });
    logger.logLlmCall({
      ...llmCall(childStepId, "openai", "gpt-zero", "valid zero values"),
      temperature: 0,
      maxTokens: 0,
      latencyMs: 0,
    });
    await flushTrajectoryWrites(runtime, captureTrajectoryId);
    const activeDetail = await logger.getTrajectoryDetail(captureTrajectoryId);
    expect(
      activeDetail?.steps?.find((step) => step.stepId === childStepId)
        ?.llmCalls,
    ).toEqual([
      expect.objectContaining({
        model: "gpt-zero",
        temperature: 0,
        maxTokens: 0,
        latencyMs: 0,
      }),
    ]);
    await logger.endTrajectory(captureTrajectoryId, "completed");
    logger.logLlmCall(
      llmCall(childStepId, "openai", "late-model", "must be rejected"),
    );
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "late-provider",
      purpose: "context",
      data: {},
    });
    await flushTrajectoryWrites(runtime);
    const afterLate = await logger.getTrajectoryDetail(captureTrajectoryId);
    expect(
      afterLate?.steps?.flatMap((step) => step.llmCalls ?? []),
    ).toHaveLength(1);
    expect(
      afterLate?.steps?.flatMap((step) => step.providerAccesses ?? []),
    ).toHaveLength(0);
    expect(
      reportError.mock.calls.filter(
        ([scope, , context]) =>
          [
            "TrajectoryStorage.captureValidation",
            "TrajectoryStorage.lateCapture",
          ].includes(String(scope)) &&
          asRecord(context)?.diagnosticOnly === true,
      ),
    ).toHaveLength(4);
  });

  it("keeps the standalone database logger closed after end and stop", async () => {
    const publicRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const publicLogger = new DatabaseTrajectoryLogger(publicRuntime);
    publicLogger.setEnabled(true);
    const trajectoryId = crypto.randomUUID();
    const started = await publicLogger.startTrajectory(trajectoryId, {
      agentId: publicRuntime.agentId,
      source: "standalone-real",
    });
    const childStepId = publicLogger.startStep(started);
    publicLogger.logLlmCall(
      llmCall(childStepId, "openai", "standalone-live", "captured once"),
    );
    await publicLogger.flushWriteQueue(started);
    await publicLogger.endTrajectory(started, "completed");

    publicLogger.logLlmCall(
      llmCall(childStepId, "openai", "standalone-late", "must be rejected"),
    );
    publicLogger.logProviderAccess({
      stepId: childStepId,
      providerName: "standalone-late-provider",
      purpose: "context",
      data: {},
    });
    await publicLogger.flushWriteQueue();

    const completed = await loadTrajectoryById(publicRuntime, started);
    expect(completed?.status).toBe("completed");
    expect(
      completed?.steps
        .flatMap((step) => step.llmCalls)
        .map((call) => call.model),
    ).toEqual(["standalone-live"]);
    expect(completed?.steps.flatMap((step) => step.providerAccesses)).toEqual(
      [],
    );
    const orphanRows = extractRows(
      await executeRawSql(
        publicRuntime,
        `SELECT id FROM trajectories WHERE id = '${childStepId}'`,
      ),
    );
    expect(orphanRows).toEqual([]);
    expect(__getTrajectoryBridgeStateCountsForTests(publicRuntime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    expect(
      (
        publicRuntime.reportError as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        ([scope]) => scope === "TrajectoryStorage.lateCapture",
      ),
    ).toEqual([]);

    await publicLogger.stop();
    const countBefore = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            publicRuntime,
            `SELECT count(*) AS total FROM trajectories WHERE agent_id = '${publicRuntime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    const inertId = await publicLogger.startTrajectory(crypto.randomUUID(), {
      agentId: publicRuntime.agentId,
      source: "after-stop",
    });
    publicLogger.startStep(inertId);
    publicLogger.logLlmCall(
      llmCall(childStepId, "openai", "after-stop", "must remain inert"),
    );
    await publicLogger.flushWriteQueue();
    const countAfter = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            publicRuntime,
            `SELECT count(*) AS total FROM trajectories WHERE agent_id = '${publicRuntime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    expect(publicLogger.isEnabled()).toBe(false);
    expect(countAfter).toBe(countBefore);
    expect(__getTrajectoryBridgeStateCountsForTests(publicRuntime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("uses persisted terminal status after reload and closed-id eviction", async () => {
    const createLogger = async (
      mode: "public" | "installed",
      agentId: string,
    ): Promise<{
      runtime: AgentRuntime;
      logger: LifecycleTrajLogger;
    }> => {
      if (mode === "installed") return installedDatabaseLogger(agentId);
      const publicRuntime = sharedDatabaseRuntime(agentId);
      const publicLogger = new DatabaseTrajectoryLogger(
        publicRuntime,
      ) as LifecycleTrajLogger;
      publicLogger.setEnabled?.(true);
      return { runtime: publicRuntime, logger: publicLogger };
    };

    for (const mode of ["public", "installed"] as const) {
      const agentId = crypto.randomUUID();
      const creator = await createLogger(mode, agentId);
      const ownerId = crypto.randomUUID();
      const trajectoryId = await creator.logger.startTrajectory(ownerId, {
        agentId,
        source: `${mode}-persisted-terminal`,
      });
      const childStepId = creator.logger.startStep(trajectoryId);
      creator.logger.logLlmCall(
        llmCall(
          childStepId,
          "openai",
          `${mode}-live-before-reload`,
          "captured once",
        ),
      );
      await flushTrajectoryWrites(creator.runtime, trajectoryId);
      await creator.logger.endTrajectory(trajectoryId, "completed");

      const reloaded = await createLogger(mode, agentId);
      reloaded.logger.logLlmCall(
        llmCall(
          childStepId,
          "openai",
          `${mode}-late-after-reload`,
          "must be rejected",
        ),
      );
      reloaded.logger.logProviderAccess({
        stepId: trajectoryId,
        providerName: `${mode}-late-provider-after-reload`,
        purpose: "context",
        data: {},
      });
      await flushTrajectoryWrites(reloaded.runtime);

      for (let index = 0; index <= 10_000; index += 1) {
        reloaded.logger.releaseTrajectoryOwnership(
          `${mode}-eviction-owner-${index}`,
        );
      }
      reloaded.logger.logLlmCall(
        llmCall(
          trajectoryId,
          "openai",
          `${mode}-late-after-eviction`,
          "must still be rejected",
        ),
      );
      reloaded.logger.logProviderAccess({
        stepId: childStepId,
        providerName: `${mode}-late-provider-after-eviction`,
        purpose: "context",
        data: {},
      });
      await flushTrajectoryWrites(reloaded.runtime);

      const persisted = await loadTrajectoryById(
        reloaded.runtime,
        trajectoryId,
      );
      expect(persisted?.status).toBe("completed");
      expect(
        persisted?.steps
          .flatMap((step) => step.llmCalls)
          .map((call) => call.model),
      ).toEqual([`${mode}-live-before-reload`]);
      expect(persisted?.steps.flatMap((step) => step.providerAccesses)).toEqual(
        [],
      );
      expect(
        extractRows(
          await executeRawSql(
            reloaded.runtime,
            `SELECT id, status FROM trajectories WHERE agent_id = '${agentId}'`,
          ),
        ),
      ).toEqual([
        expect.objectContaining({ id: trajectoryId, status: "completed" }),
      ]);
      expect(
        __getTrajectoryBridgeStateCountsForTests(reloaded.runtime),
      ).toEqual({ stepMappings: 0, activeOwners: 0 });
      expect(
        (
          reloaded.runtime.reportError as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([scope, error, context]) =>
            scope === "TrajectoryStorage.lateCapture" &&
            asRecord(error)?.code === "TRAJECTORY_OWNER_CLOSED" &&
            asRecord(context)?.diagnosticOnly === true,
        ),
      ).toHaveLength(0);

      await reloaded.logger.stop();
      await creator.logger.stop();
    }
  });

  it("atomically arbitrates fresh-runtime capture against parent terminalization", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        for (const ordering of ["end-first", "capture-first"] as const) {
          const scenario = `${mode}/${captureType}/${ordering}`;
          const agentId = crypto.randomUUID();
          const creator = await databaseLogger(mode, agentId);
          const gated = transactionGatedRuntime(agentId);
          const capture = await databaseLogger(
            mode,
            agentId,
            ordering === "end-first"
              ? gated.runtime
              : sharedDatabaseRuntime(agentId),
          );
          const terminal = await databaseLogger(
            mode,
            agentId,
            ordering === "capture-first"
              ? gated.runtime
              : sharedDatabaseRuntime(agentId),
          );
          const ownerId = crypto.randomUUID();
          let terminalPromise: Promise<void> | undefined;
          try {
            const trajectoryId = await creator.logger.startTrajectory(ownerId, {
              agentId,
              source: `atomic-${scenario}`,
            });
            const childStepId = creator.logger.startStep(trajectoryId);
            await flushTrajectoryWrites(creator.runtime, trajectoryId);

            const recordCapture = (): void => {
              if (captureType === "llm") {
                capture.logger.logLlmCall(
                  llmCall(
                    childStepId,
                    "openai",
                    `atomic-${scenario}`,
                    `capture ${scenario}`,
                  ),
                );
                return;
              }
              capture.logger.logProviderAccess({
                stepId: childStepId,
                providerName: `atomic-${scenario}`,
                purpose: "context",
                data: { scenario },
              });
            };

            gated.gate.arm();
            if (ordering === "end-first") {
              recordCapture();
              await gated.gate.entered;
              try {
                await terminal.logger.endTrajectory(trajectoryId, "completed");
              } finally {
                gated.gate.release();
              }
              await flushTrajectoryWrites(capture.runtime);
            } else {
              terminalPromise = terminal.logger.endTrajectory(
                trajectoryId,
                "completed",
              );
              await gated.gate.entered;
              try {
                recordCapture();
                await flushTrajectoryWrites(capture.runtime);
              } finally {
                gated.gate.release();
              }
              await terminalPromise;
            }

            const rows = extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id, status, end_time, duration_ms,
                        llm_call_count, provider_access_count
                 FROM trajectories WHERE agent_id = '${agentId}'`,
              ),
            ).map((row) => asRecord(row));
            expect(rows, scenario).toHaveLength(1);
            expect(rows[0], scenario).toMatchObject({
              id: trajectoryId,
              status: "completed",
              llm_call_count:
                ordering === "capture-first" && captureType === "llm" ? 1 : 0,
              provider_access_count:
                ordering === "capture-first" && captureType === "provider"
                  ? 1
                  : 0,
            });
            expect(Number.isFinite(Number(rows[0]?.end_time)), scenario).toBe(
              true,
            );
            expect(
              Number.isFinite(Number(rows[0]?.duration_ms)),
              scenario,
            ).toBe(true);

            const persisted = await loadTrajectoryById(
              capture.runtime,
              trajectoryId,
            );
            expect(persisted?.status, scenario).toBe("completed");
            expect(persisted?.endTime, scenario).not.toBeNull();
            const child = persisted?.steps.find(
              (step) => step.stepId === childStepId,
            );
            expect(child, scenario).toBeDefined();
            expect(child?.llmCalls, scenario).toHaveLength(
              ordering === "capture-first" && captureType === "llm" ? 1 : 0,
            );
            expect(child?.providerAccesses, scenario).toHaveLength(
              ordering === "capture-first" && captureType === "provider"
                ? 1
                : 0,
            );
            expect(
              __getTrajectoryBridgeStateCountsForTests(capture.runtime),
              scenario,
            ).toEqual({ stepMappings: 0, activeOwners: 0 });
            expect(
              __getTrajectoryBridgeStateCountsForTests(terminal.runtime),
              scenario,
            ).toEqual({ stepMappings: 0, activeOwners: 0 });

            const lateReports = (
              capture.runtime.reportError as unknown as ReturnType<typeof vi.fn>
            ).mock.calls.filter(
              ([scope, , context]) =>
                scope === "TrajectoryStorage.lateCapture" &&
                asRecord(context)?.diagnosticOnly === true,
            );
            expect(lateReports, scenario).toHaveLength(0);
          } finally {
            gated.gate.release();
            try {
              if (terminalPromise) await terminalPromise;
            } finally {
              await terminal.logger.stop();
              await capture.logger.stop();
              await creator.logger.stop();
            }
          }
        }
      }
    }
  });

  it("retries distinct cross-runtime captures against the fresh active owner", async () => {
    const capturePairs = [
      { name: "llm-llm", first: "llm", second: "llm" },
      { name: "provider-provider", first: "provider", second: "provider" },
      { name: "llm-provider", first: "llm", second: "provider" },
    ] as const;

    for (const mode of ["public", "installed"] as const) {
      for (const pair of capturePairs) {
        const scenario = `${mode}/${pair.name}`;
        const agentId = crypto.randomUUID();
        const creator = await databaseLogger(mode, agentId);
        const gated = transactionGatedRuntime(agentId);
        const first = await databaseLogger(mode, agentId, gated.runtime);
        const second = await databaseLogger(
          mode,
          agentId,
          sharedDatabaseRuntime(agentId),
        );
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `active-race-${scenario}` },
          );
          const childStepId = creator.logger.startStep(trajectoryId);
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          recordLoggerCapture(
            first.logger,
            pair.first,
            childStepId,
            `active-race-${scenario}-first`,
          );
          await gated.gate.entered;
          try {
            recordLoggerCapture(
              second.logger,
              pair.second,
              childStepId,
              `active-race-${scenario}-second`,
            );
            await flushTrajectoryWrites(second.runtime);
          } finally {
            gated.gate.release();
          }
          await flushTrajectoryWrites(first.runtime);

          const active = await loadTrajectoryById(first.runtime, trajectoryId);
          expect(active?.status, scenario).toBe("active");
          const activeChild = active?.steps.find(
            (step) => step.stepId === childStepId,
          );
          expect(activeChild, scenario).toBeDefined();
          const expectedLlmModels = [
            ...(pair.first === "llm" ? [`active-race-${scenario}-first`] : []),
            ...(pair.second === "llm"
              ? [`active-race-${scenario}-second`]
              : []),
          ].sort();
          const expectedProviderNames = [
            ...(pair.first === "provider"
              ? [`active-race-${scenario}-first`]
              : []),
            ...(pair.second === "provider"
              ? [`active-race-${scenario}-second`]
              : []),
          ].sort();
          expect(
            activeChild?.llmCalls.map((call) => call.model).sort(),
            scenario,
          ).toEqual(expectedLlmModels);
          expect(
            activeChild?.providerAccesses
              .map((access) => access.providerName)
              .sort(),
            scenario,
          ).toEqual(expectedProviderNames);
          const captureIds = [
            ...(activeChild?.llmCalls.map((call) => call.callId) ?? []),
            ...(activeChild?.providerAccesses.map(
              (access) => access.providerId,
            ) ?? []),
          ];
          const validCaptureIds = captureIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          expect(captureIds, scenario).toHaveLength(2);
          expect(validCaptureIds, scenario).toHaveLength(captureIds.length);
          expect(new Set(validCaptureIds).size, scenario).toBe(2);

          const rows = extractRows(
            await executeRawSql(
              first.runtime,
              `SELECT id, status, llm_call_count, provider_access_count
               FROM trajectories WHERE agent_id = '${agentId}'`,
            ),
          ).map((row) => asRecord(row));
          expect(rows, scenario).toEqual([
            expect.objectContaining({
              id: trajectoryId,
              status: "active",
              llm_call_count: expectedLlmModels.length,
              provider_access_count: expectedProviderNames.length,
            }),
          ]);
          expect(
            first.runtime.reportError as unknown as ReturnType<typeof vi.fn>,
            scenario,
          ).not.toHaveBeenCalled();
          expect(
            second.runtime.reportError as unknown as ReturnType<typeof vi.fn>,
            scenario,
          ).not.toHaveBeenCalled();

          await creator.logger.endTrajectory(trajectoryId, "completed");
          const completed = await loadTrajectoryById(
            creator.runtime,
            trajectoryId,
          );
          expect(completed?.status, scenario).toBe("completed");
          expect(
            completed?.steps
              .find((step) => step.stepId === childStepId)
              ?.llmCalls.map((call) => call.model)
              .sort(),
            scenario,
          ).toEqual(expectedLlmModels);
          expect(
            completed?.steps
              .find((step) => step.stepId === childStepId)
              ?.providerAccesses.map((access) => access.providerName)
              .sort(),
            scenario,
          ).toEqual(expectedProviderNames);
          expect(
            __getTrajectoryBridgeStateCountsForTests(creator.runtime),
            scenario,
          ).toEqual({ stepMappings: 0, activeOwners: 0 });
        } finally {
          gated.gate.release();
          await second.logger.stop();
          await first.logger.stop();
          await creator.logger.stop();
        }
      }
    }
  });

  it("never recreates a parent deleted between capture load and write", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        const scenario = `${mode}/${captureType}`;
        const agentId = crypto.randomUUID();
        const creator = await databaseLogger(mode, agentId);
        const gated = transactionGatedRuntime(agentId);
        const capture = await databaseLogger(mode, agentId, gated.runtime);
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `delete-race-${scenario}` },
          );
          const childStepId = creator.logger.startStep(trajectoryId);
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          recordLoggerCapture(
            capture.logger,
            captureType,
            childStepId,
            `delete-race-${scenario}`,
          );
          await gated.gate.entered;
          try {
            await executeRawSql(
              creator.runtime,
              `DELETE FROM trajectories WHERE id = '${trajectoryId}'`,
            );
          } finally {
            gated.gate.release();
          }
          await expect(
            flushTrajectoryWrites(capture.runtime),
          ).rejects.toMatchObject({ code: "TRAJECTORY_PARENT_NOT_FOUND" });
          capture.logger.setEnabled?.(false);

          expect(
            extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id FROM trajectories WHERE agent_id = '${agentId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);
          expect(
            extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id FROM trajectory_steps
                 WHERE trajectory_id = '${trajectoryId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);
          expect(
            (
              capture.runtime.reportError as unknown as ReturnType<typeof vi.fn>
            ).mock.calls.some(
              ([scope, error, context]) =>
                scope === "TrajectoryStorage.write" &&
                asRecord(error)?.code === "TRAJECTORY_PARENT_NOT_FOUND" &&
                asRecord(context)?.diagnosticOnly === true,
            ),
            scenario,
          ).toBe(true);
        } finally {
          gated.gate.release();
          capture.logger.setEnabled?.(false);
          await creator.logger.stop();
        }
      }
    }
  });

  it("rejects raw-child capture until child ownership is durable", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        const scenario = `${mode}/${captureType}`;
        const agentId = crypto.randomUUID();
        const gated = transactionGatedRuntime(agentId);
        const creator = await databaseLogger(mode, agentId, gated.runtime);
        const capture = await databaseLogger(
          mode,
          agentId,
          sharedDatabaseRuntime(agentId),
        );
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `raw-child-${scenario}` },
          );
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          const childStepId = creator.logger.startStep(trajectoryId);
          await gated.gate.entered;
          recordLoggerCapture(
            capture.logger,
            captureType,
            childStepId,
            `raw-child-${scenario}`,
          );
          await expect(
            flushTrajectoryWrites(capture.runtime),
          ).rejects.toMatchObject({ code: "TRAJECTORY_PARENT_NOT_FOUND" });
          capture.logger.setEnabled?.(false);

          const rowsBeforeOwnership = extractRows(
            await executeRawSql(
              capture.runtime,
              `SELECT id, status FROM trajectories
               WHERE agent_id = '${agentId}' ORDER BY id`,
            ),
          ).map((row) => asRecord(row));
          expect(rowsBeforeOwnership, scenario).toEqual([
            expect.objectContaining({ id: trajectoryId, status: "active" }),
          ]);
          expect(
            rowsBeforeOwnership.some((row) => row?.id === childStepId),
            scenario,
          ).toBe(false);

          gated.gate.release();
          await flushTrajectoryWrites(creator.runtime, trajectoryId);
          const persisted = await loadTrajectoryById(
            creator.runtime,
            trajectoryId,
          );
          const child = persisted?.steps.find(
            (step) => step.stepId === childStepId,
          );
          expect(child, scenario).toBeDefined();
          expect(child?.llmCalls, scenario).toEqual([]);
          expect(child?.providerAccesses, scenario).toEqual([]);
          expect(
            extractRows(
              await executeRawSql(
                creator.runtime,
                `SELECT id FROM trajectories WHERE id = '${childStepId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);

          await creator.logger.endTrajectory(trajectoryId, "completed");
          expect(
            __getTrajectoryBridgeStateCountsForTests(creator.runtime),
            scenario,
          ).toEqual({ stepMappings: 0, activeOwners: 0 });
        } finally {
          gated.gate.release();
          capture.logger.setEnabled?.(false);
          await creator.logger.stop();
        }
      }
    }
  });

  it("rejects malformed parent and dedicated rows across list, detail, and native export", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const trajectoryId = crypto.randomUUID();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      Date.now(),
      runtime.agentId,
      "malformed-test",
    );
    await saveTrajectory(runtime, trajectory);
    await executeRawSql(
      runtime,
      `UPDATE trajectories SET status = 'not-a-status' WHERE id = '${trajectoryId}'`,
    );
    await expect(
      logger.listTrajectories({ limit: 500, offset: 0 }),
    ).rejects.toThrow();
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await expect(
      logger.exportTrajectories({
        format: "jsonl",
        trajectoryIds: [trajectoryId],
      }),
    ).rejects.toThrow();

    await executeRawSql(
      runtime,
      `UPDATE trajectories SET status = 'active', total_reward = 'NaN'
       WHERE id = '${trajectoryId}'`,
    );
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await executeRawSql(
      runtime,
      `UPDATE trajectories SET total_reward = 0 WHERE id = '${trajectoryId}'`,
    );
    await executeRawSql(
      runtime,
      `UPDATE trajectory_steps SET payload = '{}' WHERE trajectory_id = '${trajectoryId}'`,
    );
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await expect(
      logger.exportTrajectories({
        format: "jsonl",
        trajectoryIds: [trajectoryId],
      }),
    ).rejects.toThrow();
    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
    );
    await executeRawSql(
      runtime,
      `DELETE FROM trajectories WHERE id = '${trajectoryId}'`,
    );
  });

  it("enforces ownership and cleanup on the unconstrained base trajectory_steps schema", async () => {
    const startedAt = Date.now();
    const trajectoryId = crypto.randomUUID();
    const parentStepId = crypto.randomUUID();
    const childStepId = crypto.randomUUID();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "legacy-schema-test",
    );
    trajectory.steps[0] = {
      ...trajectory.steps[0],
      stepId: parentStepId,
      childSteps: [childStepId],
    };
    trajectory.steps.push({
      stepId: childStepId,
      parentStepId,
      stepNumber: 1,
      timestamp: startedAt + 1,
      llmCalls: [],
      providerAccesses: [],
      kind: "action",
      script: "return 'preserved';",
    });
    await saveTrajectory(runtime, trajectory);

    const rowsBefore = extractRows(
      await executeRawSql(
        runtime,
        `SELECT id, trajectory_id, ordinal, parent_step_id, step_type, name,
                started_at, ended_at, payload, script
         FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'
         ORDER BY ordinal`,
      ),
    ).map(asRecord);
    await executeRawSql(runtime, "DROP TABLE trajectory_steps");
    await executeRawSql(
      runtime,
      `CREATE TABLE trajectory_steps (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        parent_step_id TEXT,
        step_type TEXT NOT NULL DEFAULT 'llm',
        name TEXT,
        started_at BIGINT,
        ended_at BIGINT,
        payload TEXT NOT NULL DEFAULT '{}',
        script TEXT
      )`,
    );
    for (const row of rowsBefore) {
      const payload =
        typeof row?.payload === "string"
          ? row.payload
          : JSON.stringify(row?.payload);
      await executeRawSql(
        runtime,
        `INSERT INTO trajectory_steps (
          id, trajectory_id, ordinal, parent_step_id, step_type, name,
          started_at, ended_at, payload, script
        ) VALUES (
          '${String(row?.id)}', '${String(row?.trajectory_id)}',
          ${Number(row?.ordinal)},
          ${row?.parent_step_id ? `'${String(row.parent_step_id)}'` : "NULL"},
          '${String(row?.step_type)}',
          ${row?.name ? `'${String(row.name)}'` : "NULL"},
          ${Number(row?.started_at)}, ${Number(row?.ended_at)},
          '${payload.replaceAll("'", "''")}',
          ${row?.script ? `'${String(row.script).replaceAll("'", "''")}'` : "NULL"}
        )`,
      );
    }

    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_schema_migrations
       WHERE id = 'trajectory_steps_constraints_v1'`,
    );

    const freshRuntime = sharedDatabaseRuntime(runtime.agentId);
    await expect(ensureTrajectoriesTable(freshRuntime)).resolves.toBe(true);
    const foreignKeyCount = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total
             FROM pg_constraint
             WHERE conrelid = 'trajectory_steps'::regclass
               AND contype = 'f'`,
          ),
        )[0],
      )?.total,
    );
    expect(foreignKeyCount).toBe(2);
    const preserved = await loadTrajectoryById(freshRuntime, trajectoryId);
    expect(preserved?.steps).toHaveLength(2);
    expect(preserved?.steps[1]).toMatchObject({
      parentStepId,
      script: "return 'preserved';",
    });

    const migrationTrajectoryId = crypto.randomUUID();
    const migrationTrajectory = createBaseTrajectory(
      migrationTrajectoryId,
      startedAt + 2,
      runtime.agentId,
      "forward-migration-fault",
    );
    migrationTrajectory.steps.push({
      stepId: crypto.randomUUID(),
      parentStepId: migrationTrajectory.steps[0]?.stepId,
      stepNumber: 1,
      timestamp: startedAt + 3,
      llmCalls: [],
      providerAccesses: [],
    });
    migrationTrajectory.steps[0] = {
      ...migrationTrajectory.steps[0],
      childSteps: [migrationTrajectory.steps[1]?.stepId ?? "missing-child"],
    };
    await saveTrajectory(runtime, migrationTrajectory);
    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_steps
       WHERE trajectory_id = '${migrationTrajectoryId}'`,
    );

    const migrationAdapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const migrationDb = migrationAdapter.db;
    let migrationInsertCount = 0;
    let failMigrationInsert = true;
    const faultMigrationRuntime = sharedDatabaseRuntime(runtime.agentId);
    (faultMigrationRuntime as unknown as { adapter: { db: unknown } }).adapter =
      {
        db: {
          execute: migrationDb.execute.bind(migrationDb),
          transaction: <T>(
            callback: (tx: {
              execute: (query: unknown) => Promise<unknown>;
            }) => Promise<T>,
          ): Promise<T> =>
            migrationDb.transaction((tx) =>
              callback({
                execute: async (query) => {
                  if (
                    /INSERT INTO trajectory_steps\s*\(/i.test(sqlText(query))
                  ) {
                    migrationInsertCount += 1;
                    if (failMigrationInsert && migrationInsertCount === 2) {
                      failMigrationInsert = false;
                      throw new Error("injected forward-migration failure");
                    }
                  }
                  return tx.execute(query);
                },
              }),
            ),
        },
      };
    await expect(ensureTrajectoriesTable(faultMigrationRuntime)).resolves.toBe(
      true,
    );
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps
           WHERE trajectory_id = '${migrationTrajectoryId}'`,
        ),
      ),
    ).toEqual([]);
    expect(
      (await loadTrajectoryById(faultMigrationRuntime, migrationTrajectoryId))
        ?.steps,
    ).toHaveLength(2);
    await expect(ensureTrajectoriesTable(faultMigrationRuntime)).resolves.toBe(
      true,
    );
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps
           WHERE trajectory_id = '${migrationTrajectoryId}'`,
        ),
      ),
    ).toHaveLength(2);

    const otherRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const otherTrajectoryId = crypto.randomUUID();
    await saveTrajectory(
      otherRuntime,
      createBaseTrajectory(
        otherTrajectoryId,
        startedAt + 10,
        otherRuntime.agentId,
        "legacy-schema-other",
      ),
    );
    await expect(
      upsertStep(otherRuntime, otherTrajectoryId, {
        stepId: childStepId,
        stepNumber: 1,
        timestamp: startedAt + 11,
        llmCalls: [],
        providerAccesses: [],
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT" });

    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    expect(await logger.deleteTrajectories([trajectoryId])).toBe(1);
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
        ),
      ),
    ).toEqual([]);
  });
});
