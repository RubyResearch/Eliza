# @elizaos/plugin-cli-inference

TOS-clean SAFE/CLOUD inference route for elizaOS. Serves chat/planner inference by **spawning the sanctioned local CLI** (`claude --print` or `codex exec`) as eliza model handlers. The CLI reads its own subscription credentials from disk — eliza never sees, forwards, or logs the token.

## Purpose / role

The handlers shell out to the official CLI, which loads `~/.claude/.credentials.json` / `~/.codex/auth.json` itself. The token is never injected into the child env (`filterEnv` allowlist + `SENSITIVE_ENV_RE` blocklist) or into logs (stderr is redacted before logging).

Node-only (`"platforms": ["node"]`) — exported from `index.node.ts` only.

## Enable

For an explicit local Codex text-brain override, set `ELIZA_CHAT_VIA_CLI=codex-sdk`
and `ELIZA_BRAIN_PROVIDER=cli-inference`. The latter selects the existing
runtime dispatch override; priority alone does not replace an explicitly
configured provider. Set `ELIZA_CLI_CODEX_MODEL` and
`ELIZA_CLI_CODEX_PLANNER_MODEL` to the supported model ID; use
`ELIZA_CLI_CLAUDE_ALL_TIERS=1` to include the small text tiers.

The configured `CODEX_HOME` is preserved for account selection when no pooled
account overrides it; unrelated ambient secrets remain excluded.

The official SDK manages authentication. Its inference-only exec launcher adds
`--ignore-user-config --ignore-rules --ephemeral`; the SDK version used here
does not expose these flags directly. This keeps personal MCP configuration out
of inference, retains the CLI's own sign-in, and avoids persisted SDK histories.
The adapter disables shell, apps/plugins, hooks, subagents and Codex memories.
Use a current installed CLI supporting these flags; unsupported flags fail
explicitly, never retry with weaker isolation. These are process-local settings,
not edits to the owner's interactive Codex configuration.

Single env gate: **`ELIZA_CHAT_VIA_CLI=claude`**, **`claude-sdk`**, **`codex`**, or **`codex-sdk`**.

- Unset → the plugin is never added to the resolved set (`auto-enable.ts shouldEnable` is false), and even if force-loaded its models map is empty. INERT; no existing code path changes.
- `claude` / `codex` → the large-tier handlers **cold-spawn** that CLI per call (`claude --print` / `codex exec`).
- `claude-sdk` → the handlers run a **warm Claude Agent SDK session** (one persistent process per `(model, systemPrompt, mode)`), not a per-call spawn. This is the fast + TOS-clean path: ~1-2s warm vs the CLI's 25-68s cold-spawn-per-call, and it does **native tool-calling** for the planner. See "Warm Agent SDK backend" below.

## Plugin surface

No actions, providers, evaluators, or routes. Model handlers only. Large text tiers are registered by default; the existing `ELIZA_CLI_CLAUDE_ALL_TIERS=1` switch also enables small tiers for SDK backends.

| Model type | Backend |
|---|---|
| `TEXT_LARGE` | `claude --print` or `codex exec` |
| `TEXT_MEGA` | "" |
| `RESPONSE_HANDLER` | "" |
| `ACTION_PLANNER` | Codex SDK: native tool-decision bridge; other backends: text-planner mode only |

`TEXT_SMALL` / `TEXT_NANO` / `TEXT_MEDIUM` are opt-in via the shared all-tiers switch.

`ACTION_PLANNER` is **conditional for non-Codex-SDK backends**: in the default native-tools mode
(`ELIZA_PLANNER_NATIVE_TOOLS=1`) it is **not** registered, because that planner
needs GBNF / native-tool grammar the free-text CLI cannot honor — so the planner
stays on a grammar-honoring provider while the CLI still serves the user-facing
reply (`RESPONSE_HANDLER`) and large generations (`TEXT_LARGE`). In **text-planner
mode** (`ELIZA_PLANNER_NATIVE_TOOLS=0`) the CLI **does** register and serve
`ACTION_PLANNER`: the grammar-heavy planner prompt is rewritten into a clean
"pick ONE action, emit `{action, params}` JSON" routing prompt (see
`clean-routing-planner.ts`, proven live with `claude --print --model
claude-opus-4-8`). This is how the **whole brain** (chat + planner + coding) can
run on a single Claude Max subscription **TOS-clean**, no API key, no stealth.
Note: the per-turn `claude` subprocess makes the text-planner path slower than a
direct-API provider (~tens of seconds for a planner turn) — use the `claude-sdk`
backend below to keep the clean path fast.

## Warm Agent SDK backend (`ELIZA_CHAT_VIA_CLI=claude-sdk`)

The fast, TOS-clean way to run the whole brain on a Claude Max subscription.
Effective 2026-06-15 Anthropic grants subscriptions a monthly **Agent SDK
credit**, so driving the brain through `@anthropic-ai/claude-agent-sdk` (which
reads `~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN` itself — eliza never sees the
token) is **officially sanctioned**, strictly cleaner than the stealth
token-replay. The SDK is loaded via a variable dynamic import (`src/claude-sdk-session.ts`)
so the plugin stays inert and never imports it unless this backend is set.

A `ClaudeSdkSession` keeps ONE warm streaming-input `query()` process alive, so
the cold-start is paid once, not per call. Two modes:

- **TEXT mode** (`generate`) — `RESPONSE_HANDLER` / `TEXT_LARGE` / `TEXT_MEGA`.
  `allowedTools: []` + `settingSources: []` strip Claude Code's own tools and
  project context → a warm chat-completion engine. The model is reframed as a
  pure completion engine (`frameTextSystemPrompt` system prefix + a closing
  `appendTextDirective`) so it synthesizes the final reply from already-executed
  tool results rather than narrating agentic intent ("I'll fetch it…").
- **ROUTE mode** (`route`) — `ACTION_PLANNER` (text-planner mode). A single
  in-process MCP tool `route_action({action, params})` is the only allowed tool.
  The model emits a **native `tool_use`**; the SDK routes it to our handler
  in-process; the handler captures `{action, params}` and **eliza executes the
  action** (Claude Code never does). This matches the stealth/native path's full
  functionality (WEB_FETCH, sub-agents) with no free-text JSON parsing and no
  required-tool retry loop. The returned bare `{action, params}` is consumed by
  the loop's existing text-mode parser — no core change.

Sessions are keyed by `(model, mode, sha256(systemPrompt))` because the SDK
freezes `systemPrompt` + `mcpServers` at `query()` start (no mid-session reset);
`setModel()` switches tiers live on one process. Calls are serialized; the
session self-heals on error and restarts after `restartAfterTurns` (default 20)
to bound context growth. The `result` envelope is inspected so an
`error_max_turns`/empty turn falls back to `result.result` instead of throwing a
spurious "empty completion".

Per-tier models: `ELIZA_CLI_CLAUDE_PLANNER_MODEL` (small/planner, e.g. sonnet) +
`ELIZA_CLI_CLAUDE_MODEL` (large, e.g. opus); `ELIZA_CLI_CLAUDE_BIN` points the
SDK at the Claude Code executable.

**Caveat:** the monthly Agent SDK credit can run dry mid-month (the SDK then
returns a session-limit error); plan a fallback (a key/Cloud tier, or stealth on
a self-host) for production continuity.

## Request-isolated Codex SDK backend (`ELIZA_CHAT_VIA_CLI=codex-sdk`)

Uses the official `@openai/codex-sdk` and CLI authentication. The installed SDK
spawns a CLI process for each run; it is not a persistent inference process.
Every request starts a fresh thread in an isolated temporary working directory.
Eliza supplies the complete authorized conversation and memory context, so no
second hidden conversation can leak across rooms, actors, or permission changes.
Adapter configuration/account affinity is keyed by runtime instance and model.

- **TEXT** (`generate`): `thread.run(body)` with `sandboxMode:"read-only"`,
  `approvalPolicy:"never"`, `networkAccessEnabled:false` → a request-isolated completion
  engine; returns the turn's `finalResponse`.
- **ROUTE** (`route`): codex NATIVE structured output (`outputSchema`) constrains
  the turn to `{action, params}` (params as a JSON string for OpenAI strict mode),
  reliable at scale. REQUIRES `ELIZA_CLI_CODEX_BIN` pointing at the system codex —
  the SDK bundles an old codex (0.80.0) that rejects current models/structured output.

In the default native-tool planner mode, supplied tool schemas and toolChoice
are preserved in the request. Codex structured output is validated and adapted
to Eliza's `GenerateTextResult.toolCalls`; only Eliza executes those decisions.
Undeclared tools, malformed argument objects, and missing required calls fail
explicitly. This also handles Stage-1 HANDLE_RESPONSE. Legacy text routing is
retained, but malformed route arguments are rejected rather than replaced by {}.
This Codex backend registers ACTION_PLANNER in either planner mode; the cold
CLI and Claude paths retain their existing registration policies.

For Astra Light, set `ELIZA_CLI_CODEX_MODEL=gpt-6-astra`,
`ELIZA_CLI_CODEX_PLANNER_MODEL=gpt-6-astra`, and
`ELIZA_CLI_CODEX_REASONING_EFFORT=low`; pin `ELIZA_CLI_CODEX_BIN` to an installed
CLI that supports the model. Availability depends on the signed-in account.
Use the official SDK/authentication path, not OAuth-token replay against private
endpoints. Subscription limits still apply. Measure full app latency separately
from an isolated SDK test; retaining a Thread object does not eliminate startup.

## Layout

```
plugins/plugin-cli-inference/
  index.ts                  Plugin entry — gates + registers large-tier handlers; init double-activation guard
  index.node.ts             Node re-export
  index.browser.ts          Browser stub (node-only plugin; empty models)
  auto-enable.ts            shouldEnable = ELIZA_CHAT_VIA_CLI is claude|claude-sdk|codex
  src/
    claude-cli.ts           ClaudeCli — spawns `claude --print`; __setSpawnForTests seam
    codex-cli-exec.ts       CodexCli — spawns `codex exec --json`; JSONL last-assistant parse
    prompt-flatten.ts       system/developer -> system slot; user/assistant/tool -> body; nothing dropped
    sandbox.ts              SOC2 helpers copied from plugin-sub-agent-claude-code (filterEnv/resolveSafeCwd/resolveSafeBinary/SENSITIVE_ENV_RE)
  __tests__/
    cli-inference.test.ts   Unit tests (mock spawn): argv, token-absence, threading, parse, throw-on-error, large-tier-only
  build.ts  vitest.config.ts  tsconfig*.json  biome.json
```

## GenerateTextParams -> CLI mapping (HARD REQ: forward BOTH system AND messages/prompt)

- **claude:** `[claude, -p, --system-prompt-file <isolated complete system file>, --output-format text, --model <ELIZA_CLI_CLAUDE_MODEL || claude-opus-4-8>]`, with the complete body streamed from an isolated stdin file so OS argv limits cannot shorten or reject it.
- **codex:** `[codex, exec, -m <ELIZA_CLI_CODEX_MODEL || gpt-5.5>, -s read-only, --skip-git-repo-check, -C <cwd>, --color never, --json, -]`, with the complete system-plus-body prompt streamed from an isolated stdin file.

`prompt-flatten` re-routes system/developer roles to the system slot and flattens user/assistant/tool turns into the body; messages are NEVER dropped (would strip skills/memory/recent-convo/grammar).

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `ELIZA_CHAT_VIA_CLI` | — | (unset = inert) | `claude`, `claude-sdk`, or `codex` — the single enable gate |
| `ELIZA_CLI_CLAUDE_MODEL` | No | `claude-opus-4-8` | claude large-tier model (`--model` / SDK large tier) |
| `ELIZA_CLI_CLAUDE_PLANNER_MODEL` | No | (falls back to large) | `claude-sdk` small/planner tier model (e.g. sonnet) |
| `ELIZA_CLI_CLAUDE_BIN` | No | (SDK default / allowlist lookup) | path to the claude executable: drives the `claude-sdk` session AND pins the cold `claude` spawn (deploys outside the SOC2 launcher allowlist) |
| `ELIZA_CLI_SDK_RESTART_AFTER_TURNS` | No | `20` | `claude-sdk` / `codex-sdk`: restart a warm session after a positive safe-integer number of turns (bounds context) |
| `ELIZA_CLI_SDK_TURN_TIMEOUT_MS` | No | `90000` | `claude-sdk`: per-turn timeout from `1` through `2147483647` ms; falls back to `ELIZA_CLI_TIMEOUT_MS` when unset; the exact literal `0` is the only unbounded-turn opt-out |
| `ELIZA_CLI_CLAUDE_EFFORT` | No | (SDK default: high) | `claude-sdk`: reasoning effort forwarded to the SDK `effort` option (`low`/`medium`/`high`/`xhigh`/`max`); an unsupported level for the model is silently downgraded by the SDK |
| `ELIZA_CLI_CLAUDE_PLANNER_EFFORT` | No | (falls back to `ELIZA_CLI_CLAUDE_EFFORT`) | `claude-sdk`: effort for the ROUTE-mode planner tier, so routing depth tunes independently of reply depth |
| `ELIZA_CLI_CLAUDE_ALL_TIERS` | No | (unset = large tiers only) | `claude-sdk`: also serve the high-frequency triage tiers (TEXT_SMALL/NANO/MEDIUM) on this route so the ENTIRE text brain runs on the one subscription (no cerebras/gemma fallthrough). Higher subscription usage; triage defaults to the cheaper large-tier model, not the planner tier |
| `ELIZA_CLI_CLAUDE_SMALL_MODEL` | No | (falls back to `ELIZA_CLI_CLAUDE_MODEL`) | `claude-sdk` ALL-TIERS: model for the triage tiers (should-respond gate, callback rewrite) — set a cheaper model (e.g. sonnet/haiku) so high-frequency triage doesn't run on opus |
| `ELIZA_CLI_CODEX_MODEL` | No | `gpt-5.5` | codex large-tier model (`codex exec -m` / SDK large tier) |
| `ELIZA_CLI_CODEX_PLANNER_MODEL` | No | (falls back to large) | `codex-sdk` small/planner tier model |
| `ELIZA_CLI_CODEX_REASONING_EFFORT` | No | (sdk default) | `codex-sdk`: `modelReasoningEffort` (minimal..xhigh) |
| `ELIZA_CLI_CODEX_BIN` | No | (sdk bundled / allowlist lookup) | path to the system codex binary: REQUIRED for `codex-sdk` (bundled 0.80.0 rejects current models); also pins the cold `codex` spawn |
| `ELIZA_CLI_TIMEOUT_MS` | No | `120000` | per-call spawn timeout from `1` through `2147483647` ms (SIGTERM on expiry; cold CLI backends), also the `claude-sdk` turn-timeout fallback when its dedicated setting is absent |

## Errors

Handlers THROW on non-zero exit / timeout (`+SIGTERM`) / empty stdout so `useModel` + AccountPool failover treat them as provider failures — never swallow-and-return-empty. stderr is redacted via `SENSITIVE_ENV_RE` before it reaches the error message or log.

For the active backend, an explicitly present numeric timeout/restart setting must satisfy the contract above. Blank, malformed, non-safe, zero (except the exact SDK turn-timeout opt-out), and negative values throw `CLI_INFERENCE_INVALID_CONFIGURATION` before any process or warm session is created. Timer-backed general and SDK turn timeouts also reject values above `2147483647`, which Node would otherwise clamp to about 1 ms; the turn-count restart cadence remains a positive safe integer. Only a truly absent setting selects a fallback/default; settings unused by the active backend are ignored. Each warm-cache entry records its effective bounds; a configuration change disposes and replaces the session under the same logical cache/rotation identity, so stale lifecycle or account-affinity state cannot be reused or accumulated.

## Commands

```bash
bun run --cwd plugins/plugin-cli-inference test       # vitest (mocks spawn; no real CLI)
bun run --cwd plugins/plugin-cli-inference typecheck
bun run --cwd plugins/plugin-cli-inference lint:check
bun run --cwd plugins/plugin-cli-inference build
```

## Conventions / gotchas

- **Node-only.** `index.browser.ts` is a stub; the real handlers use `node:child_process`.
- **Isolated cwd per call.** Created with `mkdtemp` under `tmpdir()`, validated by `resolveSafeCwd`, removed in a `finally`. Keeps the CLI out of real projects (suppresses Claude Code repo-context identity).
- **Prompt files are ephemeral and private.** Cold CLI prompts are written mode `0600` inside the per-call isolated temp directory, streamed through stdin (and `--system-prompt-file` for Claude), and removed in `finally` with the directory.
- **sandbox.ts is the canonical copy** of the `SAFE_ENV_KEYS` allowlist and `SENSITIVE_ENV_RE` redaction pattern for spawned CLI subprocesses.
- **Multi-account pool auth + rotation (SDK backends only).** The `claude-sdk` / `codex-sdk` chat brain consults the shared `CODING_AGENT_SELECTOR_BRIDGE_SYMBOL` bridge accessor from `@elizaos/core` (in `src/account-rotation.ts`) POOL-FIRST: the FIRST warm-session auth selects a healthy pooled account and materializes its subprocess-only SDK env (`CLAUDE_CODE_OAUTH_TOKEN` / per-account `CODEX_HOME`), so an app-connected subscription is used immediately — the ambient `~/.claude` / `CLAUDE_CODE_OAUTH_TOKEN` credential is only the fallback when the pool is empty or selection fails. A subscription-limit throw marks the account rate-limited; a typed 401/403 from a selected account marks it as needing reauthentication. Both cases evict the warm session, select another healthy pooled account, and retry before provider failover. Ambient authentication failures and other errors rethrow without mutating the pool. Default ON when a pool is present; opt out with `ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0`. The COLD `claude --print` / `codex exec` CLIs still own one on-disk cred set (pool auth is SDK-only; the bare-CLI shim is issue #11180 Gap B).
- See the root `CLAUDE.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
