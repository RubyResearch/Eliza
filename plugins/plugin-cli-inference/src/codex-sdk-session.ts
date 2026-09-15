/**
 * Request-isolated Codex SDK inference for Eliza text and structured decisions.
 *
 * Runs an Eliza chat brain (chat + planner) on a personal ChatGPT/Codex
 * subscription via `@openai/codex-sdk`, which wraps the bundled `codex` binary
 * and manages its own authentication. The installed TypeScript SDK spawns the
 * CLI for every run. Each request starts a fresh thread: Eliza supplies the
 * complete authorized context, without a second hidden conversation history.
 *
 * TWO MODES:
 *  - TEXT mode (`generate`): pure completion for the reply / large tiers. The
 *    thread runs read-only, no network, no approvals.
 *    Returns the turn's `finalResponse`.
 *  - ROUTE mode (`route`): the ACTION_PLANNER decision via codex NATIVE structured
 *    output (`TurnOptions.outputSchema`). The schema constrains the turn to
 *    `{action, params}` with `params` as a JSON STRING (OpenAI strict mode forbids
 *    open-ended objects), which `normalizeRoute` parses back into the bare
 *    `{action, params}` shape the planner loop's text-mode parser accepts. This
 *    is validated before being returned to Eliza. Use a current installed Codex
 *    binary supporting structured output and the inference isolation flags.
 *
 * System content is folded into each request body. Calls on an adapter instance
 * are serialized, but no provider thread survives a completed or failed call.
 *
 * @module plugin-cli-inference/codex-sdk-session
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@elizaos/core";
import type { RotationSubprocessEnv } from "./account-rotation";
import { filterEnv } from "./sandbox";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_RESTART_AFTER_TURNS = 20;

/** The model's captured routing decision (ROUTE mode). */
export interface CodexRouteDecision {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Output schema constraining ROUTE-mode output to `{action, params}` where
 * `params` is a JSON STRING. OpenAI strict structured-output forbids open-ended
 * objects (every nested object must declare all properties + additionalProperties:
 * false), so an arbitrary params object is impossible — encoding params as a JSON
 * string sidesteps that while still guaranteeing the shape. Requires the system
 * codex binary (the SDK's bundled one rejects it / the model).
 */
const ROUTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "params"],
  properties: {
    action: { type: "string" },
    params: { type: "string", description: "JSON-encoded params object" },
  },
} as const;

interface CodexTurn {
  items?: Array<{ type?: string; text?: string }>;
  finalResponse?: string;
  usage?: unknown;
}
interface CodexThread {
  run(
    input: string,
    turnOptions?: { outputSchema?: unknown; signal?: AbortSignal }
  ): Promise<CodexTurn>;
}
interface CodexInstance {
  startThread(options?: Record<string, unknown>): CodexThread;
}
/** Minimal shape of the `@openai/codex-sdk` module we load lazily. */
export interface CodexModule {
  Codex: new (options?: Record<string, unknown>) => CodexInstance;
}

export interface CodexSdkSessionConfig {
  model?: string | null;
  /** ROUTE mode (free-text `{action,params}` JSON) vs TEXT mode (plain completion). */
  router?: boolean;
  /** `modelReasoningEffort` for the thread (minimal|low|medium|high|xhigh). */
  reasoningEffort?: string | null;
  /**
   * Path to the codex binary the SDK should drive (`codexPathOverride`). The SDK
   * BUNDLES its own (often older) codex under `vendor/`; that bundled binary
   * rejects newer models with "requires a newer version of Codex". Point this at
   * the installed system codex (e.g. `~/.local/bin/codex`) so current models like
   * gpt-5.5 work.
   */
  codexBinPath?: string | null;
  /** Legacy compatibility option; requests now always use fresh threads. */
  restartAfterTurns?: number;
  /**
   * Optional subprocess-only env for a pooled account. Passed to the Codex SDK
   * constructor; never written to the parent process env.
   */
  subprocessEnv?: RotationSubprocessEnv | null;
  /** Injected for tests; defaults to the real SDK. */
  codexModule?: CodexModule;
}

const SDK_PACKAGE = "@openai/codex-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCodexModule(value: unknown): value is CodexModule {
  return isRecord(value) && typeof value.Codex === "function";
}

async function loadCodex(): Promise<CodexModule> {
  const codex: unknown = await import(SDK_PACKAGE);
  if (!isCodexModule(codex)) {
    throw new Error("[cli-inference:codex-sdk] Codex SDK module has an unexpected shape");
  }
  return codex;
}

/** Pull the assistant text out of a completed codex turn. */
function turnToText(turn: CodexTurn): string {
  if (typeof turn.finalResponse === "string" && turn.finalResponse.trim()) {
    return turn.finalResponse.trim();
  }
  // Fallback: the last agent_message item's text.
  for (const item of [...(turn.items ?? [])].reverse()) {
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

/**
 * Serializes requests for one adapter configuration. Every request creates a
 * fresh thread: Eliza owns the authorized conversation context. The installed
 * SDK starts a subprocess for each run, not a persistent inference process.
 */
export class CodexSdkSession {
  private readonly model: string;
  private readonly router: boolean;
  private readonly reasoningEffort: string | null;
  private readonly codexBinPath: string | null;
  private readonly restartAfterTurns: number;
  private readonly subprocessEnv: RotationSubprocessEnv | null;
  private readonly codexOverride?: CodexModule;

  private thread: CodexThread | null = null;
  private workingDirectory: string | null = null;
  private turns = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lifecycle = new AbortController();

  constructor(config: CodexSdkSessionConfig) {
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.router = config.router === true;
    this.reasoningEffort = config.reasoningEffort?.trim() || null;
    this.codexBinPath = config.codexBinPath?.trim() || null;
    this.restartAfterTurns =
      config.restartAfterTurns && config.restartAfterTurns > 0
        ? config.restartAfterTurns
        : DEFAULT_RESTART_AFTER_TURNS;
    this.subprocessEnv = config.subprocessEnv ?? null;
    this.codexOverride = config.codexModule;
  }

  /** TEXT mode: generate one completion's text. Serialized. */
  generate(body: string, outputSchema?: unknown, signal?: AbortSignal): Promise<string> {
    const requestSignal = this.requestSignal(signal);
    return this.enqueue(() => this.sendOnce(body, "text", outputSchema, requestSignal));
  }

  /**
   * ROUTE mode: return `JSON.stringify({action, params})` — the action the model
   * picked via codex's native structured output. Consumed directly by the planner
   * loop's text-mode parser, so no core change is needed.
   */
  route(body: string, signal?: AbortSignal): Promise<string> {
    const requestSignal = this.requestSignal(signal);
    return this.enqueue(() => this.sendOnce(body, "route", undefined, requestSignal));
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // error-policy:J5 the chain tail only serializes turns; the REAL result/error
    // is returned to the caller via `run`. Swallowing here just stops a settled
    // tail from raising an unhandled rejection — the caller still sees the error.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendOnce(
    body: string,
    mode: "text" | "route",
    outputSchema: unknown,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted();
    if (!body.trim()) {
      throw new Error("[cli-inference:codex-sdk] empty prompt body");
    }
    if (this.thread && this.turns >= this.restartAfterTurns) {
      this.releaseThread();
    }
    try {
      if (!this.thread) await this.start();
      signal.throwIfAborted();
      this.turns += 1;
      const thread = this.thread;
      if (!thread) throw new Error("[cli-inference:codex-sdk] thread not started");
      // ROUTE: constrain output to {action, params:json-string} via the codex
      // native output schema (reliable shape; needs the system codex binary).
      const turn = await thread.run(body, {
        signal,
        ...(outputSchema
          ? { outputSchema }
          : mode === "route"
            ? { outputSchema: ROUTE_OUTPUT_SCHEMA }
            : {}),
      });
      const text = turnToText(turn);
      if (mode === "route") {
        return this.normalizeRoute(text);
      }
      if (!text) {
        throw new Error("[cli-inference:codex-sdk] empty completion");
      }
      return text;
    } catch (err) {
      // error-policy:J2 context-adding rethrow — self-heal (a dead/erroring thread
      // must not poison the next turn), then rethrow so the caller sees the failure.
      this.releaseThread();
      throw err instanceof Error ? err : new Error(`[cli-inference:codex-sdk] ${String(err)}`);
    } finally {
      // Eliza owns conversation history and access filtering, not the SDK.
      this.releaseThread();
      const directory = this.workingDirectory;
      this.workingDirectory = null;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  /** Coerce the structured-output JSON into a bare {action, params} string. */
  private normalizeRoute(text: string): string {
    if (!text) {
      throw new Error("[cli-inference:codex-sdk] route: empty structured output");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // error-policy:J3 reject malformed structured output, never infer a route.
      throw new Error("[cli-inference:codex-sdk] route: non-JSON output", { cause });
    }
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw new Error("[cli-inference:codex-sdk] route: expected an object");
    }
    const obj = parsed;
    if (typeof obj.action !== "string" || !obj.action.trim()) {
      throw new Error("[cli-inference:codex-sdk] route: missing action");
    }
    // `params` arrives as a JSON STRING (ROUTE_OUTPUT_SCHEMA encodes it that way
    // for strict-mode), or already as an object on the free-text fallback path.
    const params: unknown = typeof obj.params === "string" ? JSON.parse(obj.params) : obj.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("[cli-inference:codex-sdk] route: params must be an object");
    }
    return JSON.stringify({
      action: obj.action.trim(),
      params,
    });
  }

  private async start(): Promise<void> {
    const { Codex } = this.codexOverride ?? (await loadCodex());
    // Drive the system codex binary (not the SDK's bundled-and-often-stale one)
    // when a path is configured, so current models work.
    // The inference child must not inherit tools or memories from the owner's
    // interactive Codex setup. Authentication still belongs to the SDK/CLI.
    const codexOptions: Record<string, unknown> = {
      config: {
        features: {
          apps: false,
          plugins: false,
          shell_tool: false,
          unified_exec: false,
          multi_agent: false,
          hooks: false,
          memories: false,
          image_generation: false,
        },
      },
    };
    codexOptions.codexPathOverride = join(
      dirname(createRequire(import.meta.url).resolve("@elizaos/plugin-cli-inference/package.json")),
      "codex-inference-exec.mjs"
    );
    codexOptions.env = {
      ...(this.subprocessEnv ??
        filterEnv(process.env, undefined, { CODEX_HOME: process.env.CODEX_HOME })),
      ELIZA_CODEX_INFERENCE_BIN: this.codexBinPath ?? "codex",
    };
    const codex = new Codex(codexOptions);
    this.workingDirectory = await mkdtemp(join(tmpdir(), "eliza-codex-inference-"));
    // This SDK run is inference-only; Eliza executes returned action decisions.
    const options: Record<string, unknown> = {
      model: this.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
      skipGitRepoCheck: true,
      workingDirectory: this.workingDirectory,
    };
    if (this.reasoningEffort) options.modelReasoningEffort = this.reasoningEffort;
    this.thread = codex.startThread(options);
    this.turns = 0;
    logger.debug(
      { src: "cli-inference:codex-sdk", model: this.model, mode: this.router ? "route" : "text" },
      "isolated Codex SDK thread started"
    );
  }

  /** Cancel active and already queued requests; later requests start a fresh lifecycle. */
  dispose(): void {
    this.lifecycle.abort(new DOMException("Codex inference session disposed", "AbortError"));
    this.lifecycle = new AbortController();
    this.releaseThread();
  }

  private releaseThread(): void {
    this.thread = null;
    this.turns = 0;
  }
}
