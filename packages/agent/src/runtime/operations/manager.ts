/**
 * DefaultRuntimeOperationManager — the single use case for state-changing
 * lifecycle actions against the live runtime.
 *
 * Lifecycle:
 *   1. Caller (route layer) hands us an OperationIntent (already validated).
 *   2. We classify the intent into a ReloadTier.
 *   3. If an op is already active we reject with `rejected-busy`. If an
 *      idempotency key matches a record within retention we return
 *      `deduped`. Otherwise we accept synchronously and run the op
 *      asynchronously on the next microtask.
 *   4. Each phase mutation is appended to the repo. The repo's active-op
 *      slot is the single-flight gate; no extra in-memory mutex is used
 *      across operations, but the manager serializes its own
 *      `executeOperation` calls via a Promise chain.
 */

import crypto from "node:crypto";
import { hostname } from "node:os";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { ClassifyContext } from "./classifier.ts";
import type { HealthChecker } from "./health.ts";
import type {
  OperationError,
  OperationErrorCode,
  OperationIntent,
  OperationPhase,
  ReloadStrategy,
  ReloadTier,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationManager,
  RuntimeOperationRepository,
  StartOperationOutcome,
  StartOperationRequest,
} from "./types.ts";

export type IntentClassifier = (
  intent: OperationIntent,
  ctx: ClassifyContext,
) => ReloadTier;

export interface DefaultRuntimeOperationManagerOptions {
  repository: RuntimeOperationRepository;
  /**
   * Resolves the *current* live runtime. Called per-operation so the
   * manager always sees the latest reference (cold ops swap it).
   */
  runtime: () => AgentRuntime | null;
  /**
   * Snapshots the live config slice the classifier needs. Called once per
   * `start()` so the classifier sees the state at submission time, not at
   * execution time (which may be after another op completes).
   */
  classifyContext: () => ClassifyContext;
  /**
   * Defaults to `() => "cold"` (conservative). Wire `defaultClassifier`
   * from `./classifier.js` to enable hot/warm tiering.
   */
  classifier?: IntentClassifier;
  healthChecker: HealthChecker;
  /**
   * Tier → strategy. Cold is the conservative baseline; warm/hot strategies
   * are registered by hosts that support lighter-weight reload paths.
   */
  strategies: Partial<Record<ReloadTier, ReloadStrategy>>;
}

const DEFAULT_CLASSIFIER: IntentClassifier = () => "cold";

function strategyErrorCode(err: unknown): OperationErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "vault-resolve-failed" ? code : "strategy-failed";
}

export class DefaultRuntimeOperationManager implements RuntimeOperationManager {
  private readonly repository: RuntimeOperationRepository;
  private readonly runtime: () => AgentRuntime | null;
  private readonly classifyContext: () => ClassifyContext;
  private readonly classifier: IntentClassifier;
  private readonly healthChecker: HealthChecker;
  private readonly strategies: Partial<Record<ReloadTier, ReloadStrategy>>;
  /**
   * Serializes `executeOperation` invocations within a single process.
   * The repo's active-op slot is the cross-process gate.
   */
  private executionChain: Promise<void> = Promise.resolve();
  private startChain: Promise<void> = Promise.resolve();

  constructor(opts: DefaultRuntimeOperationManagerOptions) {
    this.repository = opts.repository;
    this.runtime = opts.runtime;
    this.classifyContext = opts.classifyContext;
    this.classifier = opts.classifier ?? DEFAULT_CLASSIFIER;
    this.healthChecker = opts.healthChecker;
    this.strategies = opts.strategies;
  }

  async start(req: StartOperationRequest): Promise<StartOperationOutcome> {
    let outcome: StartOperationOutcome | undefined;
    const run = this.startChain.then(async () => {
      outcome = await this.startLocked(req);
    });
    this.startChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    if (!outcome) {
      throw new Error("[runtime-ops] start did not produce an outcome");
    }
    return outcome;
  }

  private async startLocked(
    req: StartOperationRequest,
  ): Promise<StartOperationOutcome> {
    if (req.idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(
        req.idempotencyKey,
      );
      if (existing) {
        logger.info(
          `[runtime-ops] Idempotent hit for key=${req.idempotencyKey} → ${existing.id}`,
        );
        return { kind: "deduped", operation: existing };
      }
    }

    const active = await this.repository.findActive();
    if (active) {
      logger.info(
        `[runtime-ops] Rejected new op: active operation in flight ${active.id}`,
      );
      return { kind: "rejected-busy", activeOperationId: active.id };
    }

    // Snapshot the classify context BEFORE prepare() runs: prepare() mutates
    // the live config to the target provider, so reading currentProvider after
    // it would always equal the target, so every provider-switch would
    // classify as "hot" and an unloaded provider plugin (e.g. switching
    // elizacloud -> cerebras, or onboarding a first provider) would miss the
    // cold restart that loads it, leaving the runtime with no provider.
    const ctxBeforePrepare = this.classifyContext();
    const prepareResult = req.prepare ? await req.prepare() : undefined;
    const preparedIntent =
      prepareResult === undefined ? req.intent : prepareResult;
    const tier = this.classifier(preparedIntent, ctxBeforePrepare);
    const now = Date.now();
    const op: RuntimeOperation = {
      id: crypto.randomUUID(),
      processOwner: { hostname: hostname(), pid: process.pid },
      kind: preparedIntent.kind,
      intent: preparedIntent,
      tier,
      idempotencyKey: req.idempotencyKey,
      status: "pending",
      phases: [],
      startedAt: now,
    };

    await this.repository.create(op);
    logger.info(
      `[runtime-ops] Accepted op ${op.id} kind=${op.kind} tier=${op.tier}`,
    );

    // Schedule async; do NOT await. The route caller returns 202
    // immediately and the client polls /events for status.
    this.scheduleExecution(op.id);

    return { kind: "accepted", operation: op };
  }

  async get(id: string): Promise<RuntimeOperation | null> {
    return this.repository.get(id);
  }

  async list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]> {
    return this.repository.list(opts);
  }

  async findActive(): Promise<RuntimeOperation | null> {
    return this.repository.findActive();
  }

  private scheduleExecution(id: string): void {
    this.executionChain = this.executionChain.then(() =>
      this.executeOperation(id).catch((err) => {
        logger.error(
          `[runtime-ops] Unhandled error executing op ${id}: ${err instanceof Error ? err.stack : String(err)}`,
        );
      }),
    );
  }

  private async executeOperation(id: string): Promise<void> {
    const op = await this.repository.get(id);
    if (!op) {
      logger.warn(`[runtime-ops] executeOperation: op ${id} not found`);
      return;
    }

    await this.repository.update(id, { status: "running" });

    // Validation gate (the route layer already validated; this records the
    // gate boundary so the phase log is complete).
    const validateAt = Date.now();
    await this.repository.appendPhase(id, {
      name: "validate",
      status: "succeeded",
      startedAt: validateAt,
      finishedAt: validateAt,
    });

    const strategy = this.strategies[op.tier];
    if (!strategy) {
      await this.failOperation(id, {
        message: `No strategy registered for tier=${op.tier}`,
        code: "no-strategy-for-tier",
      });
      return;
    }

    const runtime = this.runtime();
    if (!runtime) {
      await this.failOperation(id, {
        message: "No live runtime available to apply operation",
        code: "no-runtime",
      });
      return;
    }

    const reportPhase = (phase: OperationPhase): Promise<void> =>
      this.repository.appendPhase(id, phase);

    let newRuntime: AgentRuntime;
    try {
      newRuntime = await strategy.apply({
        runtime,
        intent: op.intent,
        reportPhase,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[runtime-ops] Strategy failed for op ${id}: ${message}`);
      await this.failOperation(id, { message, code: strategyErrorCode(err) });
      return;
    }

    // Health-check gate.
    const healthStart = Date.now();
    await this.repository.appendPhase(id, {
      name: "health-check",
      status: "running",
      startedAt: healthStart,
    });

    const report = await this.healthChecker.runForRuntime(newRuntime);
    const healthEnd = Date.now();

    if (!report.ok) {
      await this.repository.updateLastPhase(id, {
        status: "failed",
        finishedAt: healthEnd,
        detail: {
          passed: report.passed,
          failed: report.failed,
        },
      });
      // The cold strategy has already swapped the runtime by the time we
      // observe a failed health check. Surface the failure; restoring the
      // previous runtime requires a two-phase restart contract with the API
      // server restart closure.
      logger.warn(`[runtime-ops] Health check failed for op ${id}`);
      await this.failOperation(id, {
        message: "Required health checks failed",
        code: "health-check-failed",
      });
      return;
    }

    await this.repository.updateLastPhase(id, {
      status: "succeeded",
      finishedAt: healthEnd,
      detail: {
        passed: report.passed,
        failed: report.failed,
      },
    });

    await this.repository.update(id, {
      status: "succeeded",
      finishedAt: Date.now(),
    });
    logger.info(`[runtime-ops] Operation ${id} succeeded`);
  }

  private async failOperation(
    id: string,
    error: OperationError,
  ): Promise<void> {
    await this.repository.update(id, {
      status: "failed",
      finishedAt: Date.now(),
      error,
    });
    logger.warn(
      `[runtime-ops] Operation ${id} failed: ${error.code ?? "unknown"} — ${error.message}`,
    );
  }
}
