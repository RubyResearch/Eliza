/**
 * Chat-brain multi-account rotation for the SAFE/CLI inference route (issue
 * #11180 Gap A).
 *
 * The problem: without this module `plugin-cli-inference` authenticates the warm
 * claude-sdk / codex-sdk session from the machine's single ambient credential
 * (`~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN`, or `~/.codex` / `CODEX_HOME`). Two
 * consequences: (a) an app-connected subscription stored in the account pool is
 * never used for chat — on a machine with no ambient CLI login the route fails
 * outright even though a healthy pooled account exists; (b) when the active
 * account hits its hourly/monthly subscription limit, the SDK ends the turn by
 * streaming the limit envelope, the session handlers throw (per the
 * throw-to-failover contract), and `useModel` skips straight to the next
 * provider TIER (cloud / API key) — it never asks the pool for the next healthy
 * *account* of the SAME provider first. A user with two Claude Max accounts
 * still stalls the brain when account #1 limits, exactly like a solo account.
 *
 * The fix (this module): consume the coding-agent selector bridge
 * (`CODING_AGENT_SELECTOR_BRIDGE_SYMBOL`, single-sourced in `@elizaos/core`) —
 * the SAME bridge coding sub-agents rotate through, which maps backend →
 * provider, pool-selects the next healthy account, and MATERIALIZES the exact
 * env the subprocess needs: `CLAUDE_CODE_OAUTH_TOKEN` for claude, a per-account
 * `CODEX_HOME` for codex) at TWO points:
 *
 *  1. **Pool-first initial auth.** BEFORE the session's first attempt, select a
 *     healthy pooled account and hand its subprocess-only env to the warm
 *     session. Without this, an app-connected subscription sits stored-but-
 *     unused while the SDK auths from the machine's ambient credential — and on
 *     a machine with NO ambient login the route fails outright even though a
 *     pooled account is present. Ambient stays the FALLBACK: an empty pool
 *     (select → null) or a failed selection preserves the pre-pool behavior
 *     (attempt with no env).
 *  2. **Rotation on an account-scoped failure.** We mark a limited account or
 *     flag an authentication failure for reauthentication, select the next
 *     healthy one, build its subprocess-only env,
 *     dispose the warm session so it re-auths as the new account on its next
 *     start, and retry the turn transparently. Only when the pool returns null
 *     (all accounts limited / no pool / single account) do we rethrow so the
 *     caller's existing provider-failover chain runs. Rotation (account A →
 *     account B, same provider) therefore composes with — and runs BEFORE —
 *     failover (claude → cloud → api).
 *
 * Design notes:
 *  - **Bridge over `globalThis`, not an app-core import.** The pool + credential
 *    store live in `@elizaos/app-core`; this plugin depends only on
 *    `@elizaos/core`. Like `plugin-agent-orchestrator/coding-account-selection.ts`
 *    we read the narrow contract off a `Symbol.for(...)` key. When no pool is
 *    configured the bridge is absent and this module is a pass-through no-op
 *    (single-account behavior is byte-for-byte unchanged).
 *  - **TOS invariant preserved.** The subscription token materialized by the
 *    bridge only ever lands in the first-party SDK subprocess env (`query
 *    options.env` / `new Codex({ env })`), never the runtime's shared
 *    `process.env`, never logs, never a third-party API. `CODEX_HOME` is a
 *    directory path, not a secret.
 *  - **Rotation is opt-out-able**, gated like the rest of the plugin's env
 *    conventions: `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION` (default ON when a pool
 *    is present; set `0`/`false`/`off` to disable and go straight to failover).
 *  - **Only rate-limit and selected-account auth errors rotate.** A 401/403 can
 *    identify a bad pooled credential only when this module selected it. An
 *    ambient auth failure, 400, timeout, or empty completion rethrows.
 *
 * @module plugin-cli-inference/account-rotation
 */

import {
  type CodingAccountStrategy,
  type CodingAgentSelectorBridge,
  getCodingAgentSelectorBridge,
  logger,
} from "@elizaos/core";

export type RotationAgentType = "claude" | "codex";
export type RotationSubprocessEnv = Record<string, string | undefined>;

interface RotationState {
  selection: RotationAccountSelection;
  subprocessEnv: RotationSubprocessEnv;
}

const rotationStateBySession = new Map<string, RotationState>();

/** A selected account plus the env the first-party subprocess needs to auth as it. */
export interface RotationAccountSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key" | "coding-plan-key";
  strategy: string;
  /** Secrets / paths injected into the SDK subprocess env, never persisted or logged. */
  envPatch: Record<string, string>;
}

/**
 * Read the installed bridge, or null when no pool has been constructed. The
 * bridge symbol + contract are single-sourced in `@elizaos/core`.
 */
export function getCodingAccountBridge(): CodingAgentSelectorBridge | null {
  return getCodingAgentSelectorBridge();
}

/**
 * The backends whose warm SDK sessions authenticate per pooled account. The
 * cold `claude --print` / `codex exec` CLIs read the machine's single on-disk
 * login and are out of scope for in-runtime rotation (they'd need the CLI shim,
 * issue #11180 Gap B), so ONLY the SDK backends map to a rotation agent type.
 */
const BACKEND_TO_AGENT_TYPE: Readonly<Record<string, RotationAgentType>> = {
  "claude-sdk": "claude",
  "codex-sdk": "codex",
};

/** Map an inference backend to the coding-agent pool type, or null when unrotatable. */
export function rotationAgentTypeForBackend(backend: string): RotationAgentType | null {
  return BACKEND_TO_AGENT_TYPE[backend] ?? null;
}

/** Default cool-off applied to an account that hit a subscription limit (15 min). */
export const ROTATION_RATE_LIMIT_COOLOFF_MS = 15 * 60_000;

/**
 * True when this error is the subscription-limit / rate-limit class that should
 * trigger account rotation. Deliberately CONSERVATIVE: the session handlers
 * already narrow their throws (they only surface the limit envelope as a
 * "subscription rate limit reached: …" message, or a `ProviderApiError` whose
 * message carries the upstream status), so we anchor on those same signals plus
 * a 429/529/quota vocabulary. A false positive burns a healthy account out of
 * the pool for 15 min, so anything ambiguous (400, empty completion, plain auth
 * failure, generic timeout) does NOT rotate — it rethrows to failover.
 */
export function isSubscriptionLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === "number" && (statusCode === 429 || statusCode === 529)) {
    return true;
  }
  const t = message.toLowerCase();
  return (
    // The claude-sdk session's own limit throw ("subscription rate limit reached: …").
    t.includes("subscription rate limit reached") ||
    // Explicit status the SDK envelope carries.
    /\b(429|529)\b/.test(t) ||
    // Provider limit / quota vocabulary. Kept tight: "rate limit" + "usage limit
    // reached" + "quota exceeded/exhausted" + "too many requests" are the
    // unambiguous provider signals (matches the orchestrator's classifier).
    /rate[\s-]?limit(?:ed|ing)?/.test(t) ||
    t.includes("usage limit reached") ||
    /quota (?:exceeded|exhausted)/.test(t) ||
    // OpenAI's CLASSIC quota envelope inverts the word order ("You exceeded
    // your current quota, please check your plan and billing details") and
    // carries the machine code `insufficient_quota` — none of which contain
    // "quota exceeded" or a literal 429. Anchor on the provider's exact
    // envelope phrases / error code, NOT generic quota/billing prose, so a
    // model merely talking about quotas still does not rotate.
    t.includes("exceeded your current quota") ||
    t.includes("check your plan and billing details") ||
    t.includes("insufficient_quota") ||
    t.includes("too many requests")
  );
}

/** True only for an upstream authentication status, never message prose. */
export function isProviderAuthenticationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const statusCode = "statusCode" in err ? err.statusCode : undefined;
  return statusCode === 401 || statusCode === 403;
}

/** Resolve whether rotation is enabled (default ON; opt-out via env/setting). */
export function rotationEnabled(getValue: (key: string) => string | undefined): boolean {
  const raw = getValue("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION")?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/**
 * Ambient auth vars that would compete with a rotated account's env patch.
 * Both SDKs replace the subprocess environment when `env` is provided, so the
 * merge spreads `process.env` (PATH/HOME survive) but drops these first;
 * otherwise an operator's own ambient key/home could outrank the selected pool
 * account.
 */
const COMPETING_AUTH_VARS: Readonly<Record<RotationAgentType, readonly string[]>> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
};

/**
 * Build the SDK subprocess env for a rotated account. Pure: it never mutates
 * `process.env`, so pooled credentials cannot leak into the parent process or
 * other in-process consumers.
 */
export function buildRotatedSubprocessEnv(
  agentType: RotationAgentType,
  envPatch: Record<string, string>
): RotationSubprocessEnv {
  const env: RotationSubprocessEnv = typeof process === "undefined" ? {} : { ...process.env };
  for (const key of COMPETING_AUTH_VARS[agentType]) {
    delete env[key];
  }
  return { ...env, ...envPatch };
}

/** A description safe to log about a selection (label + provider, NEVER the token). */
function safeAccountLabel(sel: RotationAccountSelection): string {
  return `${sel.providerId}/${sel.label}`;
}

export interface RotationContext {
  /** The configured inference backend (claude-sdk / codex-sdk / claude / codex). */
  backend: string;
  /** Read a runtime setting/env value (rotation gate). */
  getValue: (key: string) => string | undefined;
  /** Stable key so pool session-affinity ties a conversation to one account. */
  sessionKey?: string;
  /**
   * Called whenever the selected account changes — after the pool-first initial
   * selection and after each successful rotation, BEFORE the (re)try — so the
   * caller can tear down any warm SDK session bound to the previous credential;
   * the fresh session then re-auths as the newly-selected account on its next
   * start. A no-op when no warm session exists yet (the common initial case).
   */
  onRotate: () => void | Promise<void>;
  /** Selection strategy override (else the pool's default). */
  strategy?: CodingAccountStrategy;
}

function rotationStateKey(ctx: RotationContext): string {
  return `${ctx.backend}\u001f${ctx.sessionKey ?? "__default"}`;
}

/** Test seam: keeps per-test rotation state independent. */
export function resetRotationStateForTests(): void {
  rotationStateBySession.clear();
}

/**
 * Run `attempt` with pool-first auth + transparent account rotation on
 * subscription-limit errors.
 *
 * Flow:
 *  1. Pool-FIRST initial auth: when no account is selected for this session yet,
 *     select a healthy pooled account BEFORE the first attempt so a stored
 *     app-connected subscription serves the very first turn. Empty pool / failed
 *     selection → ambient fallback (attempt with no env, pre-pool behavior).
 *  2. Try `attempt(env)`. On success, return it (and best-effort record usage on
 *     the currently-selected account).
 *  3. If it throws and the error is NOT a subscription-limit (or rotation is
 *     disabled / no bridge / backend not rotatable), rethrow immediately →
 *     the caller's existing provider-failover chain handles it.
 *  4. On a limit error: mark the current account rate-limited, select the next
 *     healthy account from the pool (excluding every account already tried),
 *     build its subprocess-only env, dispose the warm session (`onRotate`), and retry.
 *     Repeat until an attempt succeeds or the pool is exhausted; when the pool
 *     returns null, rethrow the LAST limit error so failover runs.
 *
 * A single structured `warn` is emitted per rotation (no credential/envelope
 * leakage). At most `maxRotations` swaps are attempted to bound the loop even if
 * the pool mis-reports health.
 */
export async function withAccountRotation<T>(
  attempt: (env?: RotationSubprocessEnv) => Promise<T>,
  ctx: RotationContext,
  maxRotations = 8
): Promise<T> {
  const agentType = rotationAgentTypeForBackend(ctx.backend);
  const bridge = agentType ? getCodingAccountBridge() : null;
  // No rotation possible/desired → single, un-wrapped attempt (behavior
  // identical to pre-rotation: any throw goes straight to the caller's failover).
  if (!bridge || !agentType || !rotationEnabled(ctx.getValue)) {
    return attempt();
  }

  const stateKey = rotationStateKey(ctx);
  let state = rotationStateBySession.get(stateKey) ?? null;

  // Pool-first initial auth: nothing selected for this session yet, so ask the
  // pool BEFORE the first attempt instead of silently starting on the machine's
  // ambient credential. An app user who connected their subscription expects it
  // used immediately — and a machine with NO ambient login would otherwise fail
  // despite a healthy pooled account. Ambient stays the fallback: select → null
  // (empty pool) or a selection error changes nothing.
  if (!state) {
    let selection: RotationAccountSelection | null = null;
    try {
      selection = await bridge.select(agentType, {
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
      });
    } catch (selectErr) {
      // error-policy:J4 explicit degrade — the account POOL is optional; if its
      // select() fails we fall back to the ambient credential (documented degrade),
      // the CLI still runs. Not a swallowed inference failure.
      logger.warn(
        {
          src: "cli-inference:rotation",
          backend: ctx.backend,
          reason: "initial-select-failed",
        },
        `[cli-inference] initial pool selection failed (${String(selectErr)}) — falling back to the ambient credential`
      );
    }
    if (selection) {
      state = {
        selection,
        subprocessEnv: buildRotatedSubprocessEnv(agentType, selection.envPatch),
      };
      rotationStateBySession.set(stateKey, state);
      // Evict any warm session that started on the ambient credential before
      // the pool was installed, so the next start auths as the selected
      // account. A no-op when no session exists yet (the common first turn).
      try {
        await ctx.onRotate();
      } catch {
        // error-policy:J6 best-effort teardown — the fresh start re-inits anyway.
      }
      logger.info(
        {
          src: "cli-inference:rotation",
          backend: ctx.backend,
          account: safeAccountLabel(selection),
          strategy: selection.strategy,
        },
        `[cli-inference] pooled ${agentType} account selected for warm-session auth`
      );
    }
  }

  const tried: string[] = state ? [state.selection.accountId] : [];
  let lastError: unknown;

  for (let rotations = 0; rotations <= maxRotations; rotations += 1) {
    try {
      const result = await attempt(state?.subprocessEnv);
      // Record a successful call against the account we rotated INTO so
      // quota-aware selection reflects real usage (best-effort; never throws).
      if (state) {
        void bridge
          // error-policy:J7 usage accounting is telemetry — a recordUsage failure
          // must not fail the successful inference result being returned.
          .recordUsage(state.selection.providerId, state.selection.accountId, { ok: true })
          .catch(() => undefined);
      }
      return result;
    } catch (err) {
      lastError = err;
      const subscriptionLimit = isSubscriptionLimitError(err);
      const selectedAccountAuthFailure = state !== null && isProviderAuthenticationError(err);
      if (!subscriptionLimit && !selectedAccountAuthFailure) {
        // An ambient auth error cannot identify a stored account. Other genuine
        // failures also bypass rotation so the provider-failover chain owns them.
        throw err;
      }

      // Only an account selected by this module can be marked. Authentication
      // failures require reauthentication; subscription limits get a cooldown.
      if (state) {
        if (selectedAccountAuthFailure) {
          void bridge
            // error-policy:J7 pool health bookkeeping must not mask failover.
            .markNeedsReauth(
              state.selection.providerId,
              state.selection.accountId,
              "cli-inference authentication rejected"
            )
            .catch(() => undefined);
        } else {
          void bridge
            // error-policy:J7 pool health bookkeeping must not mask failover.
            .markRateLimited(
              state.selection.providerId,
              state.selection.accountId,
              Date.now() + ROTATION_RATE_LIMIT_COOLOFF_MS,
              "cli-inference subscription limit"
            )
            .catch(() => undefined);
        }
        rotationStateBySession.delete(stateKey);
        state = null;
      }

      let selection: RotationAccountSelection | null = null;
      try {
        selection = await bridge.select(agentType, {
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          ...(ctx.strategy ? { strategy: ctx.strategy } : {}),
          // Copy: `tried` keeps growing across rotations; the bridge must see
          // the exclusions as of THIS call, not a live reference.
          exclude: [...tried],
        });
      } catch (selectErr) {
        // error-policy:J2 context-adding — pool selection itself failed; treat as
        // pool-exhausted and rethrow the ORIGINAL limit error so the caller's
        // provider-failover chain runs (does not fabricate a success).
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            reason: "select-failed",
          },
          `[cli-inference] account rotation select failed (${String(selectErr)}) — falling through to provider failover`
        );
        throw err;
      }

      if (!selection) {
        // Pool exhausted: every healthy account tried, or none configured.
        // Rethrow the limit error so the caller's failover chain (cloud / API)
        // runs — rotation composes with, and yields to, failover.
        logger.warn(
          {
            src: "cli-inference:rotation",
            backend: ctx.backend,
            tried: tried.length,
            reason: "pool-exhausted",
          },
          `[cli-inference] no eligible pooled ${agentType} account remains (${tried.length} tried) — failing over to next provider tier`
        );
        throw err;
      }

      tried.push(selection.accountId);
      state = {
        selection,
        subprocessEnv: buildRotatedSubprocessEnv(agentType, selection.envPatch),
      };
      rotationStateBySession.set(stateKey, state);
      // Tear down the warm session so it re-auths as the newly-selected account.
      try {
        await ctx.onRotate();
      } catch {
        // error-policy:J6 best-effort teardown — the fresh start re-inits anyway.
      }
      logger.warn(
        {
          src: "cli-inference:rotation",
          backend: ctx.backend,
          account: safeAccountLabel(selection),
          strategy: selection.strategy,
          attempt: rotations + 1,
        },
        `[cli-inference] rotated to next ${agentType} account after ${selectedAccountAuthFailure ? "authentication failure" : "subscription limit"}`
      );
      // loop retries the turn on the new account
    }
  }

  // Exhausted maxRotations without success — fail over with the last error.
  throw lastError instanceof Error
    ? lastError
    : new Error(`[cli-inference] account rotation exhausted: ${String(lastError)}`);
}
