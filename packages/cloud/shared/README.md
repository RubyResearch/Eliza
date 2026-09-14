# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, the server-side service library, transport types, and route/auth helpers. This is a private workspace library — there is no app or dev server here. Consumers import its source directly via subpath exports.

## Consumers

- `@elizaos/cloud-api` — Hono API on Cloudflare Workers; imports `lib/`, `db/`, `billing/`, `types/`.
- `@elizaos/container-control-plane` — Node service for Hetzner container provisioning.
- Server-side plugins that require Cloud database or service implementations.

## Source layout

```
src/
  index.ts        top barrel — re-exports billing/db/lib/types as namespaces
  billing/        pure, isomorphic markup math (applyMarkup, credit markup, Twilio SMS)
  db/             Drizzle layer — schemas/, repositories/ (CQRS), migrations/,
                  client.ts, database-url.ts, crypto/, utils/
  lib/            SERVER-ONLY services + use-cases — services/, auth*.ts,
                  api/ middleware/ cors/ http/ session/, stripe.ts, pricing.ts,
                  promotion-pricing.ts, utils/logger.ts
  types/          cloud-api.ts (DTOs), cloud-worker-env.ts, stripe-queue-message.ts
drizzle.config.ts            schema ./src/db/schemas, out ./src/db/migrations
scripts/messaging-gateway-preflight.mjs
docs/                        WHY docs (provisioning, messaging gateways)
```

Import via subpath: `@elizaos/cloud-shared/billing`, `/db`, `/db/repositories/apps`, `/lib`, `/lib/services/<x>`, `/types`. Exports map (`package.json`): `.` `./billing` `./db` `./db/*` `./lib` `./lib/*` `./types` `./types/*`.

Synthetic test consumers use `/db/repositories/synthetic-environment-leases`.
Its guarded callback receives the same locked PostgreSQL/PGlite transaction as
the generation check, so an old reset generation cannot commit afterward.
`/db/repositories/synthetic-world-commands` persists the storage-neutral
command journal in that transaction. Its PGlite contract test uses the real
agents repository to prove the domain mutation, transactional readback, result
serialization, and `COMMITTED` transition commit or roll back together.
The lease and subprocess authorities share the exact 512-character namespace
validator. Treat a transaction/transport exception as ambiguous and reconcile
the canonical snapshot before retrying an acquire, rollover, or release.

`src/lib/` is server-only. Browser surfaces in `packages/app` consume public
`@elizaos/cloud-sdk` contracts directly; legacy browser-safe paths here remain
compatibility exports, not the dependency boundary for new browser code.

## App billing account registration

`db/repositories/app-billing-accounts` owns unconfigured individual buyer accounts.
An interactive app creator registers an environment through
`POST /api/v1/apps/:id/billing/registration`; the immutable infrastructure payer
is the app's owning organization. Existing `appsRepository.connectUser` consent
and registration share the app row lock and materialize one account per
registration and user. Only the explicit OAuth approval marker is consent; analytics-only
app membership never creates or authorizes a billing account. Reads require current consent, active account/app state,
and either a user session or a currently valid source-app mobile credential.
General infrastructure API keys cannot authorize a buyer read.

These records contain no provider account/customer, subscription, trial claim,
or grant. Merchant and policy authority remain explicitly unconfigured. They do
not define workspace/team billing or trial eligibility, and deleting consent or
the app removes these unconfigured records. Historical organization billing
records are not adopted or modified. Migration `0381_app_billing_registration.sql`
must run before deploying the updated consent repository. Future lifecycle work
must extend the existing subscription journal rather than treat these account
records as a second lifecycle authority.

## Commands

```bash
bun run --cwd packages/cloud/shared typecheck            # tsc --noEmit
bun run --cwd packages/cloud/shared lint                 # biome check
bun run --cwd packages/cloud/shared lint:fix
bun run --cwd packages/cloud/shared test                 # bun test
bun run --cwd packages/cloud/shared db:generate          # drizzle-kit generate
bun run --cwd packages/cloud/shared db:migrate           # migrate-with-diagnostics.ts
bun run --cwd packages/cloud/shared db:migrate:drizzle   # alias of guarded db:migrate
bun run --cwd packages/cloud/shared db:studio            # drizzle-kit studio
bun run --cwd packages/cloud/shared db:check-migrations  # drizzle-kit check
bun run --cwd packages/cloud/shared preflight:messaging-gateways
```

There is no build step here (`build:linked-workspaces` defers to the repo-root `build:core`).

The paid Docker runtime guard has an explicit Linux/root integration lane:
`bun run --cwd packages/cloud/shared test:docker-compute-lease --image=<existing-local-image-id>`.
Use an existing image containing `/bin/sh`, `sleep`, and `cat`. The test creates
two containers with networking disabled and resource limits, exercises actual
start, renewal, expiry, stale-command rejection and retained data, then removes
only those containers. It does not pull images, supply agent credentials, install
a system service, or change the host clock. This host boundary test does not
establish that application billing and provisioning use the guard.

## Config

`db/database-url.ts` resolves the Postgres URL: explicit `DATABASE_URL` / `TEST_DATABASE_URL` (Railway in production) wins; otherwise local dev falls back to a file-backed PGlite store at `pglite://<cwd>/.eliza/.pgdata` (override the path with `PGLITE_DATA_DIR` / `LOCAL_DATABASE_PATH`). The `lib/` services read service-specific env (Stripe, Steward session/JWT secrets, BitRouter/provider keys, Telegram/Discord/WhatsApp, Hetzner/container infra). See `.env.example` for the full set.

## More

See [CLAUDE.md](./CLAUDE.md) for the migration workflow, how to add tables/services/DTOs, and the architecture rules (CQRS, server-only `lib/`, append-only migrations). WHY docs live under `docs/`.

## Terminal Stripe lifecycle reconciliation

The existing Stripe webhook queue calls `stripe-terminal-lifecycle` for updates
and deletions of known organization subscriptions. It retrieves the subscription
through the configured platform Stripe client, validates the deployment and
server catalog bindings, and publishes terminal state through the atomic
subscription receipt/finalizer transaction. Connect-account events, unknown
identities, nonterminal transitions, changed periods or catalog bindings, and
out-of-order observations remain retryable in the existing queue/DLQ.

This path issues no provider mutations or grants. It does not implement checkout,
trial activation, renewal funding, dunning/grace policy, refunds, or generic app
subscriber lifecycle. Local consumer tests control the Stripe transport boundary;
they do not establish live merchant credentials or provider execution evidence.

## Durable cancellation notice state

Each canonical `canceled` revision inserts one `cancel_effective` intent
in the same transaction as its source revision, entitlement and event receipt.
The intent starts `policy_unavailable`. The existing Stripe queue cron sweeps
these intents and suppresses stale source revisions. It does not infer recipients,
notice cadence, timezone, amounts, or a grace period. Newer canceled revisions
retain a successor intent. A prior attempt other than proven pre-submission
supersession puts an approved successor in `reconciliation_required`; a new
revision alone does not authorize another message. This slice does not implement
reminder or reconciliation policy, or complete subscription notifications.

`SUBSCRIPTION_NOTICE_APPROVED_DISPATCHES_JSON` is an optional server-owned registry
of explicitly approved dispatches. Each entry must name `approvalReference`,
`organizationId`, `subscriptionId`, `sourceRevision`, `kind: "cancel_effective"`,
`recipient`, UTC `sendAt`/`notAfter`, an IANA `timezone`, and approved `subject`,
`text`, and `html`. No registry is configured by this change. Its approval
reference records an external product/operations decision; parsing configuration
is not independent proof of that approval. There is no browser registration API
or default message. Missing, ambiguous or invalid configuration stays unavailable.
Configuration must reference the exact current source revision; a changed registry
digest suppresses an already claimed attempt before submission.

The dispatcher commits an attempt before mail I/O, then holds organization,
account, source and notice locks through final checks and typed
`Email.dispatchBounded`. Its SMTP transport owns the physical TCP socket: a
maximum ten-second absolute deadline destroys it, and dispatch waits for local
closure before releasing the transaction. The remaining lease and approved window
can shorten this deadline. This is below the database client's five-minute idle
transaction timeout; it does not make SMTP and PostgreSQL an atomic distributed
commit or guarantee recipient delivery. SendGrid remains explicitly unavailable
for bounded notices because this path has no owned cancellation contract for it.
Legacy mail methods keep their existing behavior. A durable inspection cursor
rotates unavailable and future notices; only a claimed attempt consumes the
one-submission budget per sweep. After a worker crash or unknown provider
acceptance, an expired attempt becomes `uncertain` and is never automatically
resent. Accepted submission is stored as `accepted`, never `delivered`; rejection
and unavailable transport also require a separate approved reconciliation decision.
This deliberately favors avoiding duplicate messages over guaranteed delivery.

The organization billing snapshot includes a `cancellationNotice` observation for
the current canceled revision. It reports persisted email submission state and
its last update under the same primary transaction as the subscription read.
`accepted` is transport acceptance, while `delivery: "not_observed"` explicitly
retains the absence of recipient evidence. Missing current intent is unavailable;
a non-canceled subscription has no applicable cancellation notice. Historical
revisions, message content, recipient addresses, and transport identifiers are
not exposed in this public observation. Reading it cannot dispatch or retry mail.

Migration `0382_subscription_notice_intents.sql` must precede deploying the
updated finalizer. Intent/attempt identity and terminal outcomes are immutable;
source erasure cascades their rows and the portable account export includes them.
Local evidence uses real PGlite transactions and a loopback SMTP server only.
Controlled live recipient/provider evidence and policy approval remain separate.
