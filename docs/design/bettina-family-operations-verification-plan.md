# Bettina Family Operations Verification Plan

## Purpose

This plan defines the evidence required to call the owner-private Bettina MVP
working. It is traceable to the requirement identifiers in
`bettina-family-operations-product-design.md` and to GitHub issue #30123.

Passing a unit test, an authored scenario, a build, a healthy endpoint, or a
connector configuration probe is intermediate evidence. Completion requires
the exact merged source revision, persisted domain artifacts, authenticated UI
behavior, and the live provider boundaries named below.

## Proof layers

| Layer | What it proves | Required evidence |
| --- | --- | --- |
| Focused | A changed domain contract behaves correctly and rejects invalid input. | Behavioral unit and real-PGlite tests. |
| Package | The owning workspace compiles, formats, lints, builds, and passes its complete suite. | Command log with exit status. |
| Integrated local | The real local API, UI, database, scheduler, model and connector adapters compose correctly. | Full journey, database rows, logs, network trace and UI captures. |
| Repository | The branch satisfies repository-wide contracts. | `bun run verify`, `bun run test`, evidence integrity review. |
| Hosted | GitHub validates the exact PR head after its final rebase. | Terminal required checks tied to the 40-character head SHA. |
| Deployed | Bettina's public service serves the merged revision and preserves state across restart. | Process provenance, migration log, public probes and restart readback. |
| Live provider | Google and iMessage/Blooio perform real accepted operations for approved test identities. | OAuth/provider receipts, independent readback and destination inspection. |

## Test data policy

- Use synthetic children, co-parent, caregiver, health and agreement data.
- Never commit OAuth tokens, pairing codes, phone numbers, Apple identifiers,
  private messages, real family documents or VPS secrets.
- Keep provider identifiers and logs redacted in committed artifacts. Attach
  sensitive acceptance evidence only through the approved evidence channel.
- Create a dedicated disposable Google calendar under
  `shawgotbags@gmail.com`; remove its test events and revoke temporary grants
  after acceptance.

## Local environment

Run all implementation and validation in a clean worktree based on current
`origin/develop`. Do not use the shared dirty checkout.

```bash
git fetch origin
git worktree add <path> -b feat/bettina-family-operations origin/develop
bun install
export PGLITE_DATA_DIR="$(mktemp -d)/bettina-pglite"
```

`bun install` must initialize the pinned local-inference submodule, stage the
fused library and validate the embedding artifact without requiring a system
Node executable or a manual download.

## Requirement matrix

### Authentication and pairing

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| AUTH-1–AUTH-3 | Real HTTP pairing tests cover instance binding, restart/proxy routing and stable error codes for invalid, expired, disabled, not-ready, instance-mismatch, rate-limit and session failure. UI tests render each distinct recovery action. | Fresh browser pairs at the public URL without an SSH correction step. |
| AUTH-4 | One-time code replay, TTL and rate-limit tests. | Replay the accepted code and prove denial. |
| AUTH-5 | Session list/revoke tests with two independent credentials. | Revoke one browser session and prove its next request is unauthorized while the owner session remains valid. |

### Agreement knowledge and access control

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| KNOW-1–KNOW-4 | Real media-store plus PGlite ingestion tests retain exact original bytes, binary/content hashes, page maps and immutable version lineage; failed byte storage rolls back metadata, and rejected document/fragment/artifact writes remove only that upload's private sources. Concurrent duplicate rejection must preserve the winning version; uncertain commits preserve sources for reconciliation, and incomplete cleanup remains an explicit failure. Resumable-upload tests cover out-of-order chunks, exact replay, missing ranges, per-chunk and whole-file hash mismatch, and a document above the former 20 MiB ceiling. Complete-extraction tests cover native, image-bearing, text-empty, and verified-blank pages and reject one-page OCR/vision failure without partial success. | Upload born-digital, scanned, and mixed PDFs through the app; interrupt and resume one upload; restart, download and hash identical bytes; confirm early, middle, and final page canaries are searchable with their extraction method. |
| KNOW-5–KNOW-7 | Obligation lifecycle tests validate page/source citations and proposed/approved/rejected transitions. Pin tests prove only approved obligations are active and raw-PDF activation warns. | Review obligations in the UI and inspect agent context with and without each pin. |
| KNOW-8 | Manifest export test re-hashes original bytes, citations, obligations, pins, grants and audit entries. | Download and inspect the export. |
| ACL-1–ACL-3 | Agent/chat/household pin-target tests include cross-room denial and prove pinning never grants access. | Change a chat pin and show no recipient permissions changed. |
| ACL-4–ACL-8 | Verified-entity, read-only, child/purpose/data-class, expiry, revocation, relationship-change, restart and concurrency tests. | Grant one cited excerpt to the verified co-parent; deny unrelated document and child data; revoke and prove immediate denial. |
| ACL-9–ACL-11 | Direct API rejects public family sharing. UI tests show `Everyone using this agent`, recipient, subjects, purpose, data classes, expiry and effect before approval. | Desktop/mobile permission-preview inspection. |

### Calendar and Google synchronization

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| CAL-1–CAL-4 | Fresh PGlite creates a writable default Eliza calendar. UI creates, edits and deletes all-day and timed events without a provider. | Complete the same journey with no Google account configured. |
| CAL-5–CAL-8 | Mapping and linked-event PGlite suites persist Google calendar/event IDs, etag, local revision, last-common semantic hash and link state. Adapter tests cover Eliza-first and Google-first create/update/delete. | OAuth `shawgotbags@gmail.com`; approve mapping; prove create/update/delete independently in both UIs. |
| CAL-9–CAL-11 | Duplicate mutation/webhook, out-of-order notification, crash-before-receipt, crash-after-provider-write, replay, incremental token and controlled 410 resync tests. | Trigger a real webhook and correlate its channel to one sync run. |
| CAL-12–CAL-14 | Concurrent edit enters `conflicted`; unknown outcome enters `quarantined`; disconnect retains the local copy as `paused` and performs no provider call. | Create a real conflict, resolve it explicitly, disconnect and restart. |

### School calendar automation

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| SCH-1–SCH-4 | Workflow route/UI tests create a typed monthly 09:00 America/New_York task and support `Run now`. Discovery tests begin at the stable landing page and record resolved PDF URL, redirects and response metadata. | Create the workflow from chat/UI without CLI or database edits. |
| SCH-5–SCH-7 | SSRF, DNS-rebinding, redirect, MIME/signature, size and timeout rejection. Exact byte hash and retained artifact tests. Equal hash records a successful no-op. | Fetch the current Concord source and record its public URL and SHA-256. |
| SCH-8–SCH-12 | Two-column geometry fixtures cover page citations, child scope, ambiguous quarantine, stable event keys and semantic add/update/cancel/unchanged diff. Metadata-only byte changes produce no calendar mutation. | Inspect the complete first-import proposal and a changed-source proposal. |
| SCH-13–SCH-16 | Automatic-mode tests apply validated imports and revisions without per-run approval. Review-mode tests require approval of the exact changed plan. Both modes preserve ambiguity quarantine and event ownership; concurrent runs use one lease, crash/restart is idempotent, and run history reports actionable states. | Inspect the selected automatic mode, run an import and changed revision, rerun unchanged, then restart and rerun. Verify unrelated events remain untouched. Separately select review mode and prove a changed plan waits for approval. |
| SCH-17 | Corpus/source inventory assertion excludes expenses and financial data. | Inspect resulting event set. |

### Coordination packet and drafting

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| PACK-1–PACK-10 | Real-PGlite packet assembly binds every fact to provenance, separates missing/contradictory information, carries unanswered items once, versions internal packet and external draft independently, and excludes expense canaries. | Generate the month packet from synthetic persisted state and inspect every source link. |
| DRAFT-1–DRAFT-6 | Deterministic canary tests preserve dates, requests, urgency, commitments and accountability while removing insults/speculation; show material transformations; never invent apologies, legal or therapy conclusions, or delivery. | Provider-backed trajectory plus independent semantic judge and owner-visible diff. |

### Approvals, iMessage and audit

| Requirements | Automated proof | Local/live proof |
| --- | --- | --- |
| APPROVAL-1–APPROVAL-7 | Policy-table tests key decisions by verified recipient role, disclosed data classes and effect, not connector. Validated workflow-owned school changes follow the selected automatic/review mode. Exact envelope/body/attachment bytes are hash-bound; stale/tampered payloads fail; atomic claim, restart, duplicate and unknown outcomes are covered. | Approve one exact calendar mutation outside automatic school synchronization and one exact family message; alter each proposal and prove reapproval is required. Verify automatic school synchronization cannot modify unrelated events. |
| IMSG-1–IMSG-3 | Linux runtime may use the reviewed authenticated Blooio edge; native Messages remains macOS-only. Status tests distinguish configured, authenticated, webhook-ready, inbound-ready and last successful delivery. | Read back the actual selected transport and safe owner-only DM policy. |
| IMSG-4–IMSG-7 | Deterministic card renderer golden tests, privacy-redaction modes, exact-byte approval, expiring identity-bound link, wrong-identity/expiry/replay denial, cleanup and privacy-safe metadata tests. Ordinary pre-auth media routes cannot read the card. | Inspect card, message preview, lock screen and authenticated destination link. |
| IMSG-8 | Real dispatch test requires a provider receipt/readback; local adapter success cannot fabricate delivery. | Approved outbound plus inbound reply round-trip with signature, replay, tamper and unauthorized-sender rejection. |
| AUDIT-1–AUDIT-3 | Typed ledger covers source versions, reviews, pins, grants, workflow runs, approvals, mutations, sends and receipts using neutral activity language. | Inspect one complete journey timeline. |
| AUDIT-4–AUDIT-7 | Manifest export, dependency preview, immediate revocation across projections/links/context and purge tests for primary/derived/cache data. | Export, revoke, delete test workspace and confirm configured backup policy. |

## Focused commands

```bash
bun run --cwd packages/app-core test:auth
bun run --cwd packages/core test -- src/features/documents
bun run --cwd plugins/plugin-documents test
bun run --cwd plugins/plugin-calendar test
bun run --cwd plugins/plugin-scheduling test
bun run --cwd plugins/plugin-personal-assistant test
bun run --cwd plugins/plugin-imessage test
```

For every affected package, run its declared `typecheck`, `lint:check` or
`lint`, `format:check`, `build`, and complete test commands. Read the live
manifest rather than assuming a script exists.

## Integrated journeys

1. Fresh owner pairs, reloads, restarts the service and retains the session.
2. Owner uploads and reviews a synthetic agreement; approved obligations are
   pinned while the raw PDF stays owner-only.
3. Owner creates a bounded co-parent grant; permitted citation succeeds and
   unrelated data fails before and after restart; revocation is immediate.
4. Owner uses Eliza Calendar without Google.
5. Owner connects the Google test calendar and proves bidirectional CRUD,
   conflict, duplicate notification, unknown outcome and disconnect behavior.
6. Owner creates the Concord workflow in the selected automatic mode, runs a
   validated first import and changed revision without per-run approval, then
   reruns identical bytes as a recorded no-op. Verify unrelated events remain
   unchanged and ambiguous sources stay quarantined. Separately select review
   mode and prove a changed plan waits for exact-plan approval.
7. Owner generates a monthly packet and neutral draft with no expense data.
8. Owner reviews the exact recipient/disclosure/card envelope and sends through
   the configured iMessage edge; the recipient replies and the same thread is
   correlated without granting workspace access.
9. Owner exports, revokes and deletes the synthetic workspace.

## UI and evidence gates

Any affected app view must complete at least five capture, inspection and
iteration cycles through:

```bash
bun run --cwd packages/app audit:app
bun run --cwd packages/app test:e2e
bun run test:e2e:record:review
```

Review desktop and mobile rest/hover states, accessibility, browser console,
network log, backend log, full-page screenshots and MP4. No affected view may
retain a `needs-work` or `broken` verdict.

## Repository, PR and deployment gates

```bash
bun run check:agents-claude
bun run verify
bun run test
bun run test:matrix:review
bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>
```

Before PR review, fetch and rebase on current `origin/develop`, rerun affected
gates, and record the exact base and head SHAs. Merge only after terminal
required checks pass for that head.

Deploy the merged commit into an immutable VPS release directory. Preserve the
current unit definitions, secret-safe configuration, PGlite directory and
Tailscale route map. The service start must fail if the operator-login verifier
fails. Record the process working directory and Git SHA, then test public TLS,
auth wall, pairing, migrations, fused embedding probe, model calls, connectors
and restart persistence.

Rollback uses the prior immutable release and the matching pre-migration
database snapshot. Never start old code against an incompatibly migrated
database.

## Completion rule

The MVP is working only when every applicable matrix row passes at all required
proof layers. A blocked credential, OAuth consent, provider identity, Mac edge,
destination device, hosted check or deployed-state failure is reported as a
blocker; it is never converted into a local or mocked pass.
