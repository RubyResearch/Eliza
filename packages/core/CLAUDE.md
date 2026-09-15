# @elizaos/core

The runtime heart of elizaOS: `AgentRuntime`, the plugin abstractions (actions / providers / evaluators / services / models / routes / events), the canonical type system, and the supporting subsystems (memory, search, settings, scheduling, prompts). Almost every other `@elizaos/*` package and plugin imports from here.

## Role

`@elizaos/core` defines the contracts an Eliza agent runs on and the runtime that executes them. Plugins implement `Plugin` and the runtime wires their actions/providers/evaluators/services into the message-handling loop. Consumed by `@elizaos/agent` (which also hosts the HTTP API server), `@elizaos/app-core` (the API + dashboard host), and every plugin. It builds to three targets (Node, browser, edge) via conditional exports — keep Node-only code out of the browser/edge entries.

## Layout

```
src/
  index.ts              Default barrel — re-exports index.node and security helpers
  index.node.ts         Full Node API surface (the real export list — start here)
  index.browser.ts      Browser-safe subset (no fs/process-bound modules)
  index.edge.ts         Edge-runtime subset
  runtime.ts            AgentRuntime class and lifecycle orchestration; navigate by symbol
  runtime-composition.ts  loadCharacters / createRuntimes / settings merge (Node-only boot helpers)
  runtime-env.ts        Runtime environment + state resolution
  plugin.ts             Plugin load/validate/resolve: loadPlugin, resolvePlugins, validatePlugin, resolvePluginDependencies
  plugin-lifecycle.ts   Plugin register/unload/reload + ownership tracking
  runtime/              Message loop internals: message-handler, planner-loop, turn-controller, action-catalog,
                        action-retrieval/routing/tiering, context-* (registry/renderer/gates), evaluator,
                        validated-model-call, response-grammar, system-prompt, sub-planner, trajectory-recorder
  types/                Canonical type system. types/index.ts is the barrel; types/runtime.ts has IAgentRuntime;
                        plugin.ts, model.ts, memory.ts, state.ts, service.ts, task.ts, events.ts, schema*.ts, etc.
  services/             Built-in services: task / task-scheduler, evaluator, message, relationships,
                        pairing, pairing-integration, pairing-migration, hook, optimized-prompt,
                        optimized-prompt-resolver, tool-policy, trajectories, trajectory-export, trajectory-types,
                        triggerScheduling, approval, embedding, followUp, analysis-mode-handler, agentEvent,
                        runtime-capability-service, setup-cli, setup-rpc, setup-state
  features/             Self-contained capability bundles, each its own dir:
                        basic-capabilities (the core action/provider/evaluator/service bundle),
                        advanced-capabilities, advanced-memory, advanced-planning, approvals, autonomy, ballots,
                        documents, messaging (triage), oauth, payments, plugin-config, plugin-manager,
                        secrets, sub-agent-credentials, trajectories, trust, working-memory
  actions/              Action plumbing: action-schema, to-tool, validate-tool-args, subaction-dispatch
  providers/            First-party providers (setup-progress, skill-eligibility, linked-identities, ...)
  schemas/              Drizzle table schemas + character schema. schemas/index.ts: buildBaseTables, BaseTables
  database/             inMemoryAdapter (IDatabaseAdapter fallback used when ALLOW_NO_DATABASE)
  contracts/            Runtime-owned contracts plus topology, routing, first-run, and wallet adapters
  generated/            Build-time generated action/provider/evaluator docs + spec-helpers (do not hand-edit)
  i18n/                 validation + action-search keyword data (some generated; see prebuild)
  security/             KMS adapters, MCP config validation, spawn policy, redaction, and content guards
  sensitive-requests/   Sensitive request policy helpers
  network/              Canonical SSRF/IP policy, DNS pinning, and guarded fetch transport
  markdown/  media/     markdown IR/chunking; media fetch + mime/type detection
  testing/              Test harness exports (live-provider, integration-runtime, http, mocks) — `@elizaos/core/testing`
  capabilities/         Runtime capability index
  connectors/           Connector abstractions (account-manager, connector-config, oauth-role, privacy)
  plugins/              Plugin-related helpers
  registries/           Registry utilities
  sessions/             Session management
  sandbox/              Sandbox policy
  scheduled-task/       Scheduled task helpers
  validation/           Input validation utilities
  constants/            Shared constants
  api/                  API helpers
  owner-state/          Owner state tracking
  messaging/            Messaging utilities
  search.ts             In-memory/embedding search utilities
  utils.ts  utils/      Shared helpers: prompts (composePromptFromState, parseKeyValueXml), deterministic hashing, state/optimization dirs, batch-queue,
                        confirmation, read-env, state-dir, streaming, environment, plugin-loader
build.ts                Custom bun-based multi-target build (Node / browser / edge + d.ts generation)
scripts/perf-settings.ts, scripts/run-e2e-smoke.mjs
```

## Key exports / surface

From `@elizaos/core` (`index.node.ts`):
- `AgentRuntime` — the runtime, `implements IAgentRuntime`.
- Plugin machinery: `loadPlugin`, `resolvePlugins`, `validatePlugin`, `isValidPluginShape`, `normalizePluginName`, `resolvePluginDependencies`.
- `logger` (re-exported from `./logger`) — the structured logger all packages use.
- Type contracts: `Plugin`, `Action`, `Provider`, `Evaluator`, `Service`, `IAgentRuntime`, `IDatabaseAdapter`, `Memory`, `State`, `Character`, `ModelType`, `UUID`, plus everything in `types/`.
- Built-in capability bundle: `basicCapabilities` / `basicActions` / `basicProviders` / `basicEvaluators` / `basicServices` (from `features/basic-capabilities/index.ts`).
- Boot/composition (Node): `loadCharacters`, `createRuntimes`, `buildBaseTables`, `InMemoryDatabaseAdapter`.
- Prompt + model helpers: `composePromptFromState`, `parseKeyValueXml`, `callModelWithValidation`, `parseAndValidate`.

Subpath entries (see `package.json` `exports`): `@elizaos/core/node`,
`@elizaos/core/browser`, `@elizaos/core/roles`, `@elizaos/core/testing`,
`@elizaos/core/network`, `@elizaos/core/atomic-json`,
`@elizaos/core/security/mcp-server-config`, `@elizaos/core/security/kms`,
`@elizaos/core/security/spawn-env-policy`, and `@elizaos/core/services/*`.

This package does NOT export a `corePlugin` singleton — the foundational actions/providers/evaluators/services live in `features/basic-capabilities` and are exported as the `basic*` bundles above.

## Commands

```bash
bun run --cwd packages/core build         # multi-target build via build.ts (Node + browser + edge + d.ts)
bun run --cwd packages/core build:node    # Node target only
bun run --cwd packages/core build:watch   # watch build (alias: dev)
bun run --cwd packages/core test          # vitest run (via ../scripts/run-vitest.mjs)
bun run --cwd packages/core test:watch    # vitest watch
bun run --cwd packages/core test:coverage # vitest with v8 coverage
bun run --cwd packages/core test:e2e      # Playwright (playwright.config.ts)
bun run --cwd packages/core test:e2e:smoke
bun run --cwd packages/core typecheck     # generate keywords, then tsc --noEmit
bun run --cwd packages/core lint          # biome check --write ./src
bun run --cwd packages/core format        # biome format --write ./src
bun run --cwd packages/core clean         # remove dist + emitted src artifacts
```

`prebuild` builds logger and cloud-routing, then generates `src/i18n/generated/validation-keyword-data.ts` if missing. Runtime-owned contracts are compiled with core.

## Config / env vars

Read by the runtime (see README for the full WHY of each):
- `LOG_LEVEL`, `LOG_JSON_FORMAT`, `LOG_FILE` — logger behavior (`src/logger.ts`).
- `SECRET_SALT` — encryption salt, read by `getSalt()` in `src/settings.ts` (`ELIZA_ALLOW_DEFAULT_SECRET_SALT` overrides the production non-default check).
- `ALLOW_NO_DATABASE` — fall back to `InMemoryDatabaseAdapter` on `initialize()` when no adapter is provided (`runtime.ts`).
- `SHOULD_RESPOND_MODEL` (`small`/`large`, `services/message.ts`), `BASIC_CAPABILITIES_KEEP_RESP` (`services/message.ts`) — message/basic-capabilities behavior.
- `ELIZA_BOT_NOISE_TRIAGE` (`services/message/bot-noise-triage.ts`) — set `0` to disable the TEXT_SMALL pre-gate that triages unaddressed bot/webhook group messages before the Stage 1 RESPONSE_HANDLER call (default on).
- `ELIZA_STAGE1_GROUP_TRIAGE` (`services/message/stage1-prompt-tier.ts`) — set `0` to disable the compact Stage 1 instruction tier for unaddressed group messages and always render the full rule block (default on).
- `AUTONOMY_INTERVAL_MS` (`features/autonomy/service.ts`) — canonical positive decimal integer cadence in milliseconds, clamped to 5,000–600,000; malformed or unset values use 30,000.
- `AUTONOMY_MODEL_SIZE` (`features/autonomy/service.ts`) — autonomy model tier, exactly `small` or `large`; malformed or unset values use `large`.
- Prompt-batcher knobs (all `PROMPT_BATCHER_*`, read in `runtime.ts`): `PROMPT_BATCHER_BATCH_SIZE`, `PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS`, `PROMPT_BATCHER_MAX_SECTIONS_PER_CALL`, `PROMPT_BATCHER_PACKING_DENSITY`, `PROMPT_BATCHER_MAX_TOKENS_PER_CALL`, `PROMPT_BATCHER_MAX_PARALLEL_CALLS`, `PROMPT_BATCHER_MODEL_SEPARATION`.
- `ELIZA_STATE_DIR` — state-dir resolution (`utils/state-dir.ts`); `ELIZA_WORKSPACE_DIR` — workspace folder (`utils/workspace-folder-config.ts`).
- `ELIZA_TRAJECTORY_LOGGING` — canonical trajectory persistence gate for both file and DB recorders (`runtime/trajectory-gate.ts`): truthy enables; non-empty falsey disables; blank is unset. Defaults are on for dev/unset `NODE_ENV`, off for `NODE_ENV=test|production`. `ELIZA_TRAJECTORY_RECORDING` is the legacy alias, and `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` is the hard opt-out.

Prefer the canonical env reader in `utils/read-env.ts` over raw `process.env` (it handles legacy aliases).

### Setting / env resolution — precedence & the multi-tenant rule

Two canonical helpers own all setting/env resolution; everything else delegates:

| Helper | Source order | Use when |
| --- | --- | --- |
| `runtime.getSetting(key)` (`runtime.ts`) | character secrets → character settings → `settings.extra` → `settings.secrets` → `character.env.vars` → the constructor-provided `settings` map. **Never `process.env`.** | Inside the runtime / framework code. |
| `readEnv(key, opts)` (`utils/read-env.ts`) | `process.env[key]` (trimmed; empty string treated as unset) → `defaultValue`. | Reading an env var with no runtime in scope. |
| `resolveSetting(runtime, key, opts)` (`utils/resolve-setting.ts`) | `runtime.getSetting(key)` (coerced to string) → `readEnv(key)` → `defaultValue`. | Single-tenant / headless plugins that still want a dotenv fallback. |

**Resolution order:** runtime/character setting → env alias → default. The
per-agent runtime value always wins; the env fallback is the deployment default.

**WHY core `getSetting()` deliberately does NOT read `process.env`:** in a
multi-tenant process many agents share one OS environment. If `getSetting()`
fell through to `process.env`, a host secret (`OPENAI_API_KEY`,
`POSTGRES_URL`, …) set for the *box* would silently leak into *every* agent,
including ones the operator never granted it to. Keeping `getSetting()`
per-agent makes each agent's config explicit and isolated. `resolveSetting`
re-adds an opt-in env fallback for single-tenant/headless plugins **without**
changing `getSetting()` semantics — multi-tenant hosts that never call it are
unaffected.

**Host obligation (how to make dotenv values visible to `getSetting()`):**
because `getSetting()` reads the constructor-provided `settings` map and not
`process.env`, a host that wants `.env` / `process.env` values honored must fold
them into the runtime's settings at construction. `getBasicCapabilitiesSettings(character, env)`
(`runtime-composition.ts`) does exactly this — it flattens `character.settings`,
`character.secrets`, and `env` into the `Record<string,string>` handed to
adapter factories and the `AgentRuntime` constructor. Construct the runtime with
those settings and dotenv is honored; skip it and only character config is
visible.

## How to extend

- **Add an action/provider/evaluator/service to the built-in bundle:** implement against the `Action`/`Provider`/`Evaluator`/`Service` types in `types/`, then add it to the relevant array in `src/features/basic-capabilities/index.ts` (`basicActions`, `basicProviders`, `basicEvaluators`, `basicServices`). Most new capabilities should live in their own plugin package instead of here.
- **Add a runtime type/contract:** define it under `src/types/<area>.ts` or the owning `src/contracts/` domain and export it through the narrowest stable subpath. Cross-host contracts that do not belong to the runtime live under `@elizaos/shared/contracts`.
- **Add a DB table:** extend the schema in `src/schemas/` and wire it into `buildBaseTables` (`schemas/index.ts`); adapters in plugin-sql/localdb materialize it.
- **Touching the message loop:** the order is provider → model → action → evaluator. Logic lives in `src/runtime/` (`message-handler.ts`, `planner-loop.ts`, `turn-controller.ts`) and `runtime.ts`. Validated model output goes through `runtime/validated-model-call.ts`.
- **Browser/edge surface:** if your code is Node-only (fs, process, native deps), export it from `index.node.ts` only — never add it to `index.browser.ts` / `index.edge.ts`.

## Conventions / gotchas

- `index.node.ts` is the source of truth for the root public surface; narrow contract consumers should prefer `@elizaos/core/contracts/*` subpaths to avoid barrel collisions.
- Three build targets share source — Node-only imports in shared modules break the browser/edge bundles. Verify with `build:node` vs full `build`.
- The model-output contract is `<response>` XML (with `<actions>`/`<providers>`/`<text>`); plain text is tolerated and treated as a `REPLY`.
- Action, provider, and analytics results preserve complete model-facing records. Detailed trust evaluation returns every evidence record, follow-up suggestions return every qualifying contact, relationship analytics page through every shared message, and channel-topic search returns every matching room. Do not silently slice without a lossless page or reference contract.
- Planner action retrieval ranks the complete authorized parent catalog. Stage-1 candidates and `DISCOVER_TOOLS` can load exact operations while advertising the remaining authorized catalog; explicit parent requests load the complete authorized family. Discovery is planner protocol, not completed user work; it never grants permissions or bypasses the executor. Progressive planning resolves registered names and declared aliases; unregistered hints use DISCOVER_TOOLS instead of guessed parent schemas. An entirely unresolved selection starts with discovery. Legacy callers without discovery retain parent-alias fallback. Selected tool, subaction, parameter descriptions and examples remain complete, without character or child-count caps. Coding and deterministic execution retain their existing surface contracts.
- Direct text Stage 1 can project provider-owned `discoveryText` notices. Standing preferences, identity and categorized corrections stay complete inline; `contextRequests` expands named full provider bodies through fresh normal composition before any reply, field processor or planner. Each provider loads once, unknown/repeated requests reject, and cancellation stops further generation. The original provider text and recordings remain complete; voice, coding and group turns retain their existing full context. Context reads may add a handler call: measure total model usage, not just provider character counts. Structured dialogue already replaces the diagnostic RECENT_MESSAGES rendering on the model wire.
- The default direct-text handler may list every authorized routing-context name and defer complete catalog descriptions to `contextRequests=["CONTEXT_CATALOG"]` when that representation is smaller. Reads refresh the role-filtered catalog before dispatch; planning, completion, and provider restoration receive that complete reference under current permissions. Original history and response-field instructions stay complete. Small catalogs, custom optimized prompts, voice/group/coding, and a plugin-owned provider with that name retain the full catalog. Do not treat catalog discovery as authorization or completed app work.
- Foreground planning and completion accept source-bound selections from the existing Stage-1 call for prior user and assistant dialogue. The complete source set is hashed with turn/room identity; malformed, incomplete, unknown or stale selectors keep full context. Select every applicable constraint/correction, factual dependency, referent and referenced unfinished intent. Select referenced assistant proposals, exact IDs, receipts and unfinished work. Preserve current request, standing provider/privacy constraints, semantic patch, pending tool and complete tool receipt. The evaluator can request original sources once without tools or effects. Native-tool planners can request RESTORE_CONTEXT once; no other call in that response executes, and later rounds keep the restored sources. Coding and ordinary schema-only planners keep full context. The dedicated post-tool reply-only round retains source/provider selection and can request RESTORE_CONTEXT through its JSON envelope; the runtime intercepts reads and executes no accompanying effects. Stored history and original in-memory sources remain unchanged; this is model relevance judgment, not proof of semantic completeness. Voice retains the full path. Known action-surface diagnostics may be omitted only from completion with a source marker; unknown/custom fields remain. Canonical tool JSON may drop indentation only after an exact roundtrip check.
- Stage-1 message-handler action and intent hints preserve every ordered string exactly; malformed arrays reject the envelope. PII context assembly likewise preserves repeated candidates, every ordered resolution and retrieval fragment, and exact text. Legacy cap hints are ignored, and malformed Unicode is rejected rather than repaired into different model context.
- Intent instructions, including native schema descriptions, describe pending runtime work, not every conversational outcome. Direct-text Stage 1 may correct a contradictory simple/none reply with nonempty intents once, before field dispatch, including when it names action candidates. A source-bound incomplete history selection may take this repair before automatic full restoration only when no explicit read was requested and all selected originals are already supplied. Stale, malformed, deferred-source and still-incomplete decisions retain full-history restoration. Keep the complete request and previous response in that correction; preserve context discovery, cancellation and stable-prefix accounting. A repeated contradiction still uses the pending-intent guards. Never resolve it by dropping intents or matching the user's prose to a bypass.
- Device-class inference budgets reject unsupported model-output requests before
  dispatch. They may bound queue wait as a resource policy, but must never lower
  `maxTokens` and pass a partial generation off as the requested result.
- `ActionResult.promptData` may replace runtime-only `data` only with explicit `promptDataMode: "replace-data"` as a declared,
  complete model schema; prompt serializers never emit both carriers. Context
  rendering preserves exact whitespace and complete runtime-event fields, and
  content-reference discovery uses cycle-safe complete traversal rather than
  depth or visited-value caps. The final wire preflight owns any explicit
  model-limit rejection.
- Document keyword, vector, and hybrid searches traverse every authorized
  fragment page before ranking. Fragment-query limits are storage batch sizes,
  never recall caps; a repeated page rejects instead of returning a prefix.
- DB mutation methods on `IDatabaseAdapter` return `Promise<boolean>` so callers can distinguish success/failure (`types/database.ts`).
- The task system (`services/task.ts`, `services/task-scheduler.ts`) is the single place scheduled work runs; only tasks tagged `queue` are polled. Three modes: local timer, per-daemon (`startTaskScheduler`), serverless (`{ serverless: true }` + `runDueTasks()`).
- Managed post-turn incremental evaluators preserve complete stored history and process a revision-scoped evidence batch, never a capped transcript. Opt in only with replay-safe processors and preparation that consumes `options.extraction`. Stage validated output before effects; acknowledge progress only after every processor succeeds. Personal-memory citations must resolve to the actual speaker. Initial backfill must not inflate legacy confidence. Source edits/deletions require explicit reconciliation, not silent forgetting. Keep room ordering; a cache receipt is not a transaction or a new background scheduler. Legacy plugin/voice/mobile contracts remain distinct.
- Document reads use `roomId` as the single room entitlement and join it to the requester's current room set inside the adapter. `directGrantEntityIds` is a bounded, validated read exception that remains valid without room membership; it never opens `agent-private` documents and never grants mutation authority. Only the dedicated adapter CAS may replace grants: OWNER on any valid document, or a current room ADMIN on global and user-private documents, with every grantee validated in the current agent tenant. Malformed or duplicate grant arrays make the parent unreadable.
- `runtime.ts` is intentionally large and load-bearing; navigate by symbol and
  ownership boundary rather than reading it top to bottom or adding another
  unrelated responsibility.
- `src/generated/` and parts of `src/i18n/generated/` are build artifacts; regenerate via prebuild rather than editing.
- Repository-wide rules and evidence requirements are inherited from the root
  [`CLAUDE.md`](../../CLAUDE.md).

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For core
changes, additionally capture and inspect:

- a live-model trajectory for any changed provider → model → action → evaluator
  path, including raw model output and every tool result;
- structured logs and the resulting memory, entity, relationship, task,
  trajectory, or database artifacts; and
- both the Node-only build and the full multi-target build whenever a shared
  export or runtime dependency changes.

Post-turn evaluators may provide `resolveOutput` only when their prepared runtime evidence determines the result without model judgment. These sections bypass model prompts, retain normal parse/process/progress handling, and isolate failures. Link extraction uses this after capture; its guarded page summary remains, while the redundant full-room processed acknowledgment is removed. Incremental memory checkpoints and room ordering remain unchanged.

Direct-text provider discovery remains active through planning and completion: explicit provider-owned indexes replace only their complete reference bodies. Stage-1 reads carry forward. RESTORE_CONTEXT or evaluator contextRequest=full recompose through normal permissions before supplying complete bodies; no accompanying effects execute. Current requests, system instructions, standing constraints and current receipts stay inline. Original contexts and recordings remain intact. Full tool family descriptions are retrievable using DISCOVER_TOOLS names=[]; its inline index retains every authorized name.

Always-on response providers bypass context selection only, never role or private-provider gates. The generative UI guide is an ADMIN-authorized discovery reference in Stage 1 and later stages; do not require historical keywords or expose its full syntax before a context read.

Progressive tool discovery must not eagerly refill unrelated context families after exact Stage-1 candidates resolve; other authorized families remain discoverable. Foreground context restoration supports history, providers, or full scope: restore only the requested source class, retain the other projection, and run no accompanying effects. Legacy full reads remain supported.

Stage-1 history may reference byte-identical earlier dialogue text in the same request. Keep every occurrence, source ID, role, speaker, metadata and ordering; prove complete reassembly. Selection and restoration use original full sources. Never normalize differing text or apply a history window. Role-filtered context catalogs omit cache and enforcement metadata while runtime authorization remains unchanged. Experience context contains query matches, not an unconditional high-quality list.

Progressive planners load exact Stage-1 child operations without automatically loading their parents and siblings. Exact child discovery loads only that operation; repeated discovery of an exposed child does not add its parent or siblings. Explicit parent hints in either Stage 1 or DISCOVER_TOOLS still load the complete authorized family; legacy budget fallback retains family expansion. Keep complete schema bodies, compound hints, subsequent parent discovery and canonical permission admission.

Experience ranking prioritizes similarity before quality, preserving the candidate set and embedding-failure fallback; neither ranking nor a low cosine floor proves applicability. Incremental evaluators share common provenance instructions once, but keep revision IDs and exact evidence selections per extractor.

Repeated dialogue references also apply to direct-text planner and evaluator inputs, including restored history. Later stages label only reference occurrences and anchors when the complete encoding is smaller; every original source and occurrence remains recoverable. Default and custom planner prompts share complete canonical policy rules, appending only missing rules.

Successful preparatory DISCOVER_TOOLS calls proceed to requested domain work without completion evaluation. When the current message-service plan explicitly requests catalog inspection and the queue is drained, use the ordinary completion evaluator to judge the entire request against the real catalog read. Discovery never counts as execution of a domain action and never waives pending work or failed effects. Preserve explicit discovery hints through Stage-1 normalization; its later registration is not a missing-action signal.

A successful internal read marked readOnlyOperation may return directly to planning when the planner explicitly declares more work pending and no calls remain queued. Preserve its complete result, prior context and pending scope; this is CONTINUE, never completion or authority to execute a queued action. Failed/unsettled reads, confirmation/input pauses, effect receipts and unresolved failures keep normal evaluation. Record the skipped model call as pending_read_replan; final synthesis/evaluation and action permission checks remain unchanged.

A terminal Stage-1 non_applied reply with no explicit requiresTool returns directly even when candidate tools are named; candidates do not authorize a preview's later effect. Missing replies and explicit tool requirements retain planning. Later registered-action metadata inference also preserves a terminal simple non_applied reply instead of reopening it as coding or domain work. Completed-effect prose detection preserves explicit none and non_applied terminal routes: contradictory wording still fails egress and receives reply-only repair, never a planner call to make the claim true. Explicit applied claims, pending work and legacy missing status retain planning. Exact quotations and previews preserve punctuation, whitespace and line breaks; put explanations outside the literal text. In non-coding plans with declared intents and an answer classified none/non_applied, a proposed terminal reply may reach normal completion evaluation before any tool executes. FINISH can preserve a preview or confirmation question; CONTINUE retains outstanding work. Pending/applied claims, absent answers, coding, receipt grounding and reply-only recovery retain their existing gates.
When Stage 1 names an exposed required tool but classifies a nonempty safe reply as none/non_applied, evaluate that existing draft before the first planner call. FINISH can deliver the preview; CONTINUE retains ordinary planning and action checks. Record the proposal as Stage-1 evidence, never as an invented planner model call. Missing status remains missing through plan normalization and context recording; a parser default is not an explicit no-work decision. Eligibility for pre-execution evaluation must not reuse the direct-answer rescue classifier: conditional confirmation offers may resemble imminent-work prose. A later textless pre-execution REPLY can also propose the existing draft. Preserve evaluator CONTINUE, final-output validation, coding/post-tool paths and the stricter direct-rescue gates.

Discovery preserves the planner's explicit scope; requiring another planning round does not invent a pending declaration. After a valid FINISH was held only for explicit pending scope, an explicitly empty final REPLY may release the unchanged evaluated result without another evaluation. Native prose beside that empty tool call is protocol narration, not a replacement answer. Replacements for existing answers, changed context, unresolved failures, and new work retain normal evaluation; missing-presentation recovery follows the separate proof-bound rule below.

Planner surface construction must retain explicitly requested DISCOVER_TOOLS even when no domain hint resolves or all admitted domain actions are already selected. Do not replace this protocol request with a broad fallback surface. Exact-name discovery still reuses normal capability and permission admission.

Stage-1 source markers use compact [hN] labels; every original message and chronological occurrence remains recoverable. The model schema and selector parser share the source-ID pattern; an empty array is valid but empty or malformed IDs are not. Invalid, unknown and stale selections retain full-context fallback without filtering IDs. The default non-coding post-tool reply-only round uses a settled-result prompt with the complete applicable grounding, reply style, widget, work-claim and error policies. It can restore original context, but cannot execute effects. Custom/optimized prompts retain their supplied instructions and mandatory policies. Ordinary action-planning prompts are unchanged.
Source selection may list each ID once in its most specific category because all categories retain the same complete union; duplicates remain accepted for compatibility. Keep the canonical selection policy once in the stable Stage-1 prefix and the changing source-set binding after history. A complete relevance review need not select unrelated completed tasks; applicable standing constraints, original corrections and current referents remain required. This changes selection guidance only: source validation, the uncapped union and full-context fallback remain unchanged. The static HANDLE_RESPONSE schema includes contextRequests like the production field registry, preserving deferred-provider reads for fallback callers. Live app-record reads, searches and counts do not by themselves require full prior dialogue. Unresolved prior-dialogue dependencies and exhaustive conversation coverage/counting retain full-context fallback; always review and preserve applicable standing constraints and referents.

Client-chat DM model context omits only the host-owned chatIdempotency carrier and metadata.viewClientId. The original Memory remains unchanged for persistence, replay/recovery and executor tab targeting. Preserve all other current-message fields, attachments, reply references, live view state and plugin metadata; other connector/channel contracts retain their complete content.

Stage-1 direct-text history may combine source IDs and roles as [hN user]/[hN assistant] headers with an explicit role legend when the complete encoding is smaller. Every source ID, message byte, speaker, metadata and chronological occurrence must reassemble exactly; same_text_as references retain their original meaning. Group/voice inputs, unbound/unknown roles and missing or mismatched markers keep their original framing. The current-turn boundary stays after all history.

Deterministic navigation reply reuse recognizes the canonical view_navigation delivered receipt as well as legacy accepted effects. A pending navigation draft remains available only after a delivered receipt with a destination, never after mere acceptance or to ordinary pending-work answer rescue. Re-sanitize the registered draft before release. A non_applied pre-execution denial cannot be reused after navigation succeeds; synthesize from the actual receipt. Release only the held model-authored reply after successful execution, destination matching and normal egress checks; empty/generic replies, unrelated mutation claims, failed or unconfirmed navigation retain synthesis/recovery. Other effect families do not inherit navigation's delivered status.

UI_CONTEXT distinguishes opening a view from reading or writing its records and prefers available child actions, matching candidateActionNames. Preserve the exact renderer metadata, capability hints and live-read requirements; navigation never proves a domain operation.

Exact dialogue quotations may use supplied original message text and authors directly. Missing evidence, absent requested source metadata, explicit history searches and exhaustive stored-history coverage retain authorized retrieval; honor user restrictions on lookup. This does not treat prior dialogue as current live-record state or permit invented provenance.

Reminder fallback seeding requires a model-selected scheduling context/candidate or the existing capability-denial recovery condition. Ordinary recall wording alone must not add reminder families to unrelated navigation/read plans. Preserve explicit candidates, owner/group fallback, discovery and execution gates; seeding is not authorization.

Planner-owned LifeOps replies hand complete action-specific facts, character
context and reply rules to the final response model through `data.replyGrounding`.
Only the full message planner grants this ownership for the same message while
its action handler is active. Direct/background callers and withheld result
payloads keep standalone rendering. Deferred replies are internal evidence,
never unavailable status or canned user prose; preserve receipts, clarification
states, permission rechecks, final-context restoration and reply-only recovery.

A structurally confirmed provider context overflow inside an action is a terminal
planner boundary too. Settlement retains non-retryable typed provenance, including
through private-result projection. Record the failed tool before stopping; keep
earlier receipts and complete history. Do not retry changed argument wording
against the same oversized action context or mistake arbitrary error text, schema
errors or rate limits for a context overflow.

The action barrel exports `validateSchema` alongside `validateToolArgs` so plugins
can validate nested structured plans through the same tool schema rules, including
when called directly. Use the public barrel; wildcard deep implementation paths
may have declarations without a corresponding bundled runtime entry.

The shared visible-output boundary rejects raw non-printing control characters in final display text rather than deleting them from damaged prose. Tabs, line breaks, Unicode and escaped JSON data remain valid. Settled effects retain their receipts and existing reply-only recovery; malformed presentation never authorizes effect replay. Within the non-coding planner, a successful internal result with modelReplyRequired uses the same no-tools reply guarantee when its evaluator returns FINISH without a message. Missing presentation alone must not restart action planning; pending-work and failure checks still apply. If a successful FINISH was held for pending scope and lacks a reply, a sole explicitly final REPLY may fill that presentation through the existing reply guarantee after unchanged-evidence and settled-result checks. Require text and effectReceiptIds in that REPLY schema while preserving other tools. Capture the reply and its own selected IDs as plannerReply provenance; never borrow proof selected for different prose or label the planner output as a raw evaluator response. Egress resolves those IDs against current committed receipts and exact text. Existing answers, invalid or missing proof, context restoration, failed/unsettled results and further work retain normal evaluation/recovery.

Provider adapters may render unsupported source-ID pattern constraints as description guidance on the wire. Inspect the actual request before claiming native enforcement; valid ID shape is not proof of correct relevance selection or request coverage.

Incremental preference extraction rejects an entire section when any operation is malformed. Do not acknowledge its evidence or apply a valid subset; the durable worker keeps it pending. Legacy non-incremental callers retain tolerant parsing. Required confidence for inferred traits/directives must be explicit in the model-facing schema and instructions; never invent a missing confidence value.

Personal fact/preference extraction keeps supplied same-room agent messages as reference dependencies when narrowing to the user-authored citations. This includes complete selected-batch context, not a claim that every agent message is semantically relevant. Other participants cannot become personal citations. Preference facts register the existing fact reconciliation hook independently; editing/deleting supporting agent dialogue retires derived claims synchronously and leaves re-extraction durable, with no new foreground inference. Historical explicit-reference behavior and protected user-authored records remain unchanged.

An explicitly registered historyRetention evaluator may index complete original dialogue through the existing incremental post-turn worker. It retains original standing constraints, corrections, permissions, unresolved work and their dependencies; other reviewed originals remain readable through Stage-1 contextRequests using history:hN or history:all. This is model judgment, not a guarantee of semantic completeness. No summaries, source edits, recency caps or new scheduler are permitted. A direct-text foreground projection requires a committed checkpoint matching the current agent, room, requester, role and complete source prefix. Missing, malformed, edited, deleted or stale sources preserve full authorized history. New sources and the current exchange remain inline. Unseen selected sources, unresolved interpretation and exhaustive recall require original reads before draft-field processing or effects. Recompose through current authorization on reads; group, voice and coding paths remain complete. The evaluator is registered by the optional advanced-memory plugin, not the default basic bundle. Its worker accepts direct-text DM/API/SELF sources only (legacy sources use the authoritative room type); group and voice sources stay excluded. Preserve full-context fallback during cold review and record initial-review quota separately from foreground replies.

While reviewed history is projected, Stage 1 selects supplied originals with `relevant_prior_dialogue` and requests more history through `contextRequests`, including `history:all`. Incomplete selections and legacy full-mode outputs still restore originals safely. Full restoration reinstates the normal model schema and history policy; no read decision executes a draft or effect.

Incremental evaluators may return derived progressState through a pure, replay-safe hook after their processors succeed. Commit that state together with the existing completed-revision watermark, never through a separate checkpoint write. Pending raw model output is not committed derived state. Source reconciliation invalidates derived state and uses the existing ordered evidence journal for reprocessing; a failed write must remain replayable without another model call.

New preference model outputs must declare applicability scope. Only across-conversation preferences may alter persistent personality or preference facts; conversation/task/uncertain instructions remain in their original dialogue. The evaluator service identifies fresh model output versus staged replay for parsing: enforce scope on fresh output even when a provider ignores its wire schema, while preserving previously staged output and its replay IDs. Saved per-user style participates in Stage 1 under the existing role gate. Existing Stage-1 facts/relationships are a positive post-turn semantic signal; the lexical shortcut must not discard them or add another classifier call.

An explicit DISCOVER_TOOLS names=[] read refreshes the complete registered catalog through canonical candidate admission, including each candidate's declared contexts, instead of treating Stage 1 routing as a permanent discovery boundary. Role, privacy, context, account-policy and availability checks remain active. This read returns authorized descriptions and child names without loading schemas or executing domain work; exact-name requests still load only their selected operations.

Nested planners expose one native schema per canonical child action, matching the top-level planner. Similes remain runtime aliases: resolve only against already-gated sub-planner child events whose canonical name is on the exposed tool surface, before availability and replay checks. Never consult global or excluded actions for alias admission, and retain canonical-name precedence. Complete child schemas, source context, executor gates, receipts and reply recovery remain unchanged. Do not clone full native schemas under each simile.

Delivered navigation reply reuse may match the canonical viewId carried by the same structured receipt as well as its display label. Canonical-ID matching requires complete normalized words and delivered status; never infer aliases from request text or weaken destination, egress, pending/denial, authorization or reply-only recovery gates.

Structured failure replies may reuse exact-repeat dialogue references over the RECENT_MESSAGES provider's complete formatted entries. Require exact reconstruction of the legacy transcript before encoding; custom or mismatched states keep the complete string. Retain every occurrence, timestamp, speaker, thought, action and attachment field already present in that transcript. Small histories keep their original rendering. This path does not select history, read deferred sources, change failure classification or replay effects.

When direct-text context discovery has no projected history, native contextRequests choices match every currently available provider/catalog reference. With no deferred references the field is exactly []; this is an availability contract, not a history or output-length cap. Rebuild it after each authorized read so loaded references cannot be requested again. Literal history search retains its open schema while the source-bound projection exists. Custom non-string/whole-array-enum field contracts, group/voice/coding paths and runtime validation remain unchanged.
