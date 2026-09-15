# @elizaos/core

## Overview

`@elizaos/core` is the runtime and contract layer of elizaOS. It defines the `AgentRuntime` and the plugin abstractions (actions, providers, evaluators, services, models, routes, events), the canonical type system, and the supporting subsystems (memory, search, settings, scheduling, prompts). It is consumed by `@elizaos/agent` (which also hosts the HTTP API server), `@elizaos/app-core` (the API + dashboard host), and every `@elizaos/*` plugin.

Document authorization treats a document's `roomId` as its single room
entitlement and evaluates it against current requester membership inside the
adapter before rows, counts, fragments, or ranking are produced. Explicit
`directGrantEntityIds` are independent of room membership for reads; they
cannot expose `agent-private` documents or confer mutation authority. They can
only be replaced through the dedicated storage-enforced CAS operation by OWNER,
or by a current room ADMIN for global and user-private documents. Every grantee
must be an entity in the current agent tenant. Invalid or duplicate grant arrays
fail closed.

## Key concepts

- **AgentRuntime:** Central orchestrator for the agent lifecycle, plugin loading, and the message loop.
- **Actions:** Tasks the agent can perform, each with a `validate` and `handler` function.
- **Providers:** Supply data and context to the runtime and its components.
- **Evaluators:** Process conversation data to extract facts, build memory, and reflect.
- **Plugin system:** `Plugin` objects contribute actions/providers/evaluators/services to the runtime.
- **Built-in bundle:** Foundational capabilities ship as `basicCapabilities` (and `basicActions` / `basicProviders` / `basicEvaluators` / `basicServices`); there is no `corePlugin` singleton.

For the default direct-text message handler, routing context discovery can show
every authorized context name while deferring its complete description. The
handler requests `CONTEXT_CATALOG` through `contextRequests` when it needs those
descriptions; the runtime refreshes the authorized catalog before processing any
reply or action. This can add a model call, so compare whole-turn usage. It does
not trim conversation history or grant access to tools or private data.

`resolveActionArgs` treats a required empty array as missing unless its
`SubactionSpec.allowEmptyArrays` names that parameter. This opt-in preserves
an explicitly supplied or extracted `[]` through argument resolution; it never
defaults an omitted or null value to an empty list. The owning action must still
validate element types, permissions and domain constraints.

## Computer-use adapter contract

`contracts/computer-use.ts` is the provider-neutral boundary shared by browser
automation and native desktop control. It deliberately keeps two execution
planes distinct: browser adapters use DOM, browser accessibility, and supported
devtools protocols; computer adapters use OS accessibility, capture, and input.
Both planes expose the same session, surface, capability, observation, action,
confirmation, lease, and result envelopes.

The current wire contract is version 2. Version 1 was never released with an
adapter and is rejected rather than compatibility-normalized because it did not
bind confirmations, grants, leases, and mutation receipts strongly enough for a
privileged input boundary. Adapters must normalize capabilities first, normalize
stored session state separately from executable-session authorization, normalize
the exact action, and validate results with a trusted clock plus the same
session/capability/action context.

Adapters must advertise capabilities before dispatch. Unsupported work returns
`UNSUPPORTED`; stale observations and lease conflicts have separate outcomes;
and a mutation whose effect cannot be proven returns non-retryable
`UNCERTAIN_EFFECT`. Results reuse canonical `EffectReceipt` values instead of
creating a second mutation-proof format. Existing signed-in profiles require an
explicit host-issued grant verified through `InteractionProfileGrantVerifier`.
Confirmation previews bind to the domain-separated SHA-256 digest returned by
`computeInteractionActionDigest`; `InteractionConfirmationCoordinator` issues
and consumes matching grants once. Distributed hosts implement the async
consumer as one durable atomic consume-if-current operation; a separate
verify-then-delete sequence is not replay-safe across processes.

Physical input and other shared resources use `InteractionLeaseCoordinator`.
Exact acquisition replay is idempotent, renewal preserves the stored canonical
lease, and `assertActionLeases` resolves action lease IDs against the session,
owner, generation, and required resource before dispatch. Every dispatch must
provide explicit lease requirements (including `[]` when no shared resource is
needed), so policy omission cannot silently disable lease enforcement. Trace attributes are
metadata-only: public scalar values are allowed, sensitive values must be null,
and any correlation token is an opaque host-keyed token rather than a raw hash
of personal data or credentials.

Package-owned adapter tests can import
`runInteractionAdapterConformance` from `@elizaos/core/testing`. The runner
requires fixtures for success, no-effect failure, uncertain effect, policy
block, confirmation, unsupported capability, and a genuinely stale observation;
it separately exercises coordinator lease contention and expiry. These are
envelope and invariant checks, not proof that a real adapter induced each OS or
browser behavior. Every adapter package still needs stateful fault-injection
tests plus real browser or OS E2E evidence.

## Provider integration authorization contract

`types/provider-integrations.ts` is the provider-neutral boundary for opaque
connected-account projections and capability dispatch. Adapters keep provider
arguments and credentials private, expose only a provider-owned SHA-256 input
digest, and bind that digest to the selected account snapshot, capability,
operation, contextual risk, and binding time before policy evaluation.

`CapabilityAuthorizationConsumer.consume` is a trusted host boundary. It must
atomically consume one current policy decision and its exact confirmation grant
when confirmation is required. Allowed decisions are one-shot too: a successful
dispatch authorization can never be replayed merely because it did not require
interactive confirmation. Distributed implementations use one durable
compare-and-delete transaction and verify that the account/capability snapshot
is still current; a separate read, verify, and delete sequence is unsafe.
The in-memory `CapabilityAuthorizationCoordinator` therefore requires a
synchronous `isSnapshotCurrent` reader. A false result burns the registered
authority before returning a stale-authorization error, so reconnecting the
account cannot resurrect consent issued before revocation.

The returned `AuthorizedCapabilityRequest` is an in-process immutable value,
not a wire credential. `normalizeCapabilityActionReceipt` accepts effect proof
only against that exact authority and binds the complete policy and confirmation
digests, request digest, opaque account, capability, operation, input digest,
and post-authorization chronology. Provider payloads and secrets never belong
in requests, decisions, confirmations, errors, or receipts.

Policy denials and execution failures use the exported canonical
`CAPABILITY_POLICY_DENIAL_CODES` and `CAPABILITY_EXECUTION_ERROR_CODES`
classifications. Adapters must map provider-specific status, prose, and payloads
to those values; arbitrary provider error text is rejected at normalization and
must not be forwarded through public error context.

### Bounded pairing operator reads

`PairingService` keeps its existing complete-array methods (`listPendingRequests`
and `getAllowlist`) for compatibility. Operator surfaces should use the bounded
page methods instead:

```ts
const pending = await pairingService.listPendingRequestsPage("discord", {
  limit: 25,
  offset: 0,
});

const allowed = await pairingService.getAllowlistPage("discord", {
  limit: 25,
  offset: 0,
});
```

Both methods return `PairingPage<T>`: `{ items, limit, offset, hasMore,
nextOffset }`. Results are deterministically newest-first (record ID breaks equal
timestamps), `nextOffset` is `null` on the final page, the default limit is 50,
and the maximum is 100. Pending-request pages push the configured request TTL
cutoff into official database adapters so expired rows do not consume page
slots. Official SQL and in-memory adapters apply the limit and offset at their
storage boundary; third-party adapters that have not adopted the optional query
fields remain compatible through a service-level bounded fallback.

## Installation

1.  Add `@elizaos/core` to your `agent/package.json` dependencies:

    ```json
    {
      "dependencies": {
        "@elizaos/core": "workspace:*"
      }
    }
    ```

2.  Navigate to your `agent/` directory.
3.  Install dependencies:
    ```bash
    bun install
    ```
4.  Build your project:
    ```bash
    bun run build
    ```

## Build targets (Node, Browser, Edge)

`@elizaos/core` builds to three targets via conditional exports:

- **Node.js Build**: Full API surface with all features including server utilities (`index.node.ts`)
- **Browser Build**: Browser-safe subset, no fs/process-bound modules (`index.browser.ts`)
- **Edge Build**: Edge-runtime subset (`index.edge.ts`)

The correct build is automatically selected based on your environment through package.json conditional exports. For browser usage, ensure your app provides the standard platform primitives it depends on, such as `Buffer` where needed.

## Configuration

The following environment variables are used by `@elizaos/core`. Configure them in a `.env` file at your project root.

- `LOG_LEVEL`: Logging verbosity (e.g., 'debug', 'info', 'error').
- `LOG_JSON_FORMAT`: Output logs in JSON format (`true`/`false`).
- `SECRET_SALT`: Encryption salt, read by `getSalt()` in `src/settings.ts`. In production it must be set to a non-default value unless `ELIZA_ALLOW_DEFAULT_SECRET_SALT=true`.
- `ALLOW_NO_DATABASE`: Allow running without a persistent database adapter. When `true`, `AgentRuntime.initialize()` will fall back to an in-memory adapter (useful for benchmarks/tests).
- `LOG_FILE`: When set to `true`/`1` or a path, enables file logging: `output.log`, `prompts.log`, and `chat.log` (in cwd or at the given path). **Why:** Lets you inspect full prompts and chat flow without scraping console; ANSI is stripped so files stay grep-friendly.
- `BASIC_CAPABILITIES_KEEP_RESP`: When `true`, the message service does not discard a response when a newer message is being processed (avoids "stale reply" race). **Why:** Some deployments want to keep or display every response; this is the config equivalent of passing `keepExistingResponses: true` in options.
- `SHOULD_RESPOND_MODEL`: Which model size to use for the "should I respond?" decision (`small` or `large`, read in `src/services/message.ts`). Defaults from runtime settings if not set in options.
- `AUTONOMY_INTERVAL_MS`: Autonomy loop cadence as a canonical positive decimal integer in milliseconds. Values are clamped to 5,000–600,000; malformed or unset values use 30,000.
- `AUTONOMY_MODEL_SIZE`: Model tier for autonomy background reasoning, exactly `small` or `large`. Malformed or unset values use `large`.
- `ELIZA_TRAJECTORY_LOGGING`: Canonical trajectory persistence knob. Truthy values (`1`, `true`, `yes`, `on`) enable file and DB trajectory recording; non-empty falsey values disable it; blank is treated as unset. When unset, recording is on for local/dev and unset `NODE_ENV`, but off for `NODE_ENV=test` and `NODE_ENV=production` unless explicitly enabled.
- `ELIZA_TRAJECTORY_RECORDING`: Legacy alias honored only when `ELIZA_TRAJECTORY_LOGGING` is unset.
- `ELIZA_DISABLE_TRAJECTORY_LOGGING=1`: Hard opt-out that wins over both trajectory enable knobs.

**Example `.env`:**

```plaintext
LOG_LEVEL=debug
LOG_JSON_FORMAT=false
SECRET_SALT=yourSecretSaltHere
ALLOW_NO_DATABASE=true
LOG_FILE=true
```

**Note:** Add your `.env` file to `.gitignore` to protect sensitive information.

### Design and rationale (WHY)

Per-change notes with the WHY for each addition or fix live in [CHANGELOG.md](CHANGELOG.md). The sections below document the reasoning behind the major subsystems so future changes stay consistent with intent.

### Benchmark & Trajectory Tracing

Trajectory persistence is controlled by `ELIZA_TRAJECTORY_LOGGING`: dev/local defaults on, while `NODE_ENV=test` and `NODE_ENV=production` default off unless explicitly opted in. Blank values are treated as unset so empty `.env` entries do not silently disable local recording.

Benchmarks and harnesses can attach metadata to inbound messages:

- `message.metadata.trajectoryStepId`: when present, provider access + model calls are captured for that step.
- `message.metadata.benchmarkContext`: when present, the `CONTEXT_BENCH` provider sets `state.values.benchmark_has_context=true`, and the message loop forces action-based execution (so the full Provider → Model → Action → Evaluator loop is exercised).

### Model output contract (XML preferred, plain text tolerated)

The canonical message loop expects model outputs in the `<response>...</response>` XML format (with `<actions>`, `<providers>`, and `<text>` fields).

Some deterministic/offline backends may return **plain text** instead. In that case, the runtime will treat the raw output as a simple **`REPLY`** so the system remains usable even when strict XML formatting is unavailable.

### Post-turn evaluator prompt prefixes

Managed post-turn extraction supports a revision-based input contract. An
evaluator opts in with `incremental: true` only when its preparation consumes
`options.extraction` and every processor can safely replay the same evidence.
An opt-in predicate may require adapter capabilities; the long-term-memory lane
requires durable idempotent writes and otherwise keeps its legacy behavior.
The first run backfills the retained room; later runs receive complete new or
changed evidence, not a token-capped transcript. Full messages remain stored for
conversation rendering and authorized recall. Already processed provider prose
is not copied wholesale into the extraction prompt; declared providers, existing
facts, delivered action results and the pending evidence remain available.

Within one room-lease batch, incremental extractors share one complete cloned
and fingerprinted source snapshot. Each keeps independent progress, output and
reconciliation data; staging and commit still recheck authoritative sources.
The snapshot is never reused across batches or room scopes.

Evidence byte budgets exclude `content.chatIdempotency`, the recovery transport
carrier already omitted from shared transcripts and authored-source revisions.
Batch selection, historical pages and shared batches use that accounting.
Historical reference prompts also omit this transport carrier; their cumulative
byte guard measures the exact serialized evidence array supplied to the model.
Stored messages and recovery snapshots remain complete. Authored evidence still
must fit the configured resource boundary without clipping.

The background worker yields to the event loop between jobs, including failed
staged-output replays. Cached database work can otherwise keep an entire task
batch in promise continuations and delay incoming network requests before they
reach the foreground room queue. The existing foreground and worker ownership
gates still apply; yielding does not acknowledge evidence or discard pending work.

When smaller, incremental shared transcripts name each speaker ID once and use
explicit top-level `entityRef` fields. Message IDs and nested content remain
literal; replacing references from the supplied dictionary reconstructs every
original record. Small inputs or a colliding source field keep the full format.

Progress is isolated by agent, room, speaker and evaluator. Validated output is
durably staged before effects and reused after failure; the checkpoint advances
only after all processors succeed. Personal facts, preferences and long-term
memories must cite selected messages from the correct speaker. Initial backfill
does not award existing facts another confidence increase merely for rereading
old evidence. Transport acknowledgements and topic/embedding bookkeeping do not
count as authored edits.
The managed wire schema requires declared source-message citations; parsing also
checks their actual authorship before journaling. Connector delivery settlement
precedes extraction, so final text and delivered action receipts are included.

This is at-least-once processing with replay-safe reducers, not a distributed
exactly-once transaction. The existing room ordering remains required. Edits or
deletions of processed sources are explicit reconciliation holds; they never
silently delete reviewed facts or acknowledge unreconciled evidence. Pending
work resumes on a later eligible text turn. Voice/mobile reflection exclusions
and third-party evaluators' full-context contracts remain unchanged. Moving
model work outside the room lease requires a separate durable scheduling and
source-reconciliation design.

`parse(output, context)` can validate evidence before staging; the optional
second argument preserves existing plugins. `processedEvaluators` lists only
evaluators whose processors and progress commits succeeded, not attempted ones.

Evaluators retain the complete `prompt(context): string` API. They may also
provide `promptSegments(context)` whose concatenated content equals that exact
prompt. Only instructions independent of the turn belong in stable segments;
prepared records, identifiers, action results and conversation text stay dynamic.
Stable instructions must form a contiguous prefix before dynamic data, and
segment boundaries must not split a Unicode code point. The evaluator service
rejects invalid order, boundaries or mismatched annotations before dispatch.

The merged evaluator call keeps one user message and places all annotated static
instructions before complete shared turn context and dynamic evaluator sections.
Unannotated plugin prompts remain complete dynamic sections. The four built-in
reflection evaluators annotate their existing rules without dropping their data.
Schema and instruction changes invalidate the canonical prefix metadata. This
fingerprint identifies content/schema, not a provider/model affinity; backend
model isolation and any optional benchmark model-scoped hint remain separate.
Local conversation identity remains agent/room scoped; no optional cloud routing hint
or provider retention policy is enabled by this rendering change.

Schema, JSON-object and plain-JSON attempts share the same complete rendering.
Native text-result envelopes must finish normally without tool calls before their
JSON is processed; incomplete or malformed output cannot commit evaluator effects.
This ordering enables automatic provider prefix reuse where supported; measured
latency and cache reuse still require live evidence on the selected provider.

### Prompt cache hints

The core can pass **prompt segments** to model providers so they can use prompt-caching APIs when supported. Each segment has `content` (string) and `stable` (boolean). **Stable** means the content is the same across calls for the same schema/character (e.g. instructions, format, examples); **unstable** means it changes every call (e.g. state, validation codes).

**Why this exists:** Repeated calls (e.g. message handling, batched evaluators) often send the same instructions and format while only the context/state changes. Provider caching (Anthropic ephemeral cache, OpenAI/Gemini prefix cache) can reuse tokens for the stable prefix, reducing cost and latency. The core describes which parts are stable so providers can opt in without parsing the prompt.

- **Invariant:** When `promptSegments` is set on generation params, `prompt` MUST equal `promptSegments.map(s => s.content).join("")`. **Why:** Providers that ignore segments still get correct behavior by using `prompt`; those that use segments must send the same total text so model behavior is unchanged.
- **Providers:** Anthropic uses the Messages API with `cache_control: { type: "ephemeral" }` on stable blocks so the API can cache those blocks. OpenAI and Gemini use **prefix ordering**: when segments are present, the prompt sent to the API is built with stable segments first, then unstable. **Why:** OpenAI and Gemini cache by prefix (e.g. OpenAI ≥1024 tokens); putting stable content first maximizes cache hits.

**Pitfalls for operators:**

- OpenAI caching only applies when the prompt is ≥1024 tokens; very short prompts will not show cache savings.
- Small or low-parameter models may not support or benefit from caching; behavior is unchanged.
- Caching is a performance/cost optimization; correctness does not depend on it.

**Pitfalls for implementers:**

- Do not mutate segment objects; always create new `{ content, stable }` objects. **Why:** Params may be passed to multiple handlers or stored; mutation can cause cross-request bugs.
- Segment order must match the order in which the prompt string is built; add an assertion that `prompt === promptSegments.map(s => s.content).join("")`. **Why:** Wrong order breaks the invariant and can send the wrong prompt to the model.
- When using segments in the API (e.g. messages or reordered prompt), ensure the final text seen by the model equals the intended full prompt (e.g. `params.prompt` or the stable-first concatenation).
- Only mark content as `stable: true` if it is identical across calls for the same schema/character. **Why:** Content that includes per-call UUIDs or changing state will never cache; mislabeling it as stable wastes cache capacity and can confuse operators.

## Core Architecture

`@elizaos/core` is built around a few key concepts that work together within the `AgentRuntime`.

### Unified Prompt Batcher

`@elizaos/core` now includes a unified prompt batching subsystem on `runtime.promptBatcher`.

Why this exists:

- Evaluators, startup warmups, and autonomous reasoning were all paying separate LLM round trips for structurally similar work.
- Batching reduces cost, queue depth, and local GPU contention by turning many small prompt calls into fewer structured calls.
- The dispatcher keeps deployment flexibility: local inference can pack aggressively while frontier APIs can trade some density for latency.

What it does:

- `askOnce()` batches startup questions into a single post-init drain when possible. Returns a promise of the extracted **fields** (unwrapped). **Why:** callers get a thenable so they can `await` or `.then()` without a callback.
- `onDrain(id, opts)` registers a section that runs on the next drain for that affinity and returns a **promise that resolves with `{ fields, meta }`** (or `null` if the section ID was already registered). **Why:** evaluators can use linear `await` + `if (result) { ... }` instead of a large `onResult` callback; same batching benefits. You can still pass optional `onResult` for fire-and-forget or recurring use (e.g. logging).
- `think()` is used by **autonomy**: when `enableAutonomy` is true, the autonomy service registers one recurring section; a BATCHER_DRAIN task in the task system drives when that affinity drains (task system owns WHEN, batcher owns HOW). **Why:** one register for "what to ask" and the same orchestration path as evaluators and startup, with the same cache and packing benefits. Autonomy keeps using `onResult` because it is fire-and-forget per drain.
- `askNow()` supports blocking audits without creating a second subsystem. Returns a promise of the **fields** (unwrapped). **Why:** same thenable style as askOnce; fallback is required so the caller always gets an object.

Result shape and errors:

- Section promises (from `addSection` / `onDrain`) resolve with **`BatcherResult<T> | null`**: `{ fields: T, meta: DrainMeta }`. **Why:** callers get both the extracted data and drain metadata (e.g. `meta.fallbackUsed`, `meta.durationMs`) in one object; `null` means duplicate section ID so the caller can branch.
- When **onResult** throws or the batcher is **disposed**, the section promise **rejects** instead of resolving. **Why:** callers can `.catch()` or try/catch for real failures; fallback-used still resolves (with `meta.fallbackUsed: true`) so "soft" failure is not an exception.
- **Generic `onDrain<T>(...)`**: pass a type param so `result.fields` is typed (e.g. `onDrain<ReflectionFields>(...)`). **Why:** avoids casting at call sites; the runtime still returns `Record<string, unknown>` from the model—the generic is for developer convenience.

Important behavior:

- Sections are idempotent by ID, so developers can register them from handlers without tracking lifecycle manually.
- The promise returned by `onDrain` (or `addSection`) **resolves once**—on the first delivery for that registration. **Why:** per-drain sections run on every drain, but the thenable is for "give me the result of this registration"; subsequent drains do not resolve the same promise again. For recurring delivery (e.g. every drain), use the optional `onResult` callback.
- Context is declarative and composable: `providers`, `contextBuilder`, and `contextResolvers` can be mixed.
- Dispatching is affinity-aware, so unrelated prompt sections are not merged into the same call just because they arrived at the same time.

Relevant runtime knobs (all `PROMPT_BATCHER_*`, read in `src/runtime.ts`):

| Setting | Default | Accepted values |
| --- | ---: | --- |
| `PROMPT_BATCHER_BATCH_SIZE` | `8` | Positive integer |
| `PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS` | `30000` | Positive integer |
| `PROMPT_BATCHER_MAX_SECTIONS_PER_CALL` | `8` | Positive integer |
| `PROMPT_BATCHER_PACKING_DENSITY` | `0.85` | Finite number from `0` through `1` |
| `PROMPT_BATCHER_MAX_TOKENS_PER_CALL` | `24000` | Positive integer |
| `PROMPT_BATCHER_MAX_PARALLEL_CALLS` | `2` | Positive integer |
| `PROMPT_BATCHER_MODEL_SEPARATION` | `1` | Finite number from `0` through `1` |

Absent or blank values use the defaults. Invalid explicit values fail runtime
construction with `PROMPT_BATCHER_CONFIG_INVALID` so malformed deployment
configuration cannot silently disable batching resource bounds.

The prompt batcher implementation lives in `src/utils/prompt-batcher/` (`batcher.ts`, `dispatcher.ts`). The lower-level queue primitives (`PriorityQueue` / `BatchProcessor` / `TaskDrain` / `BatchQueue`) live in `src/utils/batch-queue/`.

### Task system

The **task system** is the single place for *when* scheduled work runs. Only tasks with tag `queue` are polled by the scheduler (TaskService); other tasks (e.g. approval, follow-up) are stored and executed only when explicitly triggered (e.g. choice action, or `executeTaskById`).

**Why one scheduler:**

- Recurring work (e.g. batcher drains, future cron-like use) uses the same DB, same pause/resume, same visibility (`getTaskStatus`, `nextRunAt`, `lastError`). Retry and backoff (exponential backoff, auto-pause after `maxFailures`) live in one place so we avoid infinite retry storms.

**Why queue + repeat:**

- Tasks with `tags: ["queue"]` are fetched every tick. Non-repeat tasks run when `now >= dueAt` (or `metadata.scheduledAt`) then are deleted; repeat tasks use `updateInterval`/`baseInterval` and `metadata.updatedAt` as last-run time. **Why:** One-shot "run at time X" (e.g. follow-up) uses `dueAt`; interval-based scheduling covers batcher drains and recurring use.

**Why `utils/batch-queue`’s `TaskDrain`:** several services create the same style of repeat drain task (`queue` + `repeat`, `maxFailures: -1`, interval metadata). Centralizing find/create/update/delete avoids each caller re-implementing JSON/metadata edge cases and keeps worker registration rules explicit (`skipRegisterWorker` when TaskService already owns the worker name). Implementation in `src/utils/batch-queue/`.

**Cross-runtime scheduling (three modes):**

1. **Local timer (default):** One `setInterval` per TaskService; each runtime fetches its own queue tasks every tick. **Why:** Zero config for single-process apps.
2. **Per-daemon:** Host calls `startTaskScheduler(adapter)`; one shared timer runs, one batched `getTasks(agentIds)` per tick for all registered runtimes, then tasks are dispatched to each runtime’s `runTick(tasks)`. **Why:** Multi-agent daemons avoid N DB queries per second.
3. **Serverless:** Construct runtime with `{ serverless: true }`; no timer. Host calls `taskService.runDueTasks()` from cron or on each request to run due queue tasks once. **Why:** No long-lived process; host controls when tasks run.

**Public API (TaskService):** `executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`, `markDirty`, `runDueTasks()` (serverless). **Why:** Operators and UIs can run, pause, resume, and inspect tasks without touching the DB directly.

The implementation lives in `src/services/task.ts` and `src/services/task-scheduler.ts`.

Repeat-task failures may carry an `ElizaError.retryAt` epoch-millisecond deadline.
The existing scheduler persists the later of that deadline and its normal backoff,
including early-run tolerance, then restores the base cadence on success. Failure
counts and operator pause policies still apply. Background evaluators preserve
structural temporary-provider retry timing through their result errors; malformed
hints and explicit credit exhaustion keep the ordinary failure policy. A provider
cooldown must not spend all memory-job retries before the provider window resets.

### Autonomy

The autonomy service lets the agent "think" and act on a schedule without user messages. It uses the **prompt batcher** with the **task system** for scheduling: when `enableAutonomy` is true, a recurring section is registered with `think("autonomy", ...)`. A BATCHER_DRAIN task for the autonomy affinity determines when the section drains; results are delivered to `onResult`, which runs the same post-LLM steps as the message pipeline (actions, memory, evaluators) via an execution facade.

Why batcher-only:

- The batcher owns "what to ask"; the task system owns "when" (per-affinity BATCHER_DRAIN tasks). One scheduling surface and one packing path. Evaluators used after autonomy runs are the same as for user messages; as more evaluators move to the batcher, autonomy benefits automatically.

### AgentRuntime

The `AgentRuntime` (`src/runtime.ts`, `class AgentRuntime implements IAgentRuntime`) is the heart of the system. It manages the agent's lifecycle, loads plugins, orchestrates the message loop, and is the central point for actions, providers, and evaluators. It is initialized with a set of `Plugin`s; foundational actions, providers, evaluators, and services ship as the `basicCapabilities` bundle (`src/features/basic-capabilities/index.ts`).

### Actions

Actions define specific tasks or capabilities the agent can perform. Each action typically includes:

- A unique `name`.
- A `description` explaining its purpose and when it should be triggered.
- A `validate` function to determine if the action is applicable in a given context.
- A `handler` function that executes the action's logic.

Actions enable the agent to respond intelligently and perform operations based on user input or internal triggers.

Before routing, the response handler receives an `available_actions` discovery
catalog containing every eligible action's name. Direct-text turns use a complete
name index when smaller; the planner reads full descriptions, contexts and aliases
through `DISCOVER_TOOLS names=[]`, and loads schemas by exact name. Voice, group
and coding paths (and any turn where it renders shorter than the index) retain
the complete inline reference: one `NAME: description` line per eligible
umbrella action. Aliases resolve server-side, contexts come from
`available_contexts`, and promoted sub-actions are represented by their parent,
since each virtual repeats the parent's description and Stage 1 routes by
family. Discovery checks the current actor, delivery audience, connector
policy, and action validation under the action's declared routing contexts. This
catalog is rebuilt for each turn. Direct text places its complete current content
before changing history and provider text so an identical authorized catalog can
reuse the model's prefix cache. It remains a dynamic segment, outside the system
prefix; role, availability and registration changes still rebuild it normally.
The names-only index sorts complete names consistently; the planner's ranked
action list and complete reference retain their original order.
The planner then receives native tools with parameter schemas and checks
authorization again before executing; discovering an action does not execute it.

Model-facing action, provider, and analytics results preserve complete records.
For example, detailed `TRUST action=evaluate` results return every evidence
record, follow-up suggestions return every qualifying contact, relationship
analytics page through all shared messages before returning every distinct
topic, and channel-topic search returns every matching room. Large inventories
must use an explicit, lossless page or reference contract when they cannot be
returned in one result.

Initial progressive tool loading treats Stage-1 names as discovery hints. When
both a parent family and its registered child are named, the child's complete
schema loads first and the parent remains available through `DISCOVER_TOOLS`.
A parent-only hint or explicit discovery request still loads the complete
family. This avoids redundant polymorphic schemas without changing action
arguments or permission checks. Coding, deterministic execution, and legacy
callers without discovery keep their existing surfaces.
Successful catalog and schema reads are internal read-only results. When the
planner explicitly declares more work pending, the existing settled-read gate
returns their complete result to planning without an intermediate completion
model call. Failures, pauses, final completion and execution checks remain on
their normal paths.

`promoteSubactionsToActions` accepts an authored `parameters` override for each
operation. Promotion still pins its discriminator and delegates through the
parent's handler and gates; the parent and other operations retain their
original contracts. Use this for operation-specific nested schemas whose
fields cannot be described by top-level parameter applicability alone.

**Private actions.** Set `private: true` on an action to reserve it for the agent's own autonomous loop. A private action is never exposed to the planner — and is rejected by the executor as a defense-in-depth backstop — on user-driven turns; it can only be selected and run when the triggering message is an autonomous self-prompt (`content.metadata.isAutonomous === true`, the marker the autonomy service stamps). Use this for self-initiated capabilities the agent should decide to invoke on its own — e.g. minting a coin or opening a position — rather than ones a user can trigger on demand. The gate lives in `src/runtime/private-action-gate.ts`.

### Providers

Providers are responsible for supplying data and context to the `AgentRuntime` and its components. They can:

- Fetch data from external APIs or databases.
- Provide real-time information about the environment.
- Offer access to external services or tools.

This allows the agent to operate with up-to-date and relevant information.

### Evaluators

Evaluators analyze conversation data and other inputs to extract meaningful information, build the agent's memory, and maintain contextual awareness. They help the agent:

- Understand user intent.
- Extract facts and relationships.
- Reflect on past interactions to improve future responses.
- Update the agent's knowledge base.

### Database adapter

The runtime talks to persistence through the `IDatabaseAdapter` interface. Adapters (e.g. plugin-sql, plugin-localdb, InMemory) implement this contract so the same runtime code works with different backends.

**Why mutation methods return `Promise<boolean>`:** Methods such as `updateAgents`, `deleteAgents`, and `deleteParticipants` return a boolean so callers can tell success from failure. That supports error handling, retries, and UX (e.g. "Agent removed" vs "Failed to remove"). All adapters use this convention for consistency. See `packages/core/src/types/database.ts` for full JSDoc and design notes.

## Getting Started

### Initializing a runtime

```typescript
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  character,           // a Character (type in src/types/agent.ts; helpers in src/character.ts)
  plugins: [
    // your plugins; each contributes actions/providers/evaluators/services
  ],
  // other AgentRuntime options
});

await runtime.initialize();
```

Foundational actions, providers, evaluators, and services are available as the `basicCapabilities` bundle and its parts (`basicActions`, `basicProviders`, `basicEvaluators`, `basicServices`) exported from `@elizaos/core`. There is no `corePlugin` singleton — compose the bundles you need or rely on a higher-level package (e.g. `@elizaos/agent`) to wire them.

### Defining a custom capability

A custom action implements the `Action` type (`src/types/`):

```typescript
import type { Action } from "@elizaos/core";

export const customGreet: Action = {
  name: "CUSTOM_GREET",
  description: "Greets a user in a special way.",
  validate: async (runtime, message) => message.content.text?.includes("special hello") ?? false,
  handler: async (runtime, message, state, options, callback) => {
    await callback?.({ text: "A very special hello to you!" });
    return { success: true };
  },
  examples: [],
};
```

Register it via a `Plugin` (`{ name, actions: [customGreet] }`) passed to the runtime. Providers and evaluators follow the same pattern against the `Provider` / `Evaluator` types.

## Development & Testing

The package uses **vitest**. From the repo root:

```bash
bun run --cwd packages/core test          # vitest run
bun run --cwd packages/core test:watch    # watch mode
bun run --cwd packages/core test:coverage # with v8 coverage
bun run --cwd packages/core typecheck     # tsgo --noEmit
```

For agent-facing notes on layout, the public surface, and how to extend the runtime, see [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md).

---

Experience retrieval orders candidates by semantic similarity, then quality for equal scores; confidence cannot promote a weaker match above a stronger one. The complete candidate set and embedding-failure fallback remain available. Incremental background extractors share provenance instructions once while retaining independent source sets and edited/deleted evidence contracts.

Foreground history uses compact source labels and exact-repeat references without discarding stored or model-readable conversation evidence. Settled-result reply-only rounds use a smaller default instruction set, preserve original-context restoration, and cannot execute tools again. Custom prompt policies and ordinary planning remain intact.

A bare "Got it." is an acknowledgement, not evidence that work remains.
Withheld Stage-1 reply drafts remain in planner context as undelivered evidence,
including any conditions or confirmation requirements. They prove neither
permission nor execution. A non-coding planner's nonempty terminal proposal can
reach the existing completion evaluator before a required tool runs; a CONTINUE
verdict still requires outstanding work. A textless REPLY can propose that
same saved draft for evaluation; without a draft it remains rejected. This does
not add evaluation before ordinary action planning or change coding routing.

Stage-1 routing still honors explicit pending effects, required tools, selected
actions and intents. Genuine progress promises retain their existing checks;
the acknowledgement alone must not reopen a completed conversational turn.

Reply-only recovery captures reuse the same exact-repeat encoding when the
original context enables it. Every dialogue occurrence remains recoverable;
current instructions, providers, tool results and pending work stay complete.
The persisted recovery string includes its reference anchors and legend, so a
later retry does not depend on an in-memory lookup. Legacy captures remain valid.

Reply grounding repair supplies the complete wallet provider observations admitted
by its holdings validator, rather than serializing the entire runtime provider
store again. Saved recovery context, constraints, settled results and receipt
validation remain unchanged; this does not cap or summarize their contents.
Structured repair payloads are JSON-encoded once on the model wire. Exact saved
context strings and nested evidence retain their original values; ordinary
action callback text keeps its string encoding. Durable recovery records do not
change format.

The optional `historyRetention` evaluator reviews original dialogue through the existing background memory worker. Its committed source-bound checkpoint lets direct text chat keep standing constraints, unfinished work, new messages and the current exchange in the first request, while other originals remain available through `history:hN` and `history:all` context reads. Reads complete before a reply or action is processed; changed sources or authorization restore full current context. Stored messages remain unchanged. The advanced-memory plugin registers this evaluator when the existing advancedMemory feature is enabled; it remains excluded from the basic bundle. Group and voice sources do not schedule history review. A missing or invalid index keeps complete authorized history while the existing worker builds a committed checkpoint. Initial review consumes model quota separately from foreground replies; measure that cost when enabling advanced memory.

While reviewed history is projected, Stage 1 selects supplied originals with `relevant_prior_dialogue` and requests more history through `contextRequests`, including `history:all`. Incomplete selections and legacy full-mode outputs still restore originals safely. A contradictory simple/none reply with pending intents may first receive one response-contract repair when its incomplete selection matches the current source set, selects only supplied originals and requests no additional context. The model must resolve the selection itself; an incomplete retry restores full history. Explicit reads and malformed, stale or deferred-source selections retain restoration before field processing. Full restoration reinstates the normal model schema and history policy; no read decision executes a draft or effect.

When an original's source ID is unknown, `contextRequests=["history:search:literal phrase"]` searches the same authorized conversation by case-insensitive literal substring. Queries in one read return the union of all complete matching originals, without a result cap or summary. A first literal miss returns a source-bound zero-match result with the complete scanned-source count. It proves only exact substring absence, never that a fact or topic was not discussed. Semantic uncertainty and an incomplete decision still restore all originals; a subsequent no-progress read also restores them instead of looping. Search uses the same fresh source and authorization checks before any draft processing or effect, and is available only while the optional history projection is active.

An explicit DISCOVER_TOOLS names=[] read refreshes the complete registered catalog through canonical candidate admission, including each candidate's declared contexts, instead of treating Stage 1 routing as a permanent discovery boundary. Role, privacy, context, account-policy and availability checks remain active. This read returns authorized descriptions and child names without loading schemas or executing domain work; exact-name requests still load only their selected operations.

Action discovery records aggregate count, elapsed time, maximum time and thrown
checks for connector-policy and availability validation in one timing span.
Default metadata stays constant in cardinality as the catalog grows. Set
`ELIZA_INFERENCE_TIMING=1` to include every per-action check while debugging;
these opt-in records can be large. Neither form is model context. Stage-1
sender-role lookup and context construction have separate spans; nested spans
overlap and must not be added together as independent latency.

When original conversation history is available through source references, a
recall question itself calls for reading a missing dependency. Omission from
the supplied selection does not establish absence. The current-turn boundary
uses that retrieval policy instead of limiting answers to initially visible
chat; full-context and tool-planning boundaries remain unchanged. Original
speaker/correction evidence and current app-record verification stay distinct.
