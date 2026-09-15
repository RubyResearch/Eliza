# @elizaos/plugin-app-control

Gives an Eliza agent control over app lifecycle, shell views, backgrounds,
models, active agent profiles, and built-in settings.

## Purpose / role

This opt-in plugin registers its app and view actions, one pre-planner navigation evaluator and a Stage-1 visual-continuation field,
no natural-language shortcuts, three providers,
and four services. Dashboard operations use authenticated
loopback HTTP (`/api/apps/*`, `/api/views/*`) discovered through the existing
port resolver.

## Plugin surface

### Actions

| Name | File | Description |
|---|---|---|
| `APP` | `src/actions/app.ts` | Unified app control. Sub-modes: `launch`, `relaunch`, `stop`, `load_from_directory`, `list`, `create`. `stop` uses the canonical name-based `/api/apps/stop` route without uninstalling or relaunching. `create` runs a multi-turn scaffold+coding-agent flow. Owner-gated. |
| `VIEWS` | `src/actions/views.ts` | Manage UI views contributed by plugins. Sub-modes: `list`, `current`, `show`/`open`, `search`, `manager`, `broadcast`, `interact`, `pin`, `window`, `create`, `edit`, `icon`, `rollback`, `delete`/`remove`. `show`/`open` return an internal navigation receipt and explicitly require post-tool evaluation so the model writes the visible reply after the shell handoff. Create/edit/icon/rollback/delete are owner-gated; read modes are open. `rollback` resets a created/edited view-or-plugin workdir to the pre-edit git snapshot taken before the coding agent ran (#8915) and re-registers it via `load-from-directory`. |
| `VIEWS_SHOW` | `src/actions/views.ts` | Narrow single-destination navigation with required `view` and `navigationStepId`. Delegates to the same VIEWS handler, authorization, cancellation and originating-client receipt path. Full VIEWS remains discoverable for layouts and other operations. |
| `BACKGROUND` | `src/actions/background.ts` | Change the unified app background from chat. Ops: `set` (color name/hex, a named **programmable GLSL shader** preset — `aurora`/`lava`/`plasma`/`waves`/`nebula` — plus relative uniform tweaks like *slower*/*brighter*/*bigger* (#10694), an uploaded image attachment, or a generated image from a prompt), `undo`, `redo`, `reset`. The action names a preset id + uniform patch only; the GLSL source lives in `@elizaos/ui` (`backgrounds/shader-presets.ts`) where `useBackgroundApplyChannel` resolves id→source, validates it, and `ProgrammableShaderBackground` renders it via three.js with a compile-validate + frame-watchdog + context-loss-recovery + reduced-motion + color-field fallback. Broadcasts a `background:apply` view event via `POST /api/views/events/broadcast`; the renderer applies it to the shared `BackgroundConfig` store. Drives the SAME background as the `/background` view — there is no separate homescreen-scene surface. |
| `SETTINGS` | `src/actions/settings.ts` | Describe, list, and change built-in settings; mutations use the same semantic routes as the UI. Successful list/set results own canonical reply text and declare a single-operation turn complete once the plan queue is drained, avoiding a redundant evaluator model call on native function-calling backends without suppressing multi-tool evaluation. Owner-gated. |
| `MODEL_SWITCH` | `src/actions/model-switch.ts` | Select a configured model target through the canonical settings/runtime boundary. |
| `AGENT_SWITCH` | `src/actions/agent-switch.ts` | Switch the active agent profile through the host-provided agent-switch seam. |
| `RUNTIMES` | `src/actions/runtime-management.ts` | Owner-gated Devices & Runtimes lifecycle, pairing, revoke, relay, and fingerprint-pinned SSH operations. Mutations require confirmation; secrets stay in the local UI/native credential store. |
| `CLOSE_VIEW` / `CLOSE_ALL_VIEWS` | `src/actions/views.ts` | Close one shell view or all open views without overloading the broader `VIEWS` dispatcher. |

### Evaluators

| Name | File | Description |
|---|---|---|
| `viewContextPlanningEvaluator` | `src/evaluators/view-context-planning.ts` | Selects an authorized live-catalog destination before planning without removing domain work; the same action queue owns navigation and receipts. |
| `viewContextEvaluator` | `src/evaluators/view-context.ts` | Legacy compatibility export only; not registered as a post-response navigator. |
| `viewCommandShortcutEvaluator` | `src/evaluators/view-command-shortcut.ts` | Compatibility export only; not registered by the first-party plugin. |
| `createChoiceShortcutEvaluator` | `src/evaluators/create-choice-shortcut.ts` | Compatibility export only; pending choices reach model context through `app_control_choices`. |
| `viewFollowupRoutingEvaluator` | `src/evaluators/view-followup-routing.ts` | Compatibility export for downstream users; the first-party plugin leaves focused-view mutation follow-ups to Stage 1 and the planner. |

### Shortcuts

| Name | File | Description |
|---|---|---|
| `viewNavigationShortcuts` | `src/shortcuts.ts` | Compatibility export for downstream users; `appControlPlugin` does not register these natural-language shortcuts ahead of the model. |

### Providers

| Name | File | Description |
|---|---|---|
| `available_apps` | `src/providers/available-apps.ts` | Injects installed apps + running run counts into planner context. Active in `settings` and `automation` contexts only; cache scope is per-turn. |
| `current_view` | `src/providers/current-view.ts` | Supplies current shell-view context and acknowledgement state for navigation turns. |
| `app_control_choices` | `src/providers/pending-choices.ts` | Owner-private, uncached-per-turn pending app/view/model choices, available before Stage 1 and planner selection. Empty when no choice exists; never dispatches from user text. |

### Services

| Name | Service type constant | File | Description |
|---|---|---|---|
| `AppRegistryService` | `APP_REGISTRY_SERVICE_TYPE = "app-registry"` | `src/services/app-registry-service.ts` | Persists `load_from_directory` registrations; re-registers them on boot. Also owns app-loads audit log and granted-permissions store under `~/.eliza/` (or `ELIZA_STATE_DIR`). |
| `AppVerificationService` | `"app-verification"` | `src/services/app-verification.ts` | Structured verification pipeline (typecheck / lint / test / build / launch / browser screenshot). Called after `APP create` or `VIEWS create` once the coding agent finishes. |
| `AppWorkerHostService` | `APP_WORKER_HOST_SERVICE_TYPE = "app-worker-host"` | `src/services/app-worker-host-service.ts` | Spawns one `node:worker_threads` Worker per app registered with `isolation: "worker"`. Exposes typed RPC (`invoke(slug, method, params)`). |
| `VerificationRoomBridgeService` | `VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE = "verification-room-bridge"` | `src/services/verification-room-bridge.ts` | Listens to the swarm coordinator broadcast bus; posts verification results back into the originating chat room so the user sees the verdict. |

### Views (registered in Plugin.views)

| ID | Label | Path | Bundle component |
|---|---|---|---|
| `views-manager` | Views | `/views` | `ViewManagerView` (gui) |

View source lives in `src/views/ViewManagerView.tsx`. Bundled separately by `vite.config.views.ts` into `dist/views/bundle.js`. The `viewType` contract still accepts future modality entries, but this plugin ships only the GUI declaration today.

## Layout

```
src/
  index.ts                        Plugin entry; exports appControlPlugin
  types.ts                        API response shapes (InstalledAppInfo, AppRunSummary, AppLaunchResult, AppStopResult)
  shortcuts.ts                    Compatibility natural-language shortcut definitions; not registered by the plugin
  params.ts                       Option normalisation + verb/noun extraction helpers
  resolve.ts                      App/run name resolution (exact + substring match)
  protected-apps.ts               List of built-in apps that cannot be deleted
  client/
    api.ts                        AppControlClient — loopback HTTP to /api/apps/*
  actions/
    app.ts                        APP action dispatcher; imports sub-handlers below
    app-launch.ts                 launch sub-handler
    app-relaunch.ts               relaunch sub-handler (stop + launch, optional verify)
    app-stop.ts                   stop sub-handler (canonical name/run route, no relaunch)
    app-list.ts                   list sub-handler
    app-load-from-directory.ts    load_from_directory sub-handler
    app-create.ts                 create sub-handler (multi-turn scaffold + coding agent)
    scaffold-env.ts               shared template/plugins-dir resolution + coding-dispatch preflight for the create flows
    background.ts                 BACKGROUND action (set color/shader-preset/image/generate, tweak, undo, redo, reset)
    settings.ts                   SETTINGS action (list/get/set built-in settings)
    views.ts                      VIEWS action dispatcher
    views-client.ts               ViewsClient — loopback HTTP to /api/views/*
    views-request-auth.ts         Alias-aware Bearer headers for authenticated view loopback requests
    views-list.ts                 list sub-handler
    views-show.ts                 show/open sub-handler
    views-search.ts               search sub-handler
    views-create.ts               create sub-handler (multi-turn)
    views-edit.ts                 edit sub-handler (takes a pre-edit git snapshot)
    views-icon.ts                 icon sub-handler (direct hero-asset regeneration)
    views-rollback.ts             rollback sub-handler: git reset --hard <snapshot> + re-register (#8915)
    views-snapshot.ts             pre-edit git snapshot + rollback helpers; snapshot-record persistence
    views-plugin-source.ts        resolve a view's on-disk plugin source dir
    views-delete.ts               delete sub-handler + confirmation flow
  components/
    ViewManagerSpatialView.tsx    Presentational spatial view-manager component
  evaluators/
    view-context.ts               legacy post-response compatibility export
    view-context-planning.ts      live-catalog in-turn contextual selection
    view-command-shortcut.ts      deterministic explicit-command routing
    create-choice-shortcut.ts     pending create-choice routing
    view-followup-routing.ts      compatibility mutation-follow-up evaluator; not registered by the plugin
  providers/
    available-apps.ts             available_apps provider
    current-view.ts               current_view provider
  services/
    app-registry-service.ts       AppRegistryService
    app-verification.ts           AppVerificationService (typecheck/lint/test/build/browser)
    app-worker-host-service.ts    AppWorkerHostService (worker_threads lifecycle + RPC)
    verification-room-bridge.ts   VerificationRoomBridgeService (chat-loop closer)
    verification-helpers.ts       Shared helpers: screenshot, diagnostics, package-manager detect
    index.ts                      Re-exports AppVerificationService + its public types
  views/
    ViewManagerView.tsx           React view component; exports ViewManagerView
    ViewManagerView.test.ts       Unit tests for the view component
    viewManagerData.ts            Data helpers for the view manager
    app-control-view-bundle.ts    View bundle registration entry point
  workers/
    app-worker-entry.ts           Worker entry point for isolation="worker" apps
```

## Commands

```bash
# Build plugin (ESM + declarations + views bundle)
bun run --cwd plugins/plugin-app-control build

# Watch mode (ESM + declarations; excludes views bundle)
bun run --cwd plugins/plugin-app-control dev

# Run tests
bun run --cwd plugins/plugin-app-control test

# Typecheck
bun run --cwd plugins/plugin-app-control typecheck

# Lint (auto-fix)
bun run --cwd plugins/plugin-app-control lint

# Build views bundle only
bun run --cwd plugins/plugin-app-control build:views
```

## Config / env vars

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ELIZA_REPO_ROOT` | No | `cwd()` | Repo root for scaffolding new apps/plugins. Falls back to `ELIZA_WORKSPACE_DIR`. Packaged installs without a checkout still scaffold: templates resolve from the installed `elizaos` package and new plugins land in `<stateDir>/plugins` (see `src/actions/scaffold-env.ts`). |
| `ELIZA_WORKSPACE_DIR` | No | `cwd()` | Alternate repo/workspace root. |
| `ELIZA_STATE_DIR` | No | `~/.eliza` | State dir for registry, audit logs, granted-permissions store. |
| `ELIZA_NAMESPACE` | No | `eliza` | Namespace prefix used in state dir paths. |
| `ELIZA_PROTECTED_APPS` | No | (built-in list) | Comma-separated app slugs that cannot be deleted by the agent. |
| `ELIZA_API_AUTH_TOKEN` / `ELIZA_API_TOKEN` | No | — | Auth token forwarded to the dashboard API. |
| `ELIZA_PORT` / `ELIZA_API_PORT` | No | auto-detected | Dashboard API port (discovered via `resolveServerOnlyPort`). |
| `ELIZA_BROWSER_VERIFY_OPTIONAL` | No | — | Set to `1` to make the browser step in `AppVerificationService` non-fatal. |
| `ELIZA_CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | No | — | Chrome path for `AppVerificationService` browser checks. |
| `ELIZA_BUILD_VARIANT` | No | — | Set to `store` to signal a platform that disallows dynamic code loading. |
| `ELIZA_PLATFORM` | No | — | Set to `ios` or `android` to signal a restricted platform. |

## How to extend

### Add a new APP sub-mode

1. Create `src/actions/app-<mode>.ts` — export a `run<Mode>(ctx)` function returning `ActionResult`.
2. Add the mode string to the `AppMode` union in `src/actions/app.ts`.
3. Add it to the `MODES` array in `src/actions/app.ts`.
4. Wire the intent regex and the `switch` dispatch in `app.ts`.
5. Export the function from `src/index.ts` if callers outside this plugin need it.

### Add a new VIEWS sub-mode

Follow the same pattern in `src/actions/views.ts` and create a `src/actions/views-<mode>.ts` file.

### Add a new service

1. Create `src/services/<name>.ts`; extend `Service` from `@elizaos/core`.
2. Export a `serviceType` string constant.
3. Register the service class in the `services` array in `src/index.ts`.
4. Add a `dispose` call in the plugin's `dispose` hook.

## Conventions / gotchas

- **Loopback HTTP only.** The client (`src/client/api.ts`) and all action helpers call the Eliza dashboard over `http://127.0.0.1:<port>`. Port is auto-detected; never hardcode it.
- **APP stop shares the UI route.** Name-based `APP action=stop` calls `/api/apps/stop`, the same canonical AppManager path as `AppsManagementSection`; a successful stop and `nothing-stopped` are distinct typed results.
- **APP action requires owner role.** `hasOwnerAccess` from `@elizaos/core` gates all `APP` writes. `VIEWS` read modes are open; write modes (`create`, `edit`, `delete`) are owner-gated.
- **Multi-turn flows.** `APP create` and `VIEWS create` use `hasPendingIntent` / `hasPendingViewsCreateIntent` to detect follow-up choice replies (`new`, `edit-N`, `cancel`). Both check a pending-task record in the runtime before routing to the create sub-handler.
- **Complete create/edit disambiguation.** `APP create` and `VIEWS create` must persist and render every fuzzy-matched existing target. Do not cap ranked edit choices; connector-specific native-control limits are handled downstream with complete fallback text.
- **Create flows work outside a checkout and preflight their dependencies.** `src/actions/scaffold-env.ts` resolves the min-plugin / min-project templates from the repo root first and then from the installed `elizaos` package (declared as a dependency so packaged builds ship the templates), lands new plugins in `<stateDir>/plugins` when the repo root has no plugins/ dir, and `preflightCodingDispatch` checks the orchestrator action + a coding CLI on PATH BEFORE scaffolding so a missing prerequisite answers with setup guidance instead of a dead-end error (or a half-created workdir). Keep new scaffold paths on these helpers; do not reintroduce repo-root-only resolution.
- **Build has three steps.** `tsup` compiles the main entry and the worker entry to ESM. `tsc` emits declarations only (`--emitDeclarationOnly`). `vite build:views` compiles the React view bundle separately. All three run in sequence via `bun run build`.
- **`puppeteer-core` is an optional peer dep.** `AppVerificationService` only loads it when a browser step is requested and the dep is present. Set `ELIZA_BROWSER_VERIFY_OPTIONAL=1` if you want failures there to be non-blocking.
- **`AppWorkerHostService` auto-starts persisted worker apps best-effort.** On service start it asks `AppRegistryService` for persisted entries and spawns apps whose resolved isolation is `"worker"`. Spawn failures are reported without preventing the registry entry from remaining inspectable.
- **Worker surfaces are explicit.** New app manifests declare `elizaos.app.worker: false` for static-only apps or `elizaos.app.worker: { entry: "dist/plugin.js" }` for an agent-side plugin. An absent field invokes conventional entry discovery only for legacy apps; a missing explicitly declared entry is a broken or unbuilt worker, not a static app.
- **Restricted platforms.** `isRestrictedPlatform()` in `src/actions/views.ts` returns `true` on iOS/Android store builds. Use it to gate dynamic-plugin creation flows.
- **VIEWS navigation belongs to the real planner.** `show`/`open` require a structured destination; `runViewsShow` must not infer a target from the user's utterance or override an explicit target with `matchViewCommand`/`resolveIntentView`. Missing or unresolvable targets return an internal failure without navigation, so the planner can select a registered destination. Registered IDs/labels and explicit canonical aliases remain supported. Multilingual requests use the real planner, not phrase-based navigation shortcuts. Existing intent-matcher exports serve compatibility/context classification only; they do not authorize a navigation bypass.
- **Pre-edit snapshots are best-effort (#8915).** `VIEWS create`/`edit` and `APP create`/edit take a `git commit --no-verify --allow-empty` snapshot of the target workdir before dispatching the coding agent and record the SHA on a `views-snapshot`-tagged Task keyed by room/plugin. A failed snapshot (workdir not in a git work tree, no committer identity, …) only disables rollback for that edit — it must never abort the dispatch. `VIEWS rollback` resolves the most-recent snapshot for the room (or an explicit `sha`/`view`), runs `git reset --hard`, then re-registers via `load-from-directory`. On verification failure after max retries, `VerificationRoomBridgeService` surfaces a chat offer naming `VIEWS action=rollback` for plugins so the user is never left with a broken create/edit. Shell out via the injectable `GitRunner` in `views-snapshot.ts` (so tests stay deterministic); do not reach into `CodingWorkspaceService`, which is keyed by managed-workspace IDs, not local repo workdirs.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

Contextual navigation preserves the entire original request and keeps domain
operations in the planner. Both destination selection and its planner handoff
use the complete authorized view/capability reference with interaction parameter
schemas deferred; VIEWS list restores those schemas through a fresh authorized read. Planner-owned VIEWS steps pass
`navigationIntent=planner-step` and a `navigationStepId`; each target is resolved
against the current catalog, preserving registration, availability, and role
gates. Navigation receipts remain separate from event, note, or task effects.

The contextual evaluator binds navigation permission to the incoming message,
room, and actor through core StreamingContext. Nested model scopes preserve that
policy and cancellation signal. Tool parameters cannot relax a deny constraint.
The same policy applies to manager,
close (including aliases), window, pin, and split/tile navigation, with another
check at the shell transport boundary; read and domain modes remain independent.
Planner steps require an explicit allow. Catalog requests and the final dispatch
observe cancellation. Show/open outcomes and alternate-mode denials use
`data.navigation.stepId`;
`delivered` requires the matching completed-action handoff receipt, while missing,
negative, or malformed delivery remains explicit. Stable handoff IDs scope replay
to the same message, actor, client, step, and destination.

The visual-continuation field reuses the existing Stage-1 model judgment. Its
result is bound in memory to the exact runtime, message, actor, room, request
text and sender role; caller metadata cannot supply it. Non-navigation decisions
set the existing deny constraint. Requested/optional destinations still require
the fresh authorized catalog, with canonical action execution and transport gates.
A fresh requested client-chat DM decision with navigationOnly=false and a
VIEWS_SHOW candidate may leave its destination blank: the existing planner
resolves it from the complete original request and a fresh role-filtered
id/label/path index. Full descriptions and schemas remain available through
VIEWS list. This cannot dispatch direct navigation or satisfy a prerequisite.
Other missing, malformed, uncertain, stale or unavailable selections retain the
separate live-catalog model classifier. No field handler executes navigation.

Known structured Stage-1 aliases such as `Home` reuse the same canonical target
vocabulary as VIEWS. An alias is accepted only when its canonical destination
is present in the fresh authorized catalog; it never supplies navigation intent
from user text or bypasses role, availability, developer-view or transport gates.
Exact registered IDs retain precedence in Stage-1 selection. Unresolved aliases
keep the classifier rather than selecting a fuzzy destination.

Explicit VIEWS list/current/search operations remain reads even when the request mentions keeping a split or window visible; layout inference must not turn a read into a mutation or an avoidable planner repair round.

Navigation handoffs retain the selected destination and every capability identity/description, while marking interaction parameter schemas as deferred. VIEWS action=list returns the complete fresh authorized catalog before interaction; navigation itself needs no interaction schema. The classifier, domain action schemas, catalog storage and execution gates remain complete.

The same destination projection is used in pre-planner navigation context and `VIEWS show` promptData, explicitly opting into `promptDataMode: "replace-data"`. Keep raw result.data complete, retain navigation status and scoped actions, and expose the fresh VIEWS list read for deferred interaction parameters. Background review must use this declared model projection as well.

Stage-1 visual continuation records whether all UI work is a single known-view show. Only that explicit same-turn model judgment may replace the VIEWS umbrella hint with VIEWS_SHOW; legacy/missing judgments and compound UI operations retain the parent. Domain candidates, full requests, permissions, discovery and delivery receipts remain authoritative. Explicit navigation does not consume a pending view-creation choice.

A fresh same-turn Stage-1 navigationOnly judgment can select the existing deterministic VIEWS_SHOW executor for a client_chat DM only when the entire request is one requested view switch, the sole intent and all candidates agree, and the destination passes the live authorized catalog. singleViewOnly alone is insufficient: compound questions, domain work, multiple views, optional navigation and missing/stale classifications keep normal planning. The canonical executor retains all admission, receipt, cancellation and reply-recovery gates; post-tool synthesis grounds the visible confirmation. No utterance parser or caller metadata grants this fast path.
A none decision remains a navigation denial even if the model also names the current screen; discard the irrelevant destination without a classifier call. This never grants navigation.

The navigation-only reply draft describes the conditional successful destination, not progress or a domain effect. Core may reuse it after the successful matching navigation receipt and egress checks, including when Stage 1 marked the draft pending. Failed/unconfirmed navigation and compound requests retain their normal evaluation/recovery paths.

An explicitly conditional navigation request remains requested pending work. Preserve its prerequisite read, destination and condition for the planner; it is not navigationOnly and cannot use direct navigation. The planner must observe a satisfying read result before navigating and keep the current view when the condition fails. None/forbidden decisions remain denied at dispatch.

When navigation needs the planner, its context includes the fresh role-filtered destination identity index even if Stage 1 proposed a destination. The planner resolves each requested target and condition from the full current request; a proposal does not authorize unrequested navigation. Full interaction schemas remain discoverable, and direct navigation keeps its single-destination context.

A resolved VIEWS read capability stays a read across prerequisites, later steps and negative write clauses. Words elsewhere in the request must not upgrade it into creation, updates, deletion or selection; a different operation requires another planner decision. The existing explicit destructive-negation veto, catalog validation, parameter checks, role gates and effect receipts remain in force; ambiguous or failed work returns to the planner.
