# @elizaos/agent

Standalone elizaOS agent + HTTP backend server. Wraps `@elizaos/core`'s `AgentRuntime`, resolves and boots the bundled `@elizaos/plugin-*` set, and serves a local dashboard/control API. This is the package the `eliza-autonomous` binary runs.

## Role

- Consumed by the desktop/mobile shells and CLI as the agent process and backend server. Many subpath exports (`@elizaos/agent/api`, `/runtime`, `/services/*`, `/config/*`, `/security/*`, `/auth/*`) are imported by sibling `@elizaos/plugin-*` packages and the app shell.
- Owns runtime boot, plugin resolution/lifecycle, the HTTP API + route dispatch, character/config loading, trajectory persistence, triggers/scheduling, permission brokering, and provider-neutral TEE policy/key-release paths.

Repository-wide conventions and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Layout

```
src/
  bin.ts                  #!/usr/bin/env node entry → cli/index.ts; mobile (android/ios) bootstrap shims
  index.ts                Public barrel — re-exports api/runtime/services/config/auth/security/triggers
  version-resolver.ts     Resolves package version (__ELIZA_VERSION__ / package.json / build-info.json)
  cli/
    index.ts              runAutonomousCli() — command dispatch: serve|start|runtime|ios-bridge|android-bridge|benchmark
    benchmark.ts          Headless benchmark runner (runBenchmark)
  runtime/
    eliza.ts              startEliza() / bootElizaRuntime() / startInCloudMode() — core boot orchestration
    eliza-plugin.ts       createElizaPlugin() — the "eliza" Plugin (workspace/session providers, lifecycle actions, services)
    core-plugins.ts       CORE_PLUGINS / BLOCKING_ / DEFERRED_ / OPTIONAL_ / MOBILE_ / ELIZAOS_ANDROID_ plugin name lists
    plugin-resolver.ts    resolvePlugins() — resolve plugin names → modules; getLastFailedPluginNames()
    plugin-collector.ts   collectPluginNames(), CHANNEL/OPTIONAL/PROVIDER_PLUGIN_MAP
    plugin-lifecycle.ts   Plugin install/eject/reinject lifecycle
    plugin-role-gating.ts Role-based plugin access gating
    roles.ts / roles/     Role definitions and role-resolution helpers
    agent-wallets.ts      Agent wallet bootstrap and TEE-gated wallet logic
    model-resolution.ts   Model name resolution helpers
    prompt-optimization.ts  Lossless prompt telemetry and active-view awareness
    tool-call-cache/ tool-call-cache-wrapper.ts  Tool-call result caching layer
    first-time-setup.ts   First-run initialization logic
    load-plugin-from-directory.ts / load-plugin-from-vfs.ts  Plugin loading from local dirs and VFS
    sandbox-registry.ts / sandbox-character.ts  Sandbox plugin registry and character isolation
    restart.ts            Runtime restart helpers
    release-plugin-policy.ts  Plugin release-channel gating policy
    boot-telemetry.ts / boot-timer.ts  Boot timing and telemetry
    runtime-maintenance.ts  Awaited post-migration startup maintenance
    view-action-affinity.ts  View↔action routing affinity
    web-search-tools.ts / vault-profile-resolver.ts  Miscellaneous runtime helpers
    trajectory-*.ts       Trajectory persistence / query / internals
    operations/           vault-bridge.ts (config env resolution + optimized-prompt integrity key), classifier.ts,
                          cold-strategy.ts, manager.ts, health.ts, health-checks.ts,
                          reload-hot.ts, repository.ts, types.ts
  api/
    server.ts             startApiServer() — HTTP stack, auth, CORS, WS upgrade, route dispatch
    runtime-mode/         mode resolution (local/local-only/cloud/remote), route-visibility gate + remote-mode forwarder run pre-dispatch by every host
    dispatch-route.ts     dispatchRoute() — maps requests to handlers
    *-routes.ts           ~38 route modules (agent admin/lifecycle/status, auth, character, memory, models, permissions, registry, etc.)
    server-helpers*.ts    Auth/conversation/wallet helpers (trusted-local checks, tokens)
    server-types.ts       Conversation/server/plugin transport types
    index.ts              api barrel (@elizaos/agent/api)
  config/
    character-schema.ts   CharacterSchema (zod)
    config.ts             loadElizaConfig() / saveElizaConfig()
    plugin-auto-enable.ts Plugin auto-enable resolution
    paths.ts              resolveUserPath() and state/path helpers
    env-vars.ts, schema.ts, model-metadata.ts, owner-contacts.ts
  services/               Business-logic services (capability-broker, permissions-registry, config-plugin-manager, plugin-installer/-compiler, relationships-graph, agent-export, shell-execution-router, provider-neutral tee-*)
  actions/                Eliza actions registered by createElizaPlugin (terminal, trigger, contact, settings, plugin, logs, runtime, database, memory)
  providers/              Providers for createElizaPlugin (workspace, admin-trust/-panel, session, rolodex, recent/relevant-conversations, pending-permissions, escalation-trigger, page-scoped-context, ...)
  triggers/               runtime.ts (registerTriggerTaskWorker), scheduling.ts, types.ts
  auth/                   Credential storage + OAuth/Anthropic/OpenAI-Codex flows (account-storage, oauth-flow, refresh-mutex)
  security/               access.ts and audit-log.ts; network and MCP policy live in @elizaos/core
  awareness/              Re-exports AwarenessRegistry from @elizaos/shared
  hooks/                  loadHooks() / triggerHook() — workspace hook discovery + dispatch
  contracts/awareness.ts  Re-exports awareness contracts from @elizaos/shared
  diagnostics/            integration-observability.ts
  shared/                 workspace-resolution.ts (resolveDefaultAgentWorkspaceDir)
scripts/                  build/package helpers, deterministic Vitest batching, mobile bundling, live sandbox smoke, and the hardware-free TEE policy harness
  docs/                     capability-router-remote-plugins.md, remote-coding-runner.md, tee-agent-implementation-plan.md
```

## Key exports / surface

- **Binary:** `eliza-autonomous` → `src/bin.ts` → `runAutonomousCli()`. Commands: `serve`/`start`, `runtime`, `ios-bridge`, `android-bridge`, `benchmark`.
- **Boot:** `startEliza()`, `bootElizaRuntime()`, `startInCloudMode()` (`runtime/eliza.ts`); `createElizaPlugin()` (`runtime/eliza-plugin.ts`) — the `Plugin` named `"eliza"` registering services (`AgentEventService`, `ElizaCharacterPersistenceService`, `AgentMediaGenerationService`, `PermissionRegistry`), workspace/session/rolodex providers, and the terminal/trigger/contact/settings/plugin/logs/runtime/database/memory actions.
- **HTTP:** `startApiServer()`, `dispatchRoute()`, route handlers (`@elizaos/agent/api`).
- **Plugin sets:** `CORE_PLUGINS`, `BLOCKING_CORE_PLUGINS`, `DEFERRED_CORE_PLUGINS`, `OPTIONAL_CORE_PLUGINS`, `MOBILE_CORE_PLUGINS` (`runtime/core-plugins.ts`); `resolvePlugins()`, `collectPluginNames()`.
- **Config:** `loadElizaConfig`/`saveElizaConfig`, `CharacterSchema`, `resolveUserPath`, `resolveDefaultAgentWorkspaceDir`.
- **Services (named subpaths):** `getCapabilityBroker`/`CapabilityBroker`, `PermissionRegistry`, `runShell` (`services/shell-execution-router.ts`), `resolveRelationshipsGraphService`, and the provider-neutral TEE policy/key-release helpers (`tee-*`). Concrete attestation providers register through `tee-evidence-provider.ts` from deployment-specific plugins.
- Cloud route handlers (`handleCloudRoute`, `handleCloudBillingRoute`, `validateCloudBaseUrl`) are lazy re-exports that dynamically import `@elizaos/plugin-elizacloud`.

## Commands

Run from repo root targeting this package:

```bash
bun run --cwd packages/agent start            # bun run src/bin.ts (defaults to `serve`)
bun run --cwd packages/agent dev              # bun --hot src/bin.ts
bun run --cwd packages/agent typecheck        # tsc --noEmit -p tsconfig.json
bun run --cwd packages/agent test             # deterministic Vitest batches
bun run --cwd packages/agent test:integration # *.integration.test.ts suites (excluded from the default lane)
bun run --cwd packages/agent lint             # biome check --write across src/
bun run --cwd packages/agent lint:check       # biome check read-only
bun run --cwd packages/agent format           # biome format --write
bun run --cwd packages/agent format:check     # biome format read-only
bun run --cwd packages/agent build            # build:dist (tsc --noCheck → prepare-package-dist → rewrite imports)
bun run --cwd packages/agent build:mobile     # bun scripts/build-mobile-bundle.mjs
bun run --cwd packages/agent build:ios-bun    # mobile bundle, --target=ios
bun run --cwd packages/agent test:remote-capabilities
bun run --cwd packages/agent test:sandbox-live
```

The package test runner keeps one file per isolated Vitest process and runs up
to four processes concurrently by default. Set `AGENT_TEST_CONCURRENCY` to a
positive integer to tune process parallelism, `AGENT_TEST_BATCH_SIZE` to group
files deliberately, or `AGENT_TEST_VERBOSE=1` to print every passing child log.

`build:docker-dist`, `build:ios-jsc`, `clean`, `pack:dry-run`, `test:remote-capabilities:{docker,cloud-live,provider-live,source-build}` also exist in `package.json`.

## Config / env vars

State and platform:
- `ELIZA_STATE_DIR` — per-user state root (DB, config, logs). `PGLITE_DATA_DIR` / `POSTGRES_URL` for the SQL store.
- `ELIZA_PLATFORM` (`android`/`ios`/…), `ELIZA_BUILD_VARIANT`, `ELIZA_RUNTIME_MODE`, `ELIZA_MOBILE_LOCAL_AGENT`, `ELIZA_DEVICE_BRIDGE_ENABLED`, `ELIZA_LOCAL_LLAMA`.

Cloud + models:
- `ELIZAOS_CLOUD_ENABLED`, `ELIZAOS_CLOUD_API_KEY`, `ELIZAOS_CLOUD_BASE_URL`, `ELIZA_CLOUD_PROVISIONED`.
- `ELIZA_CLOUD_PAIR_DIRECT_RELAY=1` enables the loopback-only `/pair` relay
  (`api/cloud-pair-route.ts`). Non-loopback peers additionally require
  `ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS` (comma-separated CIDRs, default
  empty): local-Docker deployments publish the port on the host loopback, so
  the in-container peer is the bridge gateway — allow exactly that range, e.g.
  `172.17.0.0/16`. Each entry widens pairing-token redemption to that LAN/VPC
  segment; keep the list minimal.
- Model overrides: `ELIZAOS_CLOUD_{NANO,SMALL,MEDIUM,LARGE,MEGA}_MODEL`, `ELIZAOS_CLOUD_{PLANNER,ACTION_PLANNER,SHOULD_RESPOND,RESPONSE_HANDLER}_MODEL`.
- Provider keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

Verified audio redaction:
- `ELIZA_FFMPEG_PATH` / `ELIZA_FFPROBE_PATH` — optional executable overrides for non-PCM16 containers; PCM16 WAV redaction is dependency-free.
- `ELIZA_AUDIO_REDACTION_VERIFY_STT_URL` and `ELIZA_AUDIO_REDACTION_VERIFY_STT_MODEL` — optional second OpenAI-compatible STT verifier; configure both or neither.
- `ELIZA_AUDIO_REDACTION_VERIFY_STT_API_KEY` — optional bearer credential for that independent verifier. The guarded client never follows redirects.

Capability router (remote plugins — see `docs/capability-router-remote-plugins.md`):
- `ELIZA_CAPABILITY_ROUTER_ENABLED`, `ELIZA_CAPABILITY_ROUTER_URLS`, `ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES`, `ELIZA_CAPABILITY_ROUTER_TRUST_POLICY`, `ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT`.

Wallet/chain: `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `ELIZA_WALLET_NETWORK`, `{BSC,QUICKNODE_BSC,NODEREAL_BSC}_RPC_URL`. Misc: `GITHUB_TOKEN`, `LOG_LEVEL`.

Stability (memory watchdog — `runtime/memory-watchdog.ts`, #10197): the boot
  sampler (`runtime/boot-telemetry.ts`) only *records* RSS; the watchdog *acts* on
it by requesting a clean restart through the existing `requestRestart()` seam
(host exits `RESTART_EXIT_CODE=75`, the `packages/app-core/scripts/run-node.mjs`
supervisor relaunches) — never a silent `process.exit`.
- `ELIZA_MEMORY_WATCHDOG` — `1`/`true` enables it (default **off**).
- `ELIZA_MEMORY_WATCHDOG_RSS_MB` — RSS restart threshold in MB (default `1536`, floor `128`).
- `ELIZA_MEMORY_WATCHDOG_INTERVAL_MS` — sample interval (default `30000`, floor `1000`).
- `ELIZA_MEMORY_WATCHDOG_SUSTAINED` — consecutive over-threshold samples before a restart, to debounce transient spikes (default `3`, floor `1`).

Connector health monitoring (`api/connector-health.ts`): the interval is validated
  synchronously by `startApiServer` before the HTTP server is created or bound, then
  passed into the monitor's post-listen deferred construction. The deferred catch
  therefore cannot hide malformed owner configuration or disable monitoring.
- `CONNECTOR_HEALTH_INTERVAL_MS` — poll interval in ms (default `60000`, floor `10000`,
  ceiling `2147483647`). Configured values must be exact decimal integers; malformed,
  non-canonical, below-floor, or above-ceiling values fail API startup before readiness.

## How to extend

- **Add an Eliza action/provider to the agent plugin:** add the file under `src/actions/` or `src/providers/`, export it through the directory barrel (`actions/index.ts`), then wire it into the `actions`/`providers` arrays in `createElizaPlugin()` (`runtime/eliza-plugin.ts`). Parent actions with subactions are flattened via `promoteSubactionsToActions(...)`.
- **Add an HTTP route:** create `src/api/<name>-routes.ts` exporting a handler, register it in `api/dispatch-route.ts`, export it from `api/index.ts`, and cover the real caller and transport boundary.
- **Add/enable a bundled plugin:** add the package name to the appropriate list in `runtime/core-plugins.ts` (`CORE_PLUGINS`, `BLOCKING_`/`DEFERRED_`, `MOBILE_`/`ELIZAOS_ANDROID_`) and add it as a `workspace:*` dependency in `package.json`.
- **Add a service:** put it under `src/services/`, register the class in the `services` array of `createElizaPlugin()`, and export from `services/index.ts`.

## Conventions / gotchas

- `bin.ts` statically imports `node:fs` and pins AOSP/mobile bootstrap symbols onto `globalThis` to defeat tree-shaking in the mobile bundle — do not remove those guards.
- `core-plugins.ts` splits plugins into blocking vs deferred boot phases; slow feature/provider plugins must stay in the deferred set or boot regresses.
- Several barrel re-exports avoid duplicate-symbol (`TS2308`) collisions and lazy-load heavy plugins (wallet, app-manager, elizacloud) — read the inline comments in `index.ts`/`api/index.ts`/`services/index.ts` before adding broad `export *` lines.
- `lint`/`lint:check` and `format` cover the complete `src/` tree.
- Post-turn evidence must wait for the current room lease's delivery settlement:
  both JSON and SSE routes reconcile the final assistant text, reply correlation,
  and action callback history before extraction snapshots are frozen. Failed
  reconciliation cancels extraction; it must not deadlock the route or advance a
  memory checkpoint. Keep the paired transport cases in
  `api/__tests__/conversation-idempotency.test.ts` when changing this boundary.
- Standalone grounded action replies pass complete conversation memories, action results,
  trajectories, character context, and model output without trimming, deduping,
  summarizing, or silently falling back from a partial prompt. Missing or invalid
  context is an explicit failure; final-wire model limits are enforced by core.
- Provider-neutral TEE policy and key release are gated behind `services/tee-boot-gate*`; the hardware-free trust pipeline is exercised by `scripts/tee-full-stack-local.ts`. Concrete attestation providers and hardware validation belong to their deployment; see `docs/tee-agent-implementation-plan.md`.
- **Files / media storage.** Attachment bytes live in one content-addressed store, `api/media-store.ts` (`${STATE_DIR}/media/<sha256>.<ext>`, served pre-auth at `/api/media/<sha256>.<ext>` with `nosniff` and a download `Content-Disposition` for SVG/active types). `services/file-storage.ts` (`LocalFileStorageService`, fills `ServiceType.REMOTE_FILES`) is the contract the rest of the system resolves through `runtime.getService(ServiceType.REMOTE_FILES)` for `store`/`getUrl`/`list`/`delete`; authenticated `api/files-routes.ts` (`GET`/`DELETE /api/files`) and the `actions/files.ts` `FILES` tool both use it. `api/media-runtime.ts` rehosts inline `data:` and remote generated-media URLs on authenticated outgoing paths through the SSRF guard and runs the reference-aware orphan GC. Do not add a second file store, a `files` table, or a second refcount/GC engine; see issue #8876 and the root media invariant.
- **Trajectory metadata is append-complete.** Persist every extracted insight and
  observation in source order, including duplicates. Page sizes may bound a
  storage call, but recency windows and item caps must never rewrite trajectory,
  training, or later model context. Preserve each record's exact text regardless
  of length or surrounding whitespace; reject malformed Unicode rather than
  repairing the recorded request or response.
- **Agent read actions are exhaustive.** `FILES`, `SEARCH_KNOWLEDGE`, and
  `MEMORY` return every authorized match. Storage page sizes are internal
  transport batches; repeated, changing, or incomplete traversals fail
  explicitly and must never become a successful model-facing prefix.

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For agent-host
changes, additionally capture and inspect:

- a live-model scenario trajectory for any changed provider → model → action →
  evaluator path, including raw model output and tool results;
- structured backend logs proving the changed message, scheduler, route, or
  service path ran end to end; and
- the resulting memory, entity, relationship, scheduled-task, media, or other
  persistent artifacts rather than inferring them from a successful response.

Chat widget and generative-UI providers publish complete bodies plus discovery notices. Direct text turns load syntax only through the explicit context-read protocol, including planner/completion restoration. Do not activate full generative guides by scanning arbitrary old dialogue for keywords; visual follow-ups can request the same complete reference. Channel and role gates still apply.

Always-on response providers bypass context selection only, never role or private-provider gates. The generative UI guide is an ADMIN-authorized discovery reference in Stage 1 and later stages; do not require historical keywords or expose its full syntax before a context read.

Recall queries use authored message text, excluding host language wrappers. Dynamic skill scores return discovery candidates; only an explicitly named strong match loads instructions automatically. Configured app display names are labeled separately from historical entity aliases. Protected trajectory model fields use complete secret-redacted projection, including nested tool schemas; runtime-only diagnostics retain bounded projection.

Planner-owned LifeOps replies hand complete action-specific facts, character
context and reply rules to the final response model through `data.replyGrounding`.
Only the full message planner grants this ownership for the same message while
its action handler is active. Direct/background callers and withheld result
payloads keep standalone rendering. Deferred replies are internal evidence,
never unavailable status or canned user prose; preserve receipts, clarification
states, permission rechecks, final-context restoration and reply-only recovery.

Backup metadata listing enumerates an existing directory directly, without an unconditional existence stat. After ENOENT, distinguish an absent directory from a dangling symlink before returning an empty list. Permission and non-directory errors remain errors; per-file identity checks, complete results and encrypted restore behavior remain unchanged.
