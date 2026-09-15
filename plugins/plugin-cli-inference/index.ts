import { createHash, randomUUID } from "node:crypto";
import type {
  GenerateTextParams,
  GenerateTextResult,
  IAgentRuntime,
  Plugin,
  ToolDefinition,
} from "@elizaos/core";
import {
  ElizaError,
  HANDLE_RESPONSE_TOOL_NAME,
  isTruthyEnvValue,
  logger,
  ModelType,
  parseBooleanValue,
} from "@elizaos/core";
import {
  type RotationSubprocessEnv,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
import { ClaudeCli } from "./src/claude-cli";
import {
  ClaudeSdkSession,
  type ClaudeSdkSessionConfig,
  type EnvelopeFieldSchemas,
  type SdkSessionMode,
} from "./src/claude-sdk-session";
import {
  appendTextDirective,
  buildCleanRoutingParams,
  buildEnvelopeBody,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
  STAGE1_ENVELOPE_SYSTEM_PROMPT,
} from "./src/clean-routing-planner";
import { CodexCli } from "./src/codex-cli-exec";
import { CodexSdkSession, type CodexSdkSessionConfig } from "./src/codex-sdk-session";
import { generateCodexToolResponse } from "./src/codex-tool-response";
import { flattenPrompt } from "./src/prompt-flatten";

/**
 * @elizaos/plugin-cli-inference — opt-in local CLI/SDK inference.
 *
 * Serves chat/planner inference through sanctioned local routes:
 *   - `claude --print`  (reads ~/.claude/.credentials.json itself), or
 *   - a warm Claude Agent SDK session (reads the Claude subscription creds itself), or
 *   - `codex exec` or the official Codex SDK (owns its stored sign-in).
 *
 * eliza never sees/forwards/logs the subscription token — the child env is
 * filtered (allowlist + secret blocklist) and the CLI loads its own creds.
 *
 * The whole models map is INERT unless `ELIZA_CHAT_VIA_CLI` is `claude`,
 * `claude-sdk`, `codex`, or `codex-sdk`. By default we register TEXT_LARGE / TEXT_MEGA /
 * RESPONSE_HANDLER only:
 *
 *   - RESPONSE_HANDLER is the whole point — it generates the user-facing reply,
 *     which is exactly what "chat on the sub" means. That is one CLI spawn per
 *     turn that actually answers (~3-4s).
 *   - TEXT_LARGE / TEXT_MEGA cover other large free-text generations (e.g. the
 *     post-turn evaluator) — also occasional, also tolerant of plain text.
 *   - The free-text backends register ACTION_PLANNER only in text-planner mode
 *     (`ELIZA_PLANNER_NATIVE_TOOLS=0`), where the planner emits an XML
 *     `<response><actions>` block the free-text CLI CAN produce. With native
 *     tools on (the default), the planner needs GBNF / native-tool /
 *     responseSchema enforcement the CLI cannot honor, so it stays on the
 *     grammar/tool-honoring provider (cerebras / zai / anthropic). Gating on
 *     `NATIVE_TOOLS=0` lets the SAFE route run STANDALONE (chat + planner +
 *     coding all on the subscription CLI) without ever hijacking a hybrid setup.
 *
 * Codex SDK also supports the native Eliza planner contract: structured output
 * returns tool decisions which Eliza validates and executes. It starts a fresh
 * thread per request, retaining no independent conversation history. The shared
 * ELIZA_CLI_CLAUDE_ALL_TIERS setting also enables its small text tiers.
 * Authentication and permitted usage remain subject to each vendor's terms;
 * this adapter is not a blanket authorization for hosted subscription reuse.
 */

/** Large-tier free-text model types this plugin registers (when enabled). */
const LARGE_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
];

/**
 * Codex SDK bridges the native tool contract; other backends require the
 * existing text-planner mode (ELIZA_PLANNER_NATIVE_TOOLS=0).
 */
const PLANNER_MODEL_TYPES: readonly string[] = [ModelType.ACTION_PLANNER];

// Codex rejects turn/start before inference when the flattened input exceeds
// this character boundary. Core's UTF-8 upper-bound admission uses one byte as
// one conservative token, so publishing the same number lets model-agnostic
// prompt assembly choose an explicit retrieval representation before spawn.
const CODEX_MAX_INPUT_CHARS = 1_048_576;

/**
 * High-frequency triage tiers — the should-respond gate, media-description, and
 * the action-callback voice rewrite. NOT registered by default (they'd spend a
 * subscription call on every inbound message, including ignored ones); serving
 * them on the cheap configured provider bounds cost. Registered only in ALL-TIERS
 * mode for operators who want a single-brain, no-fallthrough deployment — where
 * leaving triage on a weak provider mangles action-result rewrites into
 * "couldn't format" placeholder text.
 */
const SMALL_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_SMALL,
  ModelType.TEXT_NANO,
  ModelType.TEXT_MEDIUM,
];

/** True when the runtime is set for the XML text planner the free-text CLI can serve. */
function textPlannerEnabled(): boolean {
  return readEnv("ELIZA_PLANNER_NATIVE_TOOLS")?.trim() === "0";
}

/**
 * ALL-TIERS mode: also serve the high-frequency triage tiers on this route so
 * the ENTIRE text brain (not just the heavy tiers) runs on the one Claude/Codex
 * subscription — no cerebras/gemma fallthrough. Opt-in because triage volume is
 * high; the triage model defaults to the cheaper large-tier model, not the
 * planner tier, so the should-respond gate doesn't run on opus.
 */
function allTiersEnabled(): boolean {
  return isTruthyEnvValue(readEnv("ELIZA_CLI_CLAUDE_ALL_TIERS"));
}

/**
 * Stage-1 ENVELOPE mode (claude-sdk only): serve RESPONSE_HANDLER through the
 * native `handle_response` MCP tool so the routing envelope is structurally
 * captured instead of prompt-begged from free text. Default ON — it is the
 * lane's parity fix with every other Stage-1 backend; ELIZA_CLI_CLAUDE_STAGE1_ENVELOPE=0
 * reverts to the plain text session (core's tolerant parse chain).
 */
function stage1EnvelopeEnabled(): boolean {
  return parseBooleanValue(readEnv("ELIZA_CLI_CLAUDE_STAGE1_ENVELOPE")) ?? true;
}

/**
 * Locate core's Stage-1 HANDLE_RESPONSE tool on a RESPONSE_HANDLER call. Core
 * attaches it (with toolChoice "required") to exactly the Stage-1 ROUTING
 * call, and to no other — the post-tool evaluator and the failure-reply
 * helper reuse the same model type WITHOUT the tool, and they expect plain
 * JSON/text, so they must stay on the text session (observed live: routing
 * the evaluator through envelope mode posted the raw envelope JSON to the
 * channel as the reply). The returned tool's composed parameter schema is the
 * authoritative per-turn envelope field set (core's field REGISTRY lets any
 * plugin add fields, and the set varies by channel shape).
 */
export function findHandleResponseTool(
  tools: GenerateTextParams["tools"]
): ToolDefinition | undefined {
  return (Array.isArray(tools) ? tools : []).find(
    (tool) => tool.name?.trim().toUpperCase() === HANDLE_RESPONSE_TOOL_NAME
  );
}

/** Declared field schemas from the composed HANDLE_RESPONSE tool parameters. */
function envelopeFieldSchemas(tool: ToolDefinition): EnvelopeFieldSchemas {
  const properties =
    (tool.parameters as { properties?: Record<string, { type?: string }> })?.properties ?? {};
  const fields: EnvelopeFieldSchemas = {};
  for (const [name, schema] of Object.entries(properties)) {
    fields[name] = { type: typeof schema?.type === "string" ? schema.type : undefined };
  }
  return fields;
}

// "claude"      → cold `claude --print` per call (TOS-clean, but ~5-15s/call).
// "claude-sdk"  → WARM Claude Agent SDK session (TOS-clean + sanctioned + fast
//                 ~2s/turn after warm-up); the recommended Claude route.
// "codex"       → cold `codex exec` per call (TOS-clean ChatGPT OAuth).
// "codex-sdk"   → WARM Codex SDK thread (TOS-clean ChatGPT OAuth + fast); the
//                 codex peer of claude-sdk. ROUTE mode uses native outputSchema.
type CliBackend = "claude" | "claude-sdk" | "codex" | "codex-sdk";

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return value === undefined || value === null ? readEnv(key) : String(value);
}

/** Resolve the configured backend, or undefined when the plugin is inert. */
export function resolveCliBackend(source: { ELIZA_CHAT_VIA_CLI?: string }): CliBackend | undefined {
  const raw = source.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  if (raw === "claude" || raw === "claude-sdk" || raw === "codex" || raw === "codex-sdk") {
    return raw;
  }
  return undefined;
}

// Persistent warm Agent SDK sessions. The SDK freezes `systemPrompt` + tool
// config at query() start (no mid-session reset — proven live, research
// wf_3199bde6), so we key by (model, mode, systemPrompt-hash): each distinct
// system prompt and each mode (text vs native router) gets its own warm process.
// Keying by model ALONE would share one frozen-system opus session across
// RESPONSE_HANDLER/TEXT_LARGE/TEXT_MEGA, bleeding context between tiers/rooms and
// intermittently returning empty turns. Each cache entry also records its
// effective restart/turn budgets; a runtime configuration change replaces the
// session under the same logical key instead of reusing stale lifecycle state
// or fragmenting account-rotation affinity. Lives for the plugin's lifetime;
// torn down in dispose().
interface CachedClaudeSdkSession {
  session: ClaudeSdkSession;
  lifecycleFingerprint: string;
}

const sdkSessions = new Map<string, CachedClaudeSdkSession>();

/**
 * Upper bound on concurrently-cached warm sessions. Each session is a live
 * Claude Code process, so the cache must not grow without bound as distinct
 * system prompts appear. In practice only a handful of keys are hot (a few
 * tiers × the stable system-prompt prefix), but a long-lived agent whose system
 * prompt drifts could otherwise accumulate processes. When the cap is exceeded
 * the least-recently-used session is disposed (LRU: Map preserves insertion
 * order; a cache hit re-inserts to mark it most-recently-used).
 */
const MAX_SDK_SESSIONS = 8;
const DEFAULT_SDK_RESTART_AFTER_TURNS = 20;
const DEFAULT_CLAUDE_SDK_TURN_TIMEOUT_MS = 90_000;

type ClaudeSdkSessionFactory = (config: ClaudeSdkSessionConfig) => ClaudeSdkSession;

let createClaudeSdkSession: ClaudeSdkSessionFactory = (config) => new ClaudeSdkSession(config);

/** Replace the warm-session constructor for deterministic boundary tests. */
export function __setClaudeSdkSessionFactoryForTests(factory: ClaudeSdkSessionFactory): () => void {
  const previous = createClaudeSdkSession;
  createClaudeSdkSession = factory;
  return () => {
    createClaudeSdkSession = previous;
  };
}

type CodexSdkSessionFactory = (config: CodexSdkSessionConfig) => CodexSdkSession;

let createCodexSdkSession: CodexSdkSessionFactory = (config) => new CodexSdkSession(config);

/** Replace the Codex adapter constructor for deterministic boundary tests. */
export function __setCodexSdkSessionFactoryForTests(factory: CodexSdkSessionFactory): () => void {
  const previous = createCodexSdkSession;
  createCodexSdkSession = factory;
  return () => {
    createCodexSdkSession = previous;
  };
}

/** The Claude model for a given tier (planner/small can differ from large). */
function resolveSdkModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL");
  const planner = getSetting(runtime, "ELIZA_CLI_CLAUDE_PLANNER_MODEL");
  const fallback = (large || "claude-opus-4-8").trim();
  // The planner tier keeps its own (typically heavier) model.
  if (modelType === ModelType.ACTION_PLANNER) {
    return (planner || fallback).trim();
  }
  // ALL-TIERS triage: use the dedicated cheap model, else the large-tier model
  // (NOT the planner tier) so the high-frequency should-respond gate doesn't
  // run on opus.
  if (SMALL_TIER_MODEL_TYPES.includes(modelType)) {
    return (getSetting(runtime, "ELIZA_CLI_CLAUDE_SMALL_MODEL") || fallback).trim();
  }
  return fallback;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Lazily create + cache a warm SDK session for a (model, mode, systemPrompt).
 * A lifecycle-config change replaces the entry under that stable logical key.
 * "route" builds the native `route_action` MCP-tool session (the planner);
 * "envelope" builds the native `handle_response` session (Stage-1 routing);
 * "text" builds a plain text-generation session (reply/large tiers).
 */
function claudeSessionKey(
  model: string,
  systemPrompt: string,
  mode: SdkSessionMode,
  envelopeFields?: EnvelopeFieldSchemas
): string {
  // Envelope sessions also freeze their tool schema at query() start, so the
  // composed field set is part of the identity (direct vs group channel
  // shapes compose different sets; registry plugins add more).
  const fieldsPart = envelopeFields ? shortHash(Object.keys(envelopeFields).sort().join(",")) : "";
  return `${model}\u001f${mode}\u001f${shortHash(systemPrompt)}\u001f${fieldsPart}`;
}

function claudeLifecycleFingerprint(config: ClaudeSdkTimeoutConfiguration): string {
  return `${config.sdkRestartAfterTurns}\u001f${config.sdkTurnTimeoutMs}`;
}

/**
 * Reasoning effort for a Claude SDK session, forwarded to the SDK's `effort`
 * option (== `claude --effort`). The planner (route mode) reads
 * ELIZA_CLI_CLAUDE_PLANNER_EFFORT first so routing depth can be tuned
 * independently of reply depth; everything else falls back to ELIZA_CLI_CLAUDE_EFFORT, then
 * to the SDK default (high) when unset. Validation lives in the session
 * (normalizeEffort) so an unknown value is dropped, never forwarded.
 */
export function resolveSdkEffort(runtime: IAgentRuntime, mode: SdkSessionMode): string | undefined {
  const shared = getSetting(runtime, "ELIZA_CLI_CLAUDE_EFFORT");
  if (mode === "route") {
    return getSetting(runtime, "ELIZA_CLI_CLAUDE_PLANNER_EFFORT") ?? shared;
  }
  return shared;
}

/**
 * Evict + dispose a warm Claude SDK session by its cache key so the NEXT
 * `getSdkSession` for that key spins up a fresh process — which re-reads the
 * (rotated) `CLAUDE_CODE_OAUTH_TOKEN` / `~/.claude` credential. Used by account
 * rotation after a subscription limit. Best-effort: dispose is fire-and-forget.
 */
function evictSdkSession(key: string): void {
  const existing = sdkSessions.get(key);
  if (!existing) return;
  sdkSessions.delete(key);
  void existing.session.dispose();
}

function getSdkSession(
  runtime: IAgentRuntime,
  model: string,
  systemPrompt: string,
  mode: SdkSessionMode,
  timeoutConfiguration: ClaudeSdkTimeoutConfiguration,
  subprocessEnv?: RotationSubprocessEnv,
  envelopeFields?: EnvelopeFieldSchemas
): ClaudeSdkSession {
  const key = claudeSessionKey(model, systemPrompt, mode, envelopeFields);
  const lifecycleFingerprint = claudeLifecycleFingerprint(timeoutConfiguration);
  const existing = sdkSessions.get(key);
  if (existing?.lifecycleFingerprint === lifecycleFingerprint) {
    // Mark most-recently-used: delete + re-insert moves it to the Map's tail.
    sdkSessions.delete(key);
    sdkSessions.set(key, existing);
    return existing.session;
  }
  if (existing) {
    // Configuration is part of the cached value rather than the logical key so
    // account-rotation state keeps one stable affinity per session. Never retain
    // or resurrect a process created with stale lifecycle bounds.
    sdkSessions.delete(key);
    void existing.session.dispose();
  }
  const session = createClaudeSdkSession({
    model,
    systemPrompt,
    mode,
    envelopeFields,
    claudeExecutablePath: getSetting(runtime, "ELIZA_CLI_CLAUDE_BIN"),
    restartAfterTurns: timeoutConfiguration.sdkRestartAfterTurns,
    turnTimeoutMs: timeoutConfiguration.sdkTurnTimeoutMs,
    effort: resolveSdkEffort(runtime, mode),
    subprocessEnv,
  });
  sdkSessions.set(key, { session, lifecycleFingerprint });
  // Evict least-recently-used past the cap (each session is a live process).
  // dispose() is best-effort fire-and-forget — the new session is already
  // cached and returned synchronously.
  while (sdkSessions.size > MAX_SDK_SESSIONS) {
    const lruKey = sdkSessions.keys().next().value as string | undefined;
    if (lruKey === undefined) break;
    const lru = sdkSessions.get(lruKey);
    sdkSessions.delete(lruKey);
    void lru?.session.dispose();
  }
  return session;
}

/** Tear down all warm SDK sessions (plugin dispose). */
export async function disposeSdkSessions(): Promise<void> {
  const all = [...sdkSessions.values()].map(({ session }) => session);
  sdkSessions.clear();
  await Promise.all(all.map((s) => s.dispose()));
  const codex = [...codexSdkSessions.values()].map(({ session }) => session);
  codexSdkSessions.clear();
  for (const s of codex) s.dispose();
}

// Cache adapter configuration, not conversation history. Codex starts a fresh
// thread for each request; runtime identity isolates configuration and account affinity.
interface CachedCodexSdkSession {
  session: CodexSdkSession;
  lifecycleFingerprint: string;
}

const codexSdkSessions = new Map<string, CachedCodexSdkSession>();
const codexRuntimeIds = new WeakMap<IAgentRuntime, string>();

/** The codex model for a given tier (planner/small can differ from large). */
function resolveCodexModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CODEX_MODEL");
  const small = getSetting(runtime, "ELIZA_CLI_CODEX_PLANNER_MODEL");
  const isSmallTier = modelType === ModelType.ACTION_PLANNER || modelType === ModelType.TEXT_SMALL;
  return ((isSmallTier ? small : large) || large || "gpt-5.5").trim();
}

function codexSessionKey(runtime: IAgentRuntime, model: string, router: boolean): string {
  let id = codexRuntimeIds.get(runtime);
  if (!id) {
    id = randomUUID();
    codexRuntimeIds.set(runtime, id);
  }
  return `${id}\u001f${model}\u001f${router ? "route" : "text"}`;
}

function codexLifecycleFingerprint(config: CodexSdkTimeoutConfiguration): string {
  return String(config.sdkRestartAfterTurns);
}

/**
 * Evict + dispose a Codex SDK adapter by its cache key so the next
 * `getCodexSdkSession` re-starts it — re-reading the (rotated) per-account
 * `CODEX_HOME`. Used by account rotation after a subscription limit.
 */
function evictCodexSdkSession(key: string): void {
  const existing = codexSdkSessions.get(key);
  if (!existing) return;
  codexSdkSessions.delete(key);
  existing.session.dispose();
}

/** Cache adapter configuration per runtime; request threads are never reused. */
function getCodexSdkSession(
  runtime: IAgentRuntime,
  model: string,
  router: boolean,
  timeoutConfiguration: CodexSdkTimeoutConfiguration,
  subprocessEnv?: RotationSubprocessEnv
): CodexSdkSession {
  const key = codexSessionKey(runtime, model, router);
  const lifecycleFingerprint = JSON.stringify([
    codexLifecycleFingerprint(timeoutConfiguration),
    getSetting(runtime, "ELIZA_CLI_CODEX_REASONING_EFFORT"),
    getSetting(runtime, "ELIZA_CLI_CODEX_BIN"),
  ]);
  const existing = codexSdkSessions.get(key);
  if (existing?.lifecycleFingerprint === lifecycleFingerprint) {
    return existing.session;
  }
  if (existing) {
    codexSdkSessions.delete(key);
    existing.session.dispose();
  }
  const session = createCodexSdkSession({
    model,
    router,
    reasoningEffort: getSetting(runtime, "ELIZA_CLI_CODEX_REASONING_EFFORT"),
    codexBinPath: getSetting(runtime, "ELIZA_CLI_CODEX_BIN"),
    restartAfterTurns: timeoutConfiguration.sdkRestartAfterTurns,
    subprocessEnv,
  });
  codexSdkSessions.set(key, { session, lifecycleFingerprint });
  return session;
}

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

/** Parse a strictly positive safe-integer lifecycle setting. Exported for tests. */
export function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // `Number.parseInt` stops at the first non-digit, so "300junk" parsed to 300
  // and was taken as a deliberate setting. Require the whole trimmed value to
  // be decimal; the sign is kept because `parseInt` accepted it, and the `> 0`
  // check below stays the range authority.
  const trimmed = value.trim();
  const n = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Parse a positive delay that Node timers can represent without clamping. */
function parseTimerTimeout(value: string | undefined): number | undefined {
  const parsed = parseTimeout(value);
  return parsed !== undefined && parsed <= MAX_NODE_TIMER_DELAY_MS ? parsed : undefined;
}

/** Turn-timeout parse (#16553): positive values must fit the Node timer range,
 *  while an explicit `"0"` passes through as the documented operator opt-out
 *  to an unbounded turn. The parser returns undefined for unset/invalid input;
 *  the backend-aware resolver below distinguishes those states and rejects a
 *  present-invalid value before session lookup. Exported for tests. */
export function parseTurnTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Same prefix-parse hole, and it matters more here: `0` is the documented
  // opt-out to an unbounded turn, so "0junk" and "0.5" both truncated to 0 and
  // silently REMOVED the turn timeout rather than falling back to the bounded
  // default. An explicit "0" is still honoured.
  if (value === "0") return 0;
  return parseTimerTimeout(value);
}

type TimeoutSettingKey =
  | "ELIZA_CLI_TIMEOUT_MS"
  | "ELIZA_CLI_SDK_RESTART_AFTER_TURNS"
  | "ELIZA_CLI_SDK_TURN_TIMEOUT_MS";

interface ColdTimeoutConfiguration {
  cliTimeoutMs?: number;
}

interface ClaudeSdkTimeoutConfiguration {
  sdkRestartAfterTurns: number;
  sdkTurnTimeoutMs: number;
}

interface CodexSdkTimeoutConfiguration {
  sdkRestartAfterTurns: number;
}

const MAX_RENDERED_INVALID_SETTING_LENGTH = 96;

function renderInvalidSettingValue(value: string | boolean | number): {
  rendered: string;
  valueType: string;
} {
  const serialized = typeof value === "string" ? JSON.stringify(value) : String(value);
  return {
    rendered:
      serialized.length <= MAX_RENDERED_INVALID_SETTING_LENGTH
        ? serialized
        : `${serialized.slice(0, MAX_RENDERED_INVALID_SETTING_LENGTH - 3)}...`,
    valueType: typeof value,
  };
}

/** Typed failure for an explicitly present but invalid CLI inference setting. */
export class CliInferenceConfigurationError extends ElizaError {
  override readonly name = "CliInferenceConfigurationError";
  readonly setting: TimeoutSettingKey;

  constructor(setting: TimeoutSettingKey, value: string | boolean | number, expected: string) {
    const { rendered, valueType } = renderInvalidSettingValue(value);
    super(`[cli-inference] Invalid ${setting}: expected ${expected}; received ${rendered}`, {
      code: "CLI_INFERENCE_INVALID_CONFIGURATION",
      context: { setting, valueType, valuePreview: rendered, expected },
      severity: "fatal",
    });
    this.setting = setting;
  }
}

function readRawSetting(
  runtime: IAgentRuntime,
  key: TimeoutSettingKey
): string | boolean | number | undefined {
  const runtimeValue = runtime.getSetting(key);
  return runtimeValue === undefined || runtimeValue === null ? readEnv(key) : runtimeValue;
}

function resolveNumericSetting(
  runtime: IAgentRuntime,
  key: TimeoutSettingKey,
  parser: (value: string | undefined) => number | undefined,
  expected: string
): number | undefined {
  const raw = readRawSetting(runtime, key);
  if (raw === undefined) return undefined;
  const parsed = Object.is(raw, -0) ? undefined : parser(String(raw));
  if (parsed === undefined) {
    throw new CliInferenceConfigurationError(key, raw, expected);
  }
  return parsed;
}

function resolveColdTimeoutConfiguration(runtime: IAgentRuntime): ColdTimeoutConfiguration {
  return {
    cliTimeoutMs: resolveNumericSetting(
      runtime,
      "ELIZA_CLI_TIMEOUT_MS",
      parseTimerTimeout,
      `a positive integer no greater than ${MAX_NODE_TIMER_DELAY_MS}`
    ),
  };
}

/** Resolve every timeout consumed by Claude SDK before session lookup/creation. */
function resolveClaudeSdkTimeoutConfiguration(
  runtime: IAgentRuntime
): ClaudeSdkTimeoutConfiguration {
  const cliTimeoutMs = resolveColdTimeoutConfiguration(runtime).cliTimeoutMs;
  const sdkRestartAfterTurns =
    resolveNumericSetting(
      runtime,
      "ELIZA_CLI_SDK_RESTART_AFTER_TURNS",
      parseTimeout,
      "a positive safe integer"
    ) ?? DEFAULT_SDK_RESTART_AFTER_TURNS;
  const explicitSdkTurnTimeoutMs = resolveNumericSetting(
    runtime,
    "ELIZA_CLI_SDK_TURN_TIMEOUT_MS",
    parseTurnTimeout,
    `the exact literal "0" opt-out or a positive integer no greater than ${MAX_NODE_TIMER_DELAY_MS}`
  );
  return {
    sdkRestartAfterTurns,
    sdkTurnTimeoutMs:
      explicitSdkTurnTimeoutMs ?? cliTimeoutMs ?? DEFAULT_CLAUDE_SDK_TURN_TIMEOUT_MS,
  };
}

/** Parse the legacy Codex restart setting for configuration compatibility. */
function resolveCodexSdkTimeoutConfiguration(runtime: IAgentRuntime): CodexSdkTimeoutConfiguration {
  return {
    sdkRestartAfterTurns:
      resolveNumericSetting(
        runtime,
        "ELIZA_CLI_SDK_RESTART_AFTER_TURNS",
        parseTimeout,
        "a positive safe integer"
      ) ?? DEFAULT_SDK_RESTART_AFTER_TURNS,
  };
}

// One binary setting covers both warm and cold backends so container images can
// pin executables outside the launcher allowlist. Blank settings retain the
// allowlisted PATH lookup used by unmanaged installations.
function resolveBinaryPin(runtime: IAgentRuntime, key: string): string | undefined {
  const value = getSetting(runtime, key)?.trim();
  return value ? value : undefined;
}

function buildClaude(
  runtime: IAgentRuntime,
  timeoutConfiguration: ColdTimeoutConfiguration
): ClaudeCli {
  return new ClaudeCli({
    model: getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL"),
    timeoutMs: timeoutConfiguration.cliTimeoutMs,
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CLAUDE_BIN"),
  });
}

function buildCodex(
  runtime: IAgentRuntime,
  timeoutConfiguration: ColdTimeoutConfiguration
): CodexCli {
  return new CodexCli({
    model: getSetting(runtime, "ELIZA_CLI_CODEX_MODEL"),
    timeoutMs: timeoutConfiguration.cliTimeoutMs,
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CODEX_BIN"),
  });
}

async function generateViaCli(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: string
): Promise<string | GenerateTextResult> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (!backend) {
    // Should be unreachable: the handlers are only registered when a backend is
    // set. Throw so useModel/AccountPool treat it as a provider failure rather
    // than silently returning empty.
    throw new Error(
      "[cli-inference] ELIZA_CHAT_VIA_CLI is not set to claude|claude-sdk|codex|codex-sdk"
    );
  }
  const generateParams = {
    system: params.system,
    prompt: params.prompt,
    messages: params.messages,
  };
  logger.debug(`[cli-inference] ${modelType} via ${backend}`);
  const handleResponseTool =
    backend === "claude-sdk" && modelType === ModelType.RESPONSE_HANDLER && stage1EnvelopeEnabled()
      ? findHandleResponseTool(params.tools)
      : undefined;
  if (backend === "claude-sdk" && handleResponseTool) {
    const timeoutConfiguration = resolveClaudeSdkTimeoutConfiguration(runtime);
    // Stage-1 routing envelope via the native `handle_response` MCP tool.
    // Every other Stage-1 lane structurally forces the envelope (anthropic
    // native tool_use, cloud tool_choice:required, local GBNF); serving it as
    // free text let the model answer live-info asks in prose, which core's
    // tolerance accepted as a finished "simple reply" — no planner, no fetch
    // (observed live: 49 of 54 live-info turns prose-shaped). The captured
    // envelope returns as a JSON string core parses identically to a native
    // tool call; off-contract prose falls back to the tolerant text chain.
    const model = resolveSdkModel(runtime, modelType);
    const fields = envelopeFieldSchemas(handleResponseTool);
    const { system, body } = flattenPrompt(generateParams);
    const envelopeBody = buildEnvelopeBody(system, body);
    const key = claudeSessionKey(model, STAGE1_ENVELOPE_SYSTEM_PROMPT, "envelope", fields);
    return withAccountRotation(
      (env) =>
        getSdkSession(
          runtime,
          model,
          STAGE1_ENVELOPE_SYSTEM_PROMPT,
          "envelope",
          timeoutConfiguration,
          env,
          fields
        ).send(envelopeBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictSdkSession(key),
      }
    );
  }
  if (backend === "claude-sdk") {
    const timeoutConfiguration = resolveClaudeSdkTimeoutConfiguration(runtime);
    // Warm, persistent Agent SDK session. The SDK freezes `systemPrompt` at start,
    // so we flatten system+messages here and hand the session a STABLE system
    // (so all turns of a tier share one warm process) plus a self-contained body.
    const model = resolveSdkModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    // Reframe the agentic SDK model as a pure completion engine (system) AND close
    // the body with a directive that cancels any stale "call a tool" instruction,
    // so it synthesizes the final reply from already-executed tool results instead
    // of narrating intent ("I'll fetch it…"). Both are needed (proven live: 4/4 vs
    // 2/4). Keying by the framed system keeps one warm process per tier.
    const framedSystem = frameTextSystemPrompt(system);
    const framedBody = appendTextDirective(body);
    const key = claudeSessionKey(model, framedSystem, "text");
    // Pool-first auth: the FIRST warm session already auths as a healthy pooled
    // Claude account when one exists (ambient ~/.claude is the fallback). On a
    // subscription limit, rotate to the next healthy pooled account (evicting
    // the warm session so it re-auths as the new account), then retry; fall
    // through to provider failover only when the pool is exhausted.
    return withAccountRotation(
      (env) =>
        getSdkSession(runtime, model, framedSystem, "text", timeoutConfiguration, env).send(
          framedBody
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictSdkSession(key),
      }
    );
  }
  if (backend === "codex-sdk") {
    const timeoutConfiguration = resolveCodexSdkTimeoutConfiguration(runtime);
    // Warm Codex SDK thread. codex-sdk folds the system into the body, so frame
    // the body the same way (the SDK model is agentic too) and run TEXT mode.
    const model = resolveCodexModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    const framedBody = appendTextDirective(`${frameTextSystemPrompt(system)}\n\n${body}`);
    const key = codexSessionKey(runtime, model, false);
    return withAccountRotation<string | GenerateTextResult>(
      (env) =>
        params.tools?.length
          ? generateCodexToolResponse(
              getCodexSdkSession(runtime, model, false, timeoutConfiguration, env),
              params
            )
          : getCodexSdkSession(runtime, model, false, timeoutConfiguration, env).generate(
              framedBody,
              undefined,
              params.signal
            ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictCodexSdkSession(key),
      }
    );
  }
  const timeoutConfiguration = resolveColdTimeoutConfiguration(runtime);
  const cli =
    backend === "claude"
      ? buildClaude(runtime, timeoutConfiguration)
      : buildCodex(runtime, timeoutConfiguration);
  return cli.generate(generateParams);
}

/**
 * ACTION_PLANNER handler for the SAFE/CLI route.
 *
 * Two implementations, picked by backend:
 *
 *  - **claude-sdk (native router):** the model is given ONE in-process MCP tool
 *    (`route_action`) and emits a real `tool_use` the warm session captures as
 *    `{action, params}`. This matches the stealth/native path's full
 *    functionality (live-info → WEB_FETCH, sub-agents) with no free-text JSON
 *    parsing and no required-tool retry loop. The per-turn action menu +
 *    transcript + persona ride in the BODY (system stays the constant
 *    `ROUTER_SYSTEM_PROMPT` so one warm process serves every planner turn).
 *
 *  - **claude / codex CLI:** the free-text CLI cannot honor native tools, so we
 *    rebuild the call into the proven CLEAN text-routing form (pick ONE action,
 *    emit compact `{action, params}` JSON) via `buildCleanRoutingParams`.
 *
 * Both return the bare `{action, params}` shape the loop's text-mode parser
 * (`parseJsonPlannerOutput` → `normalizeBarePlannerAction`) accepts directly, so
 * no core change is needed.
 */
async function planViaCli(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | GenerateTextResult> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (backend === "claude-sdk") {
    const timeoutConfiguration = resolveClaudeSdkTimeoutConfiguration(runtime);
    const model = resolveSdkModel(runtime, ModelType.ACTION_PLANNER);
    const routerBody = buildRouterBody(params);
    const key = claudeSessionKey(model, ROUTER_SYSTEM_PROMPT, "route");
    return withAccountRotation(
      (env) =>
        getSdkSession(
          runtime,
          model,
          ROUTER_SYSTEM_PROMPT,
          "route",
          timeoutConfiguration,
          env
        ).send(routerBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictSdkSession(key),
      }
    );
  }
  if (backend === "codex-sdk") {
    if (params.tools?.length) return generateViaCli(runtime, params, ModelType.ACTION_PLANNER);
    const timeoutConfiguration = resolveCodexSdkTimeoutConfiguration(runtime);
    // codex routes via NATIVE structured output (outputSchema) for a reliable
    // {action, params} shape. The clean-routing prompt (menu + transcript +
    // persona) is folded into the body (codex-sdk has no thread-level system
    // prompt); the session applies the schema + parses the result.
    const model = resolveCodexModel(runtime, ModelType.ACTION_PLANNER);
    const clean = buildCleanRoutingParams(params);
    const routeBody = `${clean.system ?? ""}\n\n${clean.prompt ?? ""}`;
    const key = codexSessionKey(runtime, model, true);
    return withAccountRotation(
      (env) =>
        getCodexSdkSession(runtime, model, true, timeoutConfiguration, env).route(
          routeBody,
          params.signal
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        onRotate: () => evictCodexSdkSession(key),
      }
    );
  }
  return generateViaCli(runtime, buildCleanRoutingParams(params), ModelType.ACTION_PLANNER);
}

/**
 * Build the models map. When no backend is configured the map is EMPTY so the
 * plugin registers nothing and the cheap configured provider keeps serving
 * every tier.
 */
export function buildModels(
  source: { ELIZA_CHAT_VIA_CLI?: string } = { ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") }
): Plugin["models"] {
  if (!resolveCliBackend(source)) return {};
  const models: Record<
    string,
    (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<string | GenerateTextResult>
  > = {};
  const textTiers = allTiersEnabled()
    ? [...LARGE_TIER_MODEL_TYPES, ...SMALL_TIER_MODEL_TYPES]
    : LARGE_TIER_MODEL_TYPES;
  for (const modelType of textTiers) {
    models[modelType] = (runtime, params) => generateViaCli(runtime, params, modelType);
  }
  if (textPlannerEnabled() || resolveCliBackend(source) === "codex-sdk") {
    for (const modelType of PLANNER_MODEL_TYPES) {
      models[modelType] = (runtime, params) => planViaCli(runtime, params);
    }
  }
  return models as Plugin["models"];
}

/**
 * Declare the same runtime-setting precedence used by the handlers. Metadata is
 * intentionally serializable and handler-free, but it must not snapshot host
 * environment values: character settings can differ for every agent sharing a
 * process and are resolved by RUNTIME_MODEL_CONTEXT at provider execution time.
 */
export function buildModelMetadata(
  source: { ELIZA_CHAT_VIA_CLI?: string } = {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI"),
  }
): Plugin["modelMetadata"] {
  const backend = resolveCliBackend(source);
  if (!backend) return undefined;
  const isCodex = backend === "codex" || backend === "codex-sdk";
  const isWarm = backend === "claude-sdk" || backend === "codex-sdk";
  const largeSetting = isCodex ? "ELIZA_CLI_CODEX_MODEL" : "ELIZA_CLI_CLAUDE_MODEL";
  const plannerSetting = isCodex
    ? "ELIZA_CLI_CODEX_PLANNER_MODEL"
    : "ELIZA_CLI_CLAUDE_PLANNER_MODEL";
  const defaultModel = isCodex ? "gpt-5.5" : "claude-opus-4-8";
  const metadata: NonNullable<Plugin["modelMetadata"]> = {};
  const declaration = (settings: string[]) => ({
    displayModelSettings: settings,
    displayModelDefault: defaultModel,
    ...(isCodex ? { contextWindowTokens: CODEX_MAX_INPUT_CHARS } : {}),
  });

  for (const modelType of LARGE_TIER_MODEL_TYPES) {
    metadata[modelType] = declaration([largeSetting]);
  }
  if (allTiersEnabled()) {
    for (const modelType of SMALL_TIER_MODEL_TYPES) {
      const settings =
        backend === "claude-sdk"
          ? ["ELIZA_CLI_CLAUDE_SMALL_MODEL", largeSetting]
          : backend === "codex-sdk" && modelType === ModelType.TEXT_SMALL
            ? [plannerSetting, largeSetting]
            : [largeSetting];
      metadata[modelType] = declaration(settings);
    }
  }
  if (textPlannerEnabled() || backend === "codex-sdk") {
    for (const modelType of PLANNER_MODEL_TYPES) {
      metadata[modelType] = declaration(isWarm ? [plannerSetting, largeSetting] : [largeSetting]);
    }
  }
  return metadata;
}

export const cliInferencePlugin: Plugin = {
  name: "cli-inference",
  description:
    "Opt-in local CLI/SDK inference via claude, claude-sdk, codex, or codex-sdk. Each backend manages its own authentication; Codex SDK bridges Eliza tool decisions using isolated requests.",
  modelMetadata: buildModelMetadata(),
  // High priority so that, when ELIZA_CHAT_VIA_CLI is set, this plugin
  // deterministically wins the tiers it registers (TEXT_LARGE / TEXT_MEGA /
  // RESPONSE_HANDLER) over default-priority (0) model providers like
  // plugin-anthropic that would otherwise tie and resolve non-deterministically.
  priority: 100,
  config: {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") ?? null,
    ELIZA_CLI_CLAUDE_MODEL: readEnv("ELIZA_CLI_CLAUDE_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_PLANNER_MODEL: readEnv("ELIZA_CLI_CLAUDE_PLANNER_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_BIN: readEnv("ELIZA_CLI_CLAUDE_BIN") ?? null,
    ELIZA_CLI_SDK_RESTART_AFTER_TURNS: readEnv("ELIZA_CLI_SDK_RESTART_AFTER_TURNS") ?? null,
    ELIZA_CLI_SDK_TURN_TIMEOUT_MS: readEnv("ELIZA_CLI_SDK_TURN_TIMEOUT_MS") ?? null,
    ELIZA_CLI_CODEX_MODEL: readEnv("ELIZA_CLI_CODEX_MODEL") ?? null,
    ELIZA_CLI_CODEX_BIN: readEnv("ELIZA_CLI_CODEX_BIN") ?? null,
    ELIZA_CLI_TIMEOUT_MS: readEnv("ELIZA_CLI_TIMEOUT_MS") ?? null,
    ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION: readEnv("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION") ?? null,
  },
  async init(): Promise<void> {
    const backend = resolveCliBackend({ ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") });
    if (!backend) {
      logger.info("[cli-inference] ELIZA_CHAT_VIA_CLI unset — plugin inert (no models registered)");
      return;
    }
    logger.info(
      backend === "claude-sdk"
        ? "[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=claude-sdk — WARM Agent SDK sessions (TOS-clean, sanctioned, fast)"
        : `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=${backend} — large-tier handlers spawn the ${backend} CLI`
    );
    if (textPlannerEnabled()) {
      logger.info(
        "[cli-inference] text-planner mode (ELIZA_PLANNER_NATIVE_TOOLS=0) — ACTION_PLANNER also served via this route (standalone SAFE stack)"
      );
    }
    if ((backend === "claude-sdk" || backend === "codex-sdk") && rotationEnabled(readEnv)) {
      logger.info(
        "[cli-inference] multi-account rotation ON — a subscription limit rotates to the next healthy pooled account before provider failover (opt out: ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0)"
      );
    }
  },
  async dispose(): Promise<void> {
    await disposeSdkSessions();
  },
  models: buildModels(),
};

export {
  buildRotatedSubprocessEnv,
  isSubscriptionLimitError,
  rotationAgentTypeForBackend,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
export { ClaudeCli } from "./src/claude-cli";
export { ClaudeSdkSession, type SdkSessionMode } from "./src/claude-sdk-session";
export {
  appendTextDirective,
  buildCleanRoutingBody,
  buildCleanRoutingParams,
  buildCleanRoutingSystemPrompt,
  buildEnvelopeBody,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
  STAGE1_ENVELOPE_SYSTEM_PROMPT,
  TEXT_COMPLETION_DIRECTIVE,
  TEXT_COMPLETION_FRAMING,
} from "./src/clean-routing-planner";
export { CodexCli, parseCodexJsonl } from "./src/codex-cli-exec";
export { CodexSdkSession } from "./src/codex-sdk-session";
export { flattenPrompt } from "./src/prompt-flatten";
export { LARGE_TIER_MODEL_TYPES, PLANNER_MODEL_TYPES, textPlannerEnabled };

export default cliInferencePlugin;
