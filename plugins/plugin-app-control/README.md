# @elizaos/plugin-app-control

An elizaOS plugin that lets an Eliza agent launch, close, list, scaffold, and verify Eliza apps; manage UI views contributed by plugins; and change the unified app background.

## What it does

Loading this plugin gives an Eliza agent semantic actions for app, view,
background, settings, model, agent-profile, and runtime management.

**APP** — Unified app lifecycle control. The agent can:
- Launch a registered app by name (`"launch shopify"`)
- Relaunch (stop then start) a running app, optionally running verification after (`"relaunch shopify and verify"`)
- Stop a running app without uninstalling or relaunching it (`"stop the shopify app"`)
- List installed and currently-running apps (`"what apps are open?"`)
- Load apps from a local directory into the registry (`"load apps from /my/dev/apps"`)
- Scaffold a new Eliza app through a multi-turn flow that asks new/edit/cancel, scaffolds from the min-app template, and dispatches a coding agent with AppVerificationService validation (`"build me a note-taking app"`)

**VIEWS** — Full view management. The agent can navigate to any UI view contributed by any loaded plugin; report the currently-open view; search views by name; open the view manager; broadcast events to mounted views; interact with a view (click, get state, focus, etc.); pin a view as a desktop tab; open a view in a separate window; and create, edit, or delete view plugins through a coding-agent backed flow.

Contextual visual continuation is selected before planning from the authorized live view catalog. It adds navigation alongside domain work; opening Calendar never proves that an event was drafted or saved. The same turn receives the VIEWS navigation result before its final reply. Catalog results describe only views authorized for the caller: an absent destination is unavailable to that caller, with an unknown cause. Omission must not be presented as proof that the view does not exist globally or that no role restriction applies.

**BACKGROUND** — Unified background control. The agent can set a named color or hex color, use an uploaded image, generate a background image from a prompt, undo the previous background, redo an undone change, or reset to default. It broadcasts a `background:apply` view event that the always-mounted app background applies to the shared `BackgroundConfig` store.

**RUNTIMES** — Owner-gated Devices & Runtimes lifecycle. It lists saved
runtimes, manages confirmed pairing/revoke/relay operations, and performs
read-only SSH host-key inspection before a confirmed fingerprint-pinned
connection. Passwords, private keys, and bearer/access tokens are never action
parameters; secret entry stays in the local UI and native credential store.

## Capabilities added to the agent

| Action | Contexts gated | Role gate |
|---|---|---|
| `APP` | `automation`, `settings`, `code` | Owner |
| `VIEWS` (read modes) | `general`, `automation`, `settings`, `code` | User |
| `VIEWS` (create/edit/delete) | `general`, `automation`, `settings`, `code` | Owner |
| `BACKGROUND` | `general`, `settings` | User |
| `RUNTIMES` | `general`, `settings`, `admin`, `system` | Owner |

The `available_apps` provider injects installed + running app data into the agent's planning context when operating in the `settings` or `automation` context, so the agent can pick a target without an extra round-trip.

## Installation

Add `@elizaos/plugin-app-control` to your agent's plugin list. The plugin is not default-enabled.

```ts
import appControlPlugin from "@elizaos/plugin-app-control";

const runtime = new AgentRuntime({
  // ...
  plugins: [appControlPlugin],
});
```

## Required environment / config

None are required for basic operation. The plugin auto-discovers the Eliza dashboard port via `resolveServerOnlyPort`.

| Variable | Purpose |
|---|---|
| `ELIZA_REPO_ROOT` / `ELIZA_WORKSPACE_DIR` | Repo root used when scaffolding new apps or view plugins. Defaults to `cwd()`. |
| `ELIZA_STATE_DIR` | State directory for the app registry, audit logs, and granted-permissions store. Defaults to `~/.eliza`. |
| `ELIZA_PROTECTED_APPS` | Comma-separated app slugs the agent may not delete. |
| `ELIZA_BROWSER_VERIFY_OPTIONAL` | Set to `1` to make browser checks in AppVerificationService non-fatal. |
| `ELIZA_CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | Chrome binary path for browser-based app verification (optional peer dep `puppeteer-core`). |
| `ELIZA_BUILD_VARIANT=store` / `ELIZA_PLATFORM=ios\|android` | Disables dynamic plugin creation on restricted distribution platforms. |

## Services registered

| Service | Purpose |
|---|---|
| `AppRegistryService` | Persists `load_from_directory` registrations so they survive restarts. |
| `AppVerificationService` | Typecheck / lint / test / build / launch / browser pipeline for newly created apps and plugins. |
| `AppWorkerHostService` | Runs apps that declare `isolation: "worker"` in a dedicated `node:worker_threads` Worker with typed RPC. |
| `VerificationRoomBridgeService` | Posts verification results back into the user's chat room once the background coding agent finishes. |

Worker execution is an explicit manifest capability. Static apps declare
`elizaos.app.worker: false`; apps with an agent-side plugin declare
`elizaos.app.worker: { "entry": "dist/plugin.js" }`. Only legacy manifests
that omit `worker` use package-entry and conventional-source discovery. A
missing explicitly declared entry is reported as a broken or unbuilt worker.

## Views registered

The plugin contributes a **View Manager** GUI view at `/views` — a browser for all views contributed by loaded plugins.

## For agent developers

See [CLAUDE.md](CLAUDE.md) for file layout, how to add new sub-modes, service wiring, and plugin-specific gotchas.

Navigation keeps the full view receipt in runtime data. Model-facing navigation receipts carry destination, every capability identity/description and scoped actions, with interaction parameters explicitly deferred to a fresh `VIEWS action=list` read. That catalog read still supplies full parameter schemas before interaction.

Single-view navigation can reuse the typed decision from the existing response-handler call. When that decision covers the entire request, the regular executor performs `VIEWS_SHOW`; a successful matching receipt can release the held model-authored destination confirmation without another inference. Missing or unsuitable prose keeps the reply-only round. Compound or uncertain requests keep the planner. All role, destination, transport and recovery checks still apply.

Structured destination IDs resolve against the fresh authorized catalog without case sensitivity when the match is unique. This includes plugin views outside the shared navigation alias table. Exact IDs retain precedence; ambiguous IDs, unavailable views and missing or stale decisions keep the classifier. This lookup never infers navigation from the user’s words.

The response-handler instructions and native tool schema both describe navigation as pending execution: retain a navigation intent and action candidate even when drafting its confirmation. An empty intent list means a text-only answer, not permission to skip navigation. The runtime chooses direct execution or planning; the model must not omit work to select the faster path.

After selecting direct navigation, the evaluator adds the general app context through the role-filtered patch runner. This prevents a model's unrelated context tag (for example, `system` for Home) from rejecting its otherwise valid navigation. Existing contexts remain; unavailable contexts, private actions and role restrictions are still enforced by the standard gates.

When navigation needs the planner, its context includes the fresh role-filtered destination identity index even if Stage 1 proposed a destination. The planner resolves each requested target and condition from the full current request; a proposal does not authorize unrequested navigation. Full interaction schemas remain discoverable, and direct navigation keeps its single-destination context.

A resolved VIEWS read capability stays a read across prerequisites, later steps and negative write clauses. Words elsewhere in the request must not upgrade it into creation, updates, deletion or selection; a different operation requires another planner decision. The existing explicit destructive-negation veto, catalog validation, parameter checks, role gates and effect receipts remain in force; ambiguous or failed work returns to the planner.
