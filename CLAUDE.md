# elizaOS repository guide

This monorepo contains the elizaOS agent framework and the product stack built
on it: the core runtime, standalone agent host, Eliza application, CLI, cloud
services, native bridges, documentation, tests, and first-party plugins.
Bootable Linux and AOSP distributions are maintained separately in
[`elizaOS/os`](https://github.com/elizaOS/os).

## How repository instructions work

- Read this guide before changing the repository.
- Before working in a package or plugin, read the nearest `CLAUDE.md` and its
  `README.md`. A local guide adds package-specific architecture, commands, and
  validation requirements; repository-wide rules in this guide remain binding.
- `CLAUDE.md` and `AGENTS.md` in the same directory must be byte-for-byte
  identical. Author `CLAUDE.md`, copy the finished content to `AGENTS.md`, and
  run `bun run check:agents-claude`.
- The `AGENTS.md` files under
  `packages/elizaos/src/migrate/__tests__/fixtures/` are migration inputs, not
  repository instructions. They are intentionally unpaired and must change only
  when the corresponding migration fixture changes.
- Treat package manifests, exports, executable scripts, tests, and current
  source as the factual authority. Documentation is a map, not evidence that a
  feature still exists.

## Naming

Write **elizaOS**, never `ElizaOS`. The npm scope is `@elizaos/*`. Use
**Eliza agents** for agents built with the framework. The **Eliza Classic**
plugin is the deliberate exception because it reimplements the 1966 chatbot.

## Before editing

1. Run `git status --short --branch`. This is a shared working tree and existing
   changes belong to their authors; do not discard, rewrite, or stage unrelated
   work.
2. Identify the owning workspace and read its local guide, README, manifest,
   exports, and relevant tests.
3. Search for callers and contract tests before changing a public type, route,
   event, environment variable, script, or package export.
4. Use the narrowest relevant command while iterating, then run the required
   package and repository gates before declaring the work complete.

## Toolchain

- **Runtime:** Bun `1.3.14` and Node `24.15.0` are pinned in `package.json`.
  Use the pinned versions; do not silently substitute npm, pnpm, Yarn, or an
  older Node runtime.
- **Modules:** ESM only (`"type": "module"`). Do not introduce CommonJS.
- **Workspace orchestration:** Turbo drives package `build`, `typecheck`,
  `lint`, and test tasks. Workspace globs are defined in `package.json`.
- **TypeScript:** the repository uses project references through root and
  package `tsconfig` files.
- **Formatting and linting:** Biome is pinned by the repository. Configuration
  lives in `biome.json` and exclusions in `.biomeignore`.
- **Tests:** Vitest is the primary runner; repository lanes are orchestrated by
  `packages/scripts/run-all-tests.mjs`.

## Root commands

```bash
bun install            # install workspaces, prepare submodules, patches, and fused inference
bun run install:light  # alias of bun install
bun run dev            # start the API and Eliza app development UI
bun run start          # start the standalone agent host
bun run build          # build the workspace through Turbo
bun run verify         # parity, dependency, type, lint, and repository audit gates
bun run lint           # workspace lint tasks
bun run format         # workspace formatting tasks
bun run typecheck      # workspace TypeScript checks
bun run test           # repository unit and integration lane
bun run test:server    # server package lane
bun run test:client    # client package lane
bun run test:e2e       # end-to-end lane
bun run cloud:mock     # start the local cloud stack with mocks
bun run clean          # remove generated build, cache, install, and local-state output
bun run reset          # clean, reinstall, and rebuild
```

Run `bun run` with no arguments for the live script inventory. Scope a package
command with `bun run --cwd <workspace> <script>`, for example:

```bash
bun run --cwd packages/core test
bun run --cwd plugins/plugin-browser typecheck
```

### Shared app development server

Use the normal `bun run dev` flow for a single checkout. Concurrent worktrees
must not all bind the default app port. From `packages/app` use:

```bash
bun run dev:shared   # start or reuse this worktree's deterministic Vite port
bun run dev:status   # list registered shared servers
bun run dev:rebuild  # request a full Vite reload for this worktree
```

Reservations live in `~/.eliza/dev-server-registry.json` and may be redirected
with `ELIZA_DEV_SERVER_REGISTRY`. See
[`packages/docs/development/shared-dev-server.md`](packages/docs/development/shared-dev-server.md).

### Removed root command migrations

| Removed command | Use instead |
| --- | --- |
| `bun run test:ci` | `bun run test` |
| `bun run sync:artifacts` | `bun run fetch:archive-artifacts` (explicit opt-in; never runs on install) |
| `bun run test:cloud:playwright` | `bun run --cwd packages/app test:e2e` |
| `bun run test:ui:playwright` | `bun run --cwd packages/app test:e2e` |
| `bun run test:lifeops` | `bun run test:plugin 'plugin-personal-assistant'` |
| `bun run trajectory:inspect:test` | `bun test packages/scripts/__tests__/trajectory-validate.test.ts` |
| `bun run audit:e2e-coverage:test` | retired with the historical coverage baseline; use the diagnostic coverage report |
| `bun run test:browser-bridge` | `bun run --cwd packages/browser-bridge-extension test:smoke:installed` (requires installed browsers) |
| `bun run test:browser-bridge:safari` | `bun run --cwd packages/browser-bridge-extension test:smoke:safari` (requires installed Safari) |
| `bun run voice:latency-report` | `bun run --cwd packages/app-core voice:latency-report` |
| `bun run voice:interactive` | `bun run --cwd packages/app-core voice:interactive` |
| `bun run voice:duet` | `bun run --cwd packages/app-core voice:duet` |
| `bun run voice:create-profile` | `bun run --cwd packages/app-core voice:create-profile` |
| `bun run test:ci:live` | `bun run test:live` |
| `bun run test:lint:no-vi-mocks` | `bun run audit:test-integrity:no-vi-mocks` |
| `bun run lint:all` | `bun run verify` |
| `bun run build:typescript` | `node packages/scripts/run-turbo.mjs run build` |
| `bun run audit:mvp-board` | `bun run mvp:closeout-audit` |
| `bun run mvp:board-readiness` | `bun run mvp:closeout-audit` |
| `bun run mvp:evidence-matrix` | `bun run mvp:closeout-audit` |

## Repository map

```text
packages/
  core/             @elizaos/core: AgentRuntime, contracts, message loop, memory, models
  agent/            @elizaos/agent: standalone runtime assembly and HTTP backend
  app-core/         shared application host, APIs, startup, build, and platform tooling
  app/              Eliza web, desktop, and mobile UI application
  auth/             shared account credentials, OAuth, subscription, and refresh logic
  ui/               shared React primitives and product surfaces
  elizaos/          the elizaos CLI and packaged project/plugin templates
  prompts/          shared prompt templates across supported languages
  shared/           cross-package utilities, contracts, and brand assets
  logger/           structured logging package
  vault/            secrets and configuration storage adapters
  skills/           bundled runtime skills and loading utilities
  browser-bridge-extension/ Chrome MV3, Firefox, and Safari companion browser extension
  registry/         first-party and community plugin registry data and validation
  scenario-runner/  real-runtime scenario execution and report generation
  test/             repository-wide scenarios and test corpus
  evidence/         evidence manifest, bundle, verification, and ingestion foundation
  docs/             documentation site source
  homepage/         public Eliza product and download site
  training/         Eliza-1 training, evaluation, conversion, and release tooling
  cloud/            API, shared libraries, routing, SDK, infrastructure, tests, services
  native/           native runtimes, third-party dependencies, and C/C++ plugins

plugins/
  plugin-<provider>/ model and inference providers
  plugin-<channel>/  messaging and workspace connectors
  plugin-native-*/   platform and device bridges
  plugin-*/          domain capabilities, app views, storage, tools, and orchestration

scripts/            repository-wide checks, CI helpers, evidence, security, and release tools
patches/            dependency patches applied during installation
```

Some directories are organizational roots rather than npm workspaces. Use the
nearest manifest and local guide instead of inferring ownership from directory
depth.

## Runtime architecture

- `@elizaos/core` owns `AgentRuntime`, the canonical public types, the plugin
  contract, the message loop, model abstraction, memory/state primitives, and
  framework services.
- `@elizaos/agent` assembles a runnable backend around core. It owns the
  standalone process, plugin loading policy, HTTP/WebSocket surfaces, and
  host-level services.
- `@elizaos/app-core` hosts Eliza application targets and their compatibility
  APIs, startup flow, platform integration, and build orchestration.
- `@elizaos/app` and `@elizaos/ui` render product state. Business values belong
  in use-cases and DTOs, not recomputed in view or proxy layers.
- A plugin normally exports a `Plugin` from `src/index.ts`. Plugins may
  contribute actions, providers, evaluators, services, model handlers, routes,
  events, tests, and app views.
- The `elizaos` CLI is package-first. Its templates under
  `packages/elizaos/templates/` are governed by their `SCAFFOLD.md` contracts.

When code needs only the framework, depend on `@elizaos/core`. Do not depend on
an application host to reach a core abstraction.

## Engineering conventions

### Prompt integrity: never discard model context

Prompt construction, provider output, action/tool results, conversation
history, evaluator input, and model output must remain complete. Never use a
character/token cap, prefix or suffix slice, item-count limit, rolling buffer,
summary, compaction, or "most recent" window to make model-facing content fit.
Large supported contexts are a product capability; silently changing them
creates non-local reasoning failures that are much harder to diagnose than an
explicit error.

Planning and post-tool completion share an explicit source-selection contract.
The existing Stage-1 model may select prior user and assistant dialogue by source IDs after
checking every source for relevant facts, all applicable standing constraints
and corrections, referents and referenced pending work. Bind the selector to
the exact turn, room, source identities and source bytes; absent, malformed,
incomplete or stale selectors keep full context. Never select away the current
request, system instructions, standing provider constraints (including recomposed privacy results),
semantic patches, execution feedback, pending tools or any
tool receipt. The evaluator can request the complete original context once
without tools or delivery effects. Native-tool planners can request
RESTORE_CONTEXT once before uncertain effects; no call from that response
executes, and all later planner rounds retain the restored sources. Coding
and schema-only planners retain full context. Full stored history and the original in-memory context stay
intact; source selection is a model judgment, not a deterministic proof of
semantic completeness. No new factual summary, character/token cap or recency
window is authorized by this contract. Voice retains its complete path.

The evaluator may also omit known message-service `plan.actionSurface`
retrieval diagnostics with the source event/omitted field recorded. Unknown
fields and custom producers retain the complete representation. Canonical tool
JSON may omit indentation only after an exact roundtrip check; every field and
string value remains complete. Training and trajectory recordings retain the
actual wire request, including its selection and retrieval attempts.

Training and evaluation have the same invariant: teacher prompts, recorded
requests/responses, and tokenizer inputs must not be compacted or truncated.
A trainer with a smaller sequence boundary must reject the complete row before
training; it must never teach from a prefix or suffix that was not the recorded
model call.

When an external model, platform, parser, transport, or resource boundary has
a real hard limit, preserve one of these contracts instead:

- reject before dispatch with a typed, actionable size error and no partial
  payload;
- split into lossless, ordered chunks and prove reassembly in tests; or
- paginate only when the caller explicitly requested that pagination and the
  model receives the continuation contract.

UI previews, log summaries, cryptographic abbreviations, and protocol fields
with externally mandated limits may be bounded only when the complete value is
not later presented as model context. Name these surfaces as previews or
summaries, never as the underlying value. Any change that introduces a cap or
uses `truncate`, `slice`, `substring`, `maxChars`, `maxTokens`, or an item limit
near a prompt/provider/action-result path must include a regression test proving
that content is either complete, losslessly reassembled, or explicitly
rejected. Do not reintroduce conversation compaction or `/compact`.

- Use the structured logger in server/runtime code; never use `console` there.
  Prefix human-readable messages with the owning class or subsystem and attach
  structured context to errors.
- Keep boundary types explicit. Validate untrusted input once, then use the
  validated type. Avoid `any`, broad `unknown`, unchecked casts, and optional
  chaining that hides a required collaborator.
- DTO fields are required by default. If the producer failed to load a value,
  represent that as an error or explicit unavailable state rather than a
  healthy-looking zero, empty string, or empty collection.
- Route, proxy, and compatibility layers translate protocols. Business
  computation belongs in domain services or use-cases, and clients render the
  resulting DTO.
- Preserve public compatibility deliberately. Search exports, consumers,
  templates, generated registry data, and contract tests before changing a
  public surface.

## Error policy: fail fast inside, handle at boundaries

Inner data paths throw typed errors. A designated process, transport, or UI
boundary may translate the failure into a structured response or a visibly
distinct error/unavailable state. Do not catch and continue with fabricated
success.

New or rewritten domain failures use `ElizaError` from
`packages/core/src/errors.ts` with an actionable `code`, relevant `context`, a
`cause` when wrapping, and severity when appropriate. Diagnostic failures in
providers, services, background jobs, and event handlers call
`runtime.reportError(scope, error, context?)`; the runtime logs them, emits
`EventType.ERROR_REPORTED`, exposes them through `RECENT_ERRORS`, and supports
owner escalation. Action/tool failures already return to the planner path.

Every retained catch must document one of these grep-able categories on the
handler with `// error-policy:J<N> <reason>`:

- **J1 — boundary translation:** the outer process or transport boundary
  returns a structured failure.
- **J2 — context-adding rethrow:** wrap with a typed error and preserve `cause`.
- **J3 — untrusted-input sanitizing:** parsing produces an explicit invalid
  result, never a fake-valid default.
- **J4 — user-facing degrade:** only an expected error shape becomes a visibly
  distinct unavailable/error state.
- **J5 — unhandled-rejection suppression:** the comment names where the same
  rejection is observed.
- **J6 — best-effort teardown:** teardown-only failure is logged at debug/warn.
- **J7 — diagnostics must not kill the loop:** telemetry/trajectory failure is
  warned and reported through `runtime.reportError`.

Empty catches, `.catch(() => {})`, log-and-continue data paths, default returns
from catches, and `?? <literal>` used to disguise missing required data are not
valid recovery. In UI code, loading, designed-empty, and error are three
different states. The established examples are
`packages/ui/src/components/pages/StreamView.tsx` and
`packages/ui/src/state/usePluginsSkillsState.ts`.

## File headers and comments

Every maintained source file begins with one prose `/** ... */` header after a
shebang or third-party license block and before imports. The first sentence
states the file's system responsibility without repeating its filename. Add
only the context a reader cannot infer from the code: consumers, inputs,
invariants, protocol constraints, ownership boundaries, and non-obvious
consequences.

- Tiny barrels and type files usually need one line; ordinary modules need two
  to six; load-bearing modules may use two or three short paragraphs. Keep the
  header under roughly 25 lines.
- Test headers state the surface under test and whether the harness is real,
  integration-backed, deterministic, or mocked.
- Exported-symbol JSDoc serves callers. In-body `//` comments explain why a
  design or ordering constraint exists.
- Delete code narration, change history, migration stories, status notes,
  commented-out code, and comments that merely restate the next statement.
- Never edit generated files or third-party license text as part of comment
  cleanup.

Use these tone references:

- `packages/agent/src/api/media-store.ts`
- `packages/ui/src/components/RoleGate.tsx`
- `packages/scripts/run-all-tests.mjs`
- `.gitmodules`

Comment-only work must pass `bun run check:comment-only`, which verifies that
the code token stream is unchanged.

## Cross-package invariants

### Scheduling and personal-assistant domains

There is one clock and one scheduled-item architecture. Core `TaskService`
owns when work runs. `@elizaos/plugin-scheduling` owns the storage-agnostic
`ScheduledTask` state machine and runner. Personal-assistant and health domains
contribute structural records and registries; they do not create competing
schedulers.

Behavior must branch on typed fields such as `kind`, `trigger`, `shouldFire`,
`completionCheck`, and `pipeline`, never on prose in `promptInstructions`.
Connector delivery returns typed `DispatchResult`, not a boolean. Identity and
relationship changes go through the shared `EntityStore`, `RelationshipStore`,
and merge engine. The authoritative implementation and contribution contracts
are in:

- `plugins/plugin-scheduling/README.md`
- `plugins/plugin-personal-assistant/README.md`
- `plugins/plugin-health/README.md`
- `plugins/plugin-relationships/README.md`

### Attachments and media

Attachment bytes use the single content-addressed store in
`packages/agent/src/api/media-store.ts`:
`${STATE_DIR}/media/<sha256>.<ext>`, served from
`/api/media/<sha256>.<ext>`. The SHA-256 URL is the canonical deduplicated
capability handle; `Media` in `packages/core/src/types/primitives.ts` is the
in-message reference and may only be widened additively.

Do not add a second file store, a storage selector, a `files` table, reference
counting, a second garbage collector, or a `fileId` field on `Media`. The
existing store uses `gcUnreferencedMedia` with a grace window. Server-side
attachment fetches must pass through the SSRF guard in
`packages/core/src/network` and `packages/core/src/media/fetch.ts`. The
pre-authenticated read route must not rewrite or rehost bytes; authenticated
writes may rehost. `ContentType` is frozen and append-only, so derive finer
kinds from `mimeType` at read time.

## Testing and verification

Run focused checks while iterating, then expand in proportion to the affected
surface. At minimum, documentation changes must pass guide parity and link/path
validation; code changes must pass the owning package's tests, typecheck, and
lint plus the root `bun run verify` gate.

Tests must exercise the real contract being changed. Cover error, empty,
invalid-input, concurrency, authorization, and adversarial paths where they are
meaningful. A mock or stub standing in for the system under test is useful for
unit coverage but is not end-to-end proof.

Apply the [issue and test quality gate](CONTRIBUTING.md#issue-and-test-quality-gate):
coverage alone does not justify an issue or test. Findings must identify an
observable defect or missing capability and its affected consumer. Tests must
exercise that contract rather than mirror implementation literals, inspect
exports or metadata, or assert a mock that replaces the system under test.
Retain externally versioned wire, security, migration, and generated-artifact
checks when they validate the actual boundary. Remove or replace redundant
tests; a test-only PR must explain the regression it prevents and why existing
higher-level coverage does not own it.

### Evidence bundles and review

The normal evidence path is bundle-first. `bun run test:matrix:review` executes
the named producers after hashing their pre-run inventory, creates one
`evidence/runs/<run-id>/` bundle from only new or written/replaced artifacts, runs the
canonical integrity verifier, and reviews that exact run. Standalone
`bun run evidence:review:no-open` selects the newest finalized bundle;
`--bundle=evidence/runs/<run-id>` pins a specific one. Raw producer directories
are never scanned implicitly. `--source=<dir>` is only for deliberate archived
or ad-hoc compatibility review.

`packages/evidence/src/ingest.ts` is the normal producer inventory. A new or
moved producer must have a named ingestor, producer-to-bundle regression test,
and real generated-bundle inspection. Do not add another scan-root list or let
a coordinated command discover its run by recency.

### App visual review

Any change in `packages/app`, or a shared UI change that reaches it, must run:

```bash
bun run --cwd packages/app audit:app
```

Review every affected desktop and mobile capture, including rest and hover
states. No touched view may retain a computed `needs-work` or `broken` verdict.
Run at least five audit/inspection/iteration cycles for a meaningful redesign.
Orange is the accent; do not introduce blue, and use darker orange—not black—
for an orange resting control's hover state. The full visual contract lives in
`packages/app/CLAUDE.md`.

## GitHub workflow and definition of done

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before claiming coordinated work or
opening a pull request; its issue, coordination, evidence, and merge rules apply.

- Open an issue for a concrete finding before a non-trivial change.
- Use a `feat/`, `fix/`, `docs/`, or `chore/` branch and target `develop`.
- Before opening or updating a PR, fetch and rebase on `origin/develop`, resolve
  conflicts, run `bun install`, and run `bun run verify`.
- Ship through a PR; never push feature or fix work directly to `develop`.
- Do not move a Project card to `Done` without the board's explicit authority.
- Deliver working capability with no TODO, stub, fabricated success, or
  undocumented follow-up in scope.

Exercise the real path and inspect its result yourself. Follow the
[contribution evidence requirements](CONTRIBUTING.md#evidence) for live-model
trajectories, integrations, desktop/mobile captures, recordings, and logs.
Build and install the current revision before capture, inspect every artifact,
and attach evidence inline in the issue and PR rather than committing it.
Mark inapplicable evidence `N/A` with a reason. Green automation alone does not
prove the observed behavior.

## Security and contribution references

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/elizaOS/eliza/security/advisories/new).
Do not place exploit details, secrets, or embargoed dependency information in a
public issue, PR, log, or agent transcript. Product security documentation is
in [`packages/docs/security.md`](packages/docs/security.md).

The repository is MIT licensed. Contribution workflow and evidence policy live
in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Post-turn evaluators may provide `resolveOutput` only when their prepared runtime evidence determines the result without model judgment. These sections bypass model prompts, retain normal parse/process/progress handling, and isolate failures. Link extraction uses this after capture; its guarded page summary remains, while the redundant full-room processed acknowledgment is removed. Incremental memory checkpoints and room ordering remain unchanged.

Direct-text provider discovery remains active through planning and completion: explicit provider-owned indexes replace only their complete reference bodies. Stage-1 reads carry forward. RESTORE_CONTEXT or evaluator contextRequest=full recompose through normal permissions before supplying complete bodies; no accompanying effects execute. Current requests, system instructions, standing constraints and current receipts stay inline. Original contexts and recordings remain intact. Full tool family descriptions are retrievable using DISCOVER_TOOLS names=[]; its inline index retains every authorized name.

Progressive tool discovery must not eagerly refill unrelated context families after exact Stage-1 candidates resolve; other authorized families remain discoverable. Foreground context restoration supports history, providers, or full scope: restore only the requested source class, retain the other projection, and run no accompanying effects. Legacy full reads remain supported.
