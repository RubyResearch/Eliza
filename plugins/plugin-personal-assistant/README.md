# `@elizaos/plugin-personal-assistant`

LifeOps is the elizaOS app that runs the user's day: routines, goals,
calendar, email, messaging, follow-ups with people, blockers, watchers, and
the operational glue around them. This README is the architecture summary
for contributors.

## Mail and calendar connections

The focused `/lifeops/connections` view owns cross-domain onboarding and
connection recovery for Gmail, Google Calendar, and Apple Calendar. It does
not duplicate the inbox or calendar product views. The surface explains OAuth
capabilities before redirect, exposes EventKit permission recovery, lets the
owner choose calendars and a bounded 7/30/90-day seed window, and reports
Gmail History cursor plus per-calendar source health.

Seeding is a server-side use-case, not a client computation.
`POST /api/lifeops/gmail/seed` walks every Gmail page for the selected
7/30/90-day range and returns a `LifeOpsGmailSeedReceipt` whose
`messageCount` is never page-capped; a range that cannot be fully imported
fails with a typed error (`LIFEOPS_GMAIL_SEED_INCOMPLETE` or
`LIFEOPS_GMAIL_SEED_PAGINATION_REPEATED`) and no receipt.
`POST /api/lifeops/calendar/seed` force-syncs the selected calendars and
returns a `LifeOpsCalendarSeedReceipt` only when every source is fresh. The
view renders these receipts; it does not recount events or messages.

Disconnect and local-data purge are deliberately separate operations.
Disconnect stops credential use while preserving the imported projection
unless the request sets `purgeImportedData: true`; the standalone purge
requires a fresh confirmation, is scoped by provider, side, grant, and
connector-account identity, and returns a receipt with `providerMutation:
false`. Provider email and events are never deleted by this purge.

The no-provider browser acceptance harness uses deterministic adapters and an
isolated port (41873 by default):

```bash
bun run --cwd plugins/plugin-personal-assistant test:connections:e2e
```

## Undated todo lifecycle

Undated owner todos remain task definitions with `cadence.kind = "unscheduled"`.
They never acquire a synthetic occurrence, due date, or reminder. The Todo read
service combines these definitions with the existing scheduled occurrences;
`GET /api/lifeops/todos` identifies each target with `targetKind: "definition" |
"occurrence"`, its stored ID, and a nullable due date.

`OWNER_TODOS` supports `complete` and `reopen` for undated definitions. HTTP
clients use `POST /api/lifeops/definitions/:id/complete` and `/reopen` under the
existing owner authorization boundary. Completion changes `active` to
`completed`; reopening restores `active`. The scoped definition update and its
audit commit atomically. Repeating the desired state preserves the record
revision and returns a no-op without another audit. Paused, archived, scheduled,
and non-task definitions cannot use this transition; scheduled tasks retain
occurrence completion. Completed undated todos stay visible in the read DTO.

A supplied deletion target constrains that operation even when the complete
message names other records for later steps. Exact IDs and titles retain their
identity through owner and keep/leave exclusions; missing or excluded targets
cannot be replaced by another named record. An empty optional target does not
hide an explicit title. Existing unambiguous title aliases remain supported;
enumerated deletion applies only when no single target was supplied.

## Definition creation retries

Owner definition creation accepts an optional `idempotencyKey` (1–256 non-NUL
characters). Keep the same key and complete request for retries of one authorized
operation; use distinct keys for deliberately separate identical items. Tool-call
IDs are transport identities and must not replace this operation identity.
Unkeyed owner actions retain their existing content-based confirmation behavior.
The canonical model-tool boundary treats an empty or whitespace-only optional
key as omission, using the shared `modelOmissionSentinels` contract. This lets
strict providers represent an unused field on reads and mutations that do not
create definitions. Direct domain calls still reject an explicitly empty key;
nonempty tool keys retain the normal length and content validation.
When an owner call has no explicit `intent` argument, its full initial message
remains stored as provenance; different retry wording does not change the
operation identity. Explicit intent and all other semantic arguments still
participate in conflicting-key checks.

The key is scoped to the runtime agent, acting owner, target ownership, and create
operation. The existing audit table atomically claims it with the definition
insert and records completion after creation effects succeed. Completed replays
return the existing scoped record and a replay receipt. Conflicting request reuse,
deleted or inaccessible records, and interrupted effects return typed errors;
an uncertain operation never silently dispatches another creation. Audit identity
survives runtime restart and definition deletion. Legacy audit rows remain unkeyed.

## Scheduled items, not generic tasks

Every reminder, check-in, follow-up, watcher, recap, approval surface, and
nag-the-user-when-they-go-quiet flow is a **LifeOps scheduled item** stored
as a `ScheduledTask` record and owned by the runner at
`plugins/plugin-scheduling/src/scheduled-task/runner.ts` (the personal-assistant
side wires it in via `src/lifeops/scheduled-task/{service,scheduler,runtime-wiring}.ts`).
There is no second LifeOps scheduling mechanism.

`ScheduledTask` is intentionally not the repository-wide "task" primitive.
Core runtime tasks are persisted `Task` rows handled by `TaskService`; coding
agent work is orchestrator/task-coordinator state; project and feature tasks
may have their own plugin-owned records. LifeOps integrates with those
surfaces through public plugin/runtime contracts instead of importing or
owning them as LifeOps primitives.

The shape:

```ts
interface ScheduledTask {
  taskId: string;
  kind: "reminder" | "checkin" | "followup" | "approval" | "recap" | "watcher" | "output" | "custom";
  promptInstructions: string;
  contextRequest?: { /* owner facts, entities, relationships, recent task states, event payload */ };
  trigger: /* once | cron | interval | relative_to_anchor | during_window | event | manual | after_task */;
  priority: "low" | "medium" | "high";
  shouldFire?: { compose: "all" | "any" | "first_deny"; gates: Array<{ kind: string; params? }> };
  completionCheck?: { kind: string; params?: ...; followupAfterMinutes? };
  escalation?: { ladderKey?: string; steps?: EscalationStep[] };
  output?: { destination: ...; target?: string; persistAs?: ... };
  pipeline?: { onComplete?, onSkip?, onFail? };
  subject?: { kind: "entity" | "relationship" | "thread" | "document" | "calendar_event" | "self"; id: string };
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: "default_pack" | "user_chat" | "first_run" | "plugin";
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}
```

The runner pattern-matches **only** on the structural fields above
(`kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`, `output`,
`subject`, `priority`, `respectsGlobalPause`). It never inspects
`promptInstructions` content. This is non-negotiable.

The canonical task contract is exported by `@elizaos/plugin-scheduling`.
Both the runner and the `first-run` module consume its `ScheduledTask` and
`ScheduledTaskInput` types; personal-assistant must not define a parallel task
shape.

### No-reply semantics

Completion timeouts are structural scheduler behavior, not prompt text. For
scheduled items that wait on a user reply, personal-assistant resolves a
persisted no-reply contract from `metadata.noReplyPolicy` plus
`metadata.noReplyState` and applies it in the single scheduler timeout pass:

```ts
metadata: {
  noReplyPolicy?: {
    maxRetries: number;
    retryCadenceMinutes: number[];
    terminalStatus: "skipped" | "expired" | "failed";
    terminalReason: string;
    sensitive: boolean;
    allowCrossChannel: boolean;
    allowNonOwnerNotification: boolean;
  };
  noReplyState?: {
    retryCount: number;
    lastTimedOutAt?: string;
    nextRetryAt?: string;
    terminalReason?: string;
    terminalOutcome?: "skipped" | "expired" | "failed" | "denied";
  };
}
```

Defaults are deliberately conservative:

- reminders retry once after 60 minutes, then `skipped`;
- check-ins retry once after 24 hours, then `expired`;
- non-sensitive approvals retry after 30 minutes and 2 hours, then `expired`;
- sensitive approvals retry once after 30 minutes, then expire with
  `terminalOutcome: "denied"`;
- cross-channel escalation and non-owner notification default to `false`.

No no-reply path may auto-execute a sensitive output. Silence on money, data,
or external-send approvals fails closed. No-reply expiry is not a user skip, so
approval expiry does not fire `pipeline.onSkip`; authored skip pipelines remain
reserved for explicit skip transitions.

## Runtime layout

```
src/lifeops/
  scheduled-task/        Spine: runner, state log, gate registry,
                         completion-check registry, escalation, runtime
                         wiring.
  entities/              Entity primitive: store, merge engine, types.
  relationships/         Relationship edges: store, observation
                         extraction, types.
  registries/            AnchorRegistry, EventKindRegistry, FamilyRegistry,
                         BlockerRegistry, app/website blocker contributions.
  signals/               ActivitySignalBus.
  channels/              ChannelRegistry, priority-posture map, default
                         channel pack.
  connectors/            ConnectorRegistry + per-connector contributions
                         (calendly, discord, duffel, google, imessage,
                         telegram, twilio, whatsapp, x).
  oracles/               Typed weather, route-matrix, and local-activity
                         observations with provenance and source health.
  food/                  Constraint-safe meals, inventory confidence, and
                         approval-bound shopping-list handoffs.
  household-operations/  Vendor/service history, seasonal windows, child-item
                         evidence, C/P/E/M ownership, and weekly briefs.
  send-policy/           Per-connector send-policy contract + registry.
  owner/                 OwnerFactStore.
  first-run/             FirstRunService, state store, customize
                         questions, replay.
  pending-prompts/       PendingPromptsStore (the planner-visible
                         "questions waiting for the user" surface).
  global-pause/          GlobalPauseStore.
  handoff/               HandoffStore (per-room handoff state).
  i18n/                  MultilingualPromptRegistry.
  graph-migration/       Migration into the entity/relationship graph.
  seed-routine-migration/  Migration off legacy seed routines.
  ...other LifeOps-owned helpers (calendar, email, messaging, payments,
                                  subscriptions, assistant workflows, etc.)
```

## Parenting-agreement knowledge

Parenting agreements upload through resumable, independently hashed 4 MiB
requests with their staging bytes in the runtime's canonical private
`IFileStorageService`; the complete document has no semantic size ceiling.
Commit requires every ordered chunk and verifies the reassembled byte length
and optional whole-file SHA-256 before immutable storage. The server—not the
form—parses the page count. `PdfService.extractCompleteDocument` then accounts
for every page with native text plus rendered-page vision transcription of
every page. One failed page fails ingestion; partial content is
never published as a complete owner-private `DocumentService` record. LifeOps
persists the media SHA-256, handle, document id, byte size, MIME type, filename,
parser-derived page count, complete extracted text and page map, and version chain; it does
not create another permanent file store.

Each immutable agreement owns a distinct document ingestion identity. If artifact
persistence rejects the upload, ingestion removes that attempt's document,
derived fragments, and private PDF through the canonical services. A failed
commit observation preserves the sources for reconciliation; an incomplete
cleanup returns an explicit storage error and reports the affected artifact
and source handles to runtime diagnostics.

Owner- or agent-extracted obligations begin as `proposed` and must carry an
in-range page citation plus the cited source text. Only the owner can make the terminal
`approved` or `rejected` decision. Agent and chat pins are independent
discovery records and never confer access.

Owners choose **Prepare review** on an uploaded agreement, or request
`OWNER_AGREEMENT_KNOWLEDGE` with `prepare_review`. The owner-only
`POST /api/lifeops/agreements/:id/review` verifies the original PDF and saved
extraction against their ingestion hashes, sends complete page evidence to the
model, and validates every proposed citation against its claimed pages. Invalid
or incomplete output saves nothing. Generation creates unapproved proposals;
approval, pinning, sharing, scheduling, and delivery remain separate operations.

The proposal batch and its completion record commit atomically. Concurrent
requests and retries recover the first committed review, including later owner
decisions; `GET /api/lifeops/agreements/:id/review` restores it after reload.
A saved empty result is explicitly identified and does not certify that the PDF
contains no commitments. Owners must still inspect the original source for
omissions and interpretation errors. Each immutable agreement version has one
prepared review; failed attempts can be retried without partial proposals.

Review generation uses the canonical trajectory recorder when capture is
enabled, binding the model call to the artifact and source hashes. Existing
chat steps retain their context; direct owner requests get a standalone
trajectory. Reading or retrying a prepared review does not repeat generation.

The owner is the only implicit reader. A guest read requires a resource grant
bound to one exact household grant with `knowledge.read`; the guest entity must
have a verified identity, and both grants must remain unrevoked and unexpired.
Guest views expose approved obligations only. Revoking the relationship-backed
household grant immediately invalidates every agreement binding that relies on
it.

The owner permission selector reads
`GET /api/lifeops/agreements/:id/guest-options`. It lists verified people with
active `knowledge.read` permissions in the agreement's household, retaining the
exact household grant behind each named choice. Expired, revoked, wrong-scope,
and other-household permissions are excluded. Existing agreement bindings stay
available for owner removal even when their underlying permission is inactive.
Changing the selected person or permission invalidates the preview. Enabling
access revalidates the exact permission in the domain, and the UI confirms the
saved binding by reading it back; uncertain writes require refresh before retry.
The selector does not create identities, verify contacts, or issue household
permissions implicitly.

A knowledge-only household grant may explicitly supply `subjectEntityIds: []`.
Omitting the field remains an invalid action request. The canonical scope
expansion includes basic `household.visibility` with `knowledge.read`; it adds
no calendar authority. Non-owner calendar grants still require at least one
subject from the principal's household relationship.

A paired guest reads `GET /api/lifeops/agreements/:id/shared` using its machine
session. The owner must bind that machine identity to a person through
`POST /api/lifeops/entities/:id/auth-bindings` and explicitly issue the household
and agreement grants. The shared route derives the person from the verified
session binding; caller-supplied principal IDs and role headers cannot select
another reader. It returns approved clauses and limited metadata with no-store
caching. Original PDF downloads, exports, review history, and mutations remain
owner-only. Use the normal owner read route for owner requests.

The owner surface is available through `OWNER_AGREEMENT_KNOWLEDGE` and the
authenticated `/api/lifeops/agreements/*` routes. Grant previews enumerate the
exact read effects and exclusions before issuance. Active agent/chat pins feed
only approved, page-cited obligations into owner planner context; uploading a
PDF remains on the document/API surface so chat actions never invent bytes.

Owners can download the original PDF or export one agreement version from the
Agreement view. `POST /api/lifeops/agreements/:id/export` returns a ZIP containing
`original.pdf`, `manifest.json`, `SHA256SUMS`, and the exact saved
`extraction.json` when available. Verify the files independently with
`sha256sum -c SHA256SUMS`; the extraction hash also matches its ingestion audit
event. The versioned manifest includes all obligation
states and citations, current and inactive pin/grant records, linked household
grant expiry/revocation records, and the canonical agreement audit history from
one database snapshot. Original byte length and SHA-256 must match before export.

Agreement ingestion, review, pin, and grant transitions commit atomically with
`life_audit_events`. Export preparation records the manifest and archive hashes;
it does not assert that the browser received or saved the download. Legacy
versions explicitly identify missing extraction page maps and partial audit
history. Export never reconstructs unrecorded past activity. This agreement
archive does not replace workspace-wide export or deletion workflows.

## Default packs

Default packs are bundles of typed scheduled-item definitions compiled into
`ScheduledTask` records (and sometimes anchor-consolidation policies,
escalation ladders, autofill whitelists). LifeOps-owned packs live in
`src/default-packs/`:

- `daily-rhythm` — gm, gn, daily check-in.
- `morning-brief` — fired on `wake.confirmed`.
- `quiet-user-watcher` — daily watcher.
- `habit-starters` — eight habits, **offered** (not auto-seeded).
- `executive-assistant` — twenty-five scheduled records covering twenty
  personal/executive assistant scenario families, **offered** (not auto-seeded).
- `inbox-triage-starter` — opt-in, gated on Gmail.
- `followup-starter` — watcher firing per overdue relationship.
- `autofill-whitelist-pack`, `consolidation-policies`, `escalation-ladders`
  — policy-only packs.

`@elizaos/plugin-health` ships `bedtime`, `wake-up`, `sleep-recap` and
registers them when a health connector pairs.

### Adding a new default pack

1. Add a file under `src/default-packs/<name>.ts` that exports a
   `DefaultPack` matching `registry-types.ts`.
2. Define `ReminderTaskDefinition`, `CheckInTaskDefinition`,
   `WatcherTaskDefinition`, `ApprovalTaskDefinition`, `RecapTaskDefinition`,
   or `OutputTaskDefinition` values and compile them with
   `compileTaskDefinition` / `compileTaskDefinitions`. Pack files should not
   construct raw `ScheduledTaskSeed` records.
3. Import and append it to `DEFAULT_PACKS` in `src/default-packs/index.ts`.
4. If the pack should be **auto-enabled**, list it in
   `getDefaultEnabledPacks`. If it should be **offered** during first-run
   customize, list it in `getOfferedDefaultPacks`. If neither, the pack
   only seeds when invoked explicitly.
5. Run `bun run lint:default-packs` (also runs as `pretest`). The lint
   rules are embedded in `scripts/lint-default-packs.mjs`. CI rejects packs
   that violate them, including raw `ScheduledTask` construction.
6. Add a record-id constant export so consumers can target the records by
   stable ID.

The runtime never seeds packs by name string-match; everything goes through
`getAllDefaultPacks()`.

## Optional household-source credentials

- `GOOGLE_MAPS_API_KEY` enables Google Routes v2 travel matrices. The key is
  sent in the required request header, never in a URL or persisted result.
- `TICKETMASTER_API_KEY` enables Ticketmaster local-activity discovery.
- `INSTACART_API_KEY` enables an approved Instacart products-link handoff.
- `INSTACART_ENVIRONMENT=development|production` selects the documented
  Instacart endpoint and defaults to `production`.

Weather uses the public US National Weather Service API and therefore has
explicit US-only coverage. Missing credentials or source outages produce
`unavailable` observations rather than healthy empty results. An Instacart
products link is only a review handoff: it is not evidence of cart contents,
checkout, an order, payment, delivery, or a substitution decision.

## Knowledge graph

`EntityStore` (nodes) and `RelationshipStore` (edges) at
`src/lifeops/entities/` and `src/lifeops/relationships/`. The graph is
per-agent. The `entityId === "self"` row is bootstrapped on first use.

- **Cadence lives on the edge.** "Pat — every 14 days" is a
  `Relationship`, not an `Entity` attribute. Cadence-bearing
  `ScheduledTask`s use `subject.kind = "relationship"`.
- **Identities are observed.** `(platform, handle)` pairs route through
  `observeIdentity`; the merge engine in `entities/merge.ts` collapses
  entities with high-confidence identity matches. Manual merges go through
  `POST /api/lifeops/entities/merge` and are audited.
- **REST surface** — the main plugin registers the authenticated handlers in
  `src/routes/`. The standalone `personalAssistantRoutesPlugin` export remains
  available to hosts that compose only the HTTP surface.

## Pause and handoff

- **Global pause** (`global-pause/store.ts`) — stops every
  `ScheduledTask` with `respectsGlobalPause: true`. Toggleable via UI or
  `/api/lifeops/app-state`.
- **Per-room handoff** (`handoff/store.ts`) — flips a multi-party room
  into handoff after the agent says "I'll let you take it from here."
  Typed resume conditions (`mention | explicit_resume | silence_minutes |
  user_request_help`). The `RoomPolicyProvider` reads
  `HandoffStore.status(roomId).active` and gates further agent
  contributions.

## Brief engagement feedback

`BRIEF` persists impressions only for structured item titles that actually
appear in a successfully delivered narrative; a JSON action result or a failed
callback is not treated as owner visibility. Rows retain the producing
trajectory identity. Authoritative same-day domain mutations can attribute
`opened`, `replied`, `completed`, `rescheduled`, or `kept` outcomes through
`LifeOpsRepository.attributeBriefItemEngagement`; occurrence completion is the
first production bridge. Shipped authoritative bridges also cover occurrence
snooze and calendar time updates (`rescheduled`), Gmail mark-read (`opened`),
and provider-confirmed Gmail replies (`replied`). A real `kept` meeting remains
reserved for a future explicit attendance/outcome contract; elapsed wall-clock
time alone is not fabricated as engagement. Attribution uses the rolling 24-hour delivery window,
so an owner-local day crossing UTC midnight remains linked without making UTC
midnight a behavioral boundary. Expired unacted delivery windows finalize
idempotently as `ignored` when the brief path next runs.

Provider retries carrying the same domain event ID collapse to one row. Two
distinct provider event IDs remain distinct even when item, engagement type,
and timestamp are identical, so neither authoritative mutation is overwritten.

Editorial recalibration reads a rolling 30-day window. Explicit `demoted` and
`restored` markers control ranking without conflating a restore command with a
real kept meeting. Non-zero engagement rewards settle onto the original
morning-brief trajectory through the trajectory service's idempotent delayed
reward API, without reopening or rewriting a completed step.
Settlement uses a durable lease marker plus the trajectory's idempotent reward
receipt: an abandoned claim can be taken after its lease, and a crash after the
trajectory update is recovered by observing the already-applied receipt.
Recovery scans a bounded pending-outcome batch independently of the editorial
30-day window, so a long outage cannot strand an old reward. Completed receipts,
zero-weight outcomes, trajectory-less legacy rows, and outcomes with active
leases are excluded from that batch; an expired lease re-enters in chronological
order. A failed or missing trajectory retains a released marker and rotates by
last-attempt time, so one poisoned oldest row cannot starve newer pending
rewards. Operational markers are also excluded from editorial history reads.

## Plugin dependencies

LifeOps consumes `@elizaos/plugin-health` for sleep/circadian/health metrics,
screen-time action planning, health action planning, health-context formatting,
and health connector contributions.
The plugin contributes through the registries listed above (`AnchorRegistry`,
`ConnectorRegistry`, `FamilyRegistry`, default packs) and public factories such
as `createHealthActionRunner`, `createScreenTimeActionRunner`, and
`createHealthProvider`. LifeOps does not import directly into the health
internals; it consumes the plugin's public exports only. See
`plugins/plugin-health/README.md`.

## Cross-agent invariants

1. The runner never pattern-matches `promptInstructions`.
2. `subject.kind = "relationship"` for cadence-bearing tasks.
3. Identities are observed, not assigned.
4. Connectors and channels return typed `DispatchResult`. No `boolean`.
5. `shouldFire.gates` is always an array.
6. `acknowledged` ≠ `completed`. Pipeline `onComplete` only fires on
   `completed`.
7. Snooze resets the escalation ladder.
8. Global pause skips tasks with `respectsGlobalPause: true`.
9. Planner-facing owner inventories are complete: fixed-count slices must not silently hide approvals, delegation contracts, work threads, todos, or commitments.

## Where to look next

- Frozen interface types: `plugins/plugin-scheduling/src/scheduled-task/types.ts`, exported by `@elizaos/plugin-scheduling`.
- Prompt-content lint rules: `scripts/lint-default-packs.mjs`.
- Health domain: `plugins/plugin-health/README.md`.
- REST routes: `src/routes/`.

Owner review corrections use the same complete-source citation validation as
model-generated proposals. The Family Operations editor and owner action
`add_proposal` save an unapproved correction through the existing obligations
route. Identical corrections to the same immutable artifact recover the same
record and its current decision, including after restart or a lost response.
Saving a correction does not prepare a model review, approve, pin or share it.

### Family workspace export

The owner-only `POST /api/lifeops/family-workflows/export` downloads a ZIP with
all family agreement versions, retained school PDFs, monthly packet versions
and drafts, their approval records, and stored provider/school mutation receipts.
Each member has a SHA-256 checksum. Agreement archives preserve their existing
source/extraction and review/access provenance; packet and workflow records use
one database statement snapshot. The manifest records this component-snapshot
boundary and explicitly identifies uninitialized historical record stores.
Missing or changed retained PDF bytes fail export rather than producing a
healthy-looking partial archive. Connection credentials and executor lease
tokens are excluded. Export records preparation, not receipt by the client,
and does not revoke access or delete data.

## Selected correspondence and monthly drafts

Owner-selected correspondence is stored as a complete private document before
extraction. Direct extraction uses the canonical trajectory recorder when enabled,
binding the intake identity, review revision and source hash to the full model
input and output. Invalid model output records a failed attempt and leaves the
selection unchanged. Extraction inside a chat retains that chat's recording
context. Generated facts remain proposals without disclosure recipients until
owner review; recipient identities come from the canonical contact graph and need
not be UUIDs.

Monthly packet periods retain exclusive end dates in storage, while draft headings
show the inclusive final civil date. The unanswered summary uses the typed request
state across source categories after recipient filtering. A request already shown
under travel, school or scheduling receives a short follow-up entry; its original
claim and source binding remain single records. Resolved requests leave that
summary. Neither a prepared draft nor a successful extraction approves delivery.

## School source retention

School PDF bytes stay in the canonical media store. Each original PDF has a
private source-link document whose media reference is visible to the existing
media garbage collector. The record identifies the original PDF and its hash;
it is not a transcription or an approved agreement obligation. Repeated checks
reuse the same document instead of accumulating references.

Before retrieving a source, the leased school workflow verifies historical PDF
hashes and restores their document references. A missing or changed historical
source fails explicitly and requires recovery of its exact original bytes.
New PDFs gain their reference before a run can complete, including hash no-ops.
The workflow does not create another file store, collector, or reference counter.
