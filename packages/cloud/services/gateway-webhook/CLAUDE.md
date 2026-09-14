# @elizaos/gateway-webhook

Stateless multi-platform webhook gateway for Eliza Cloud. It receives inbound
webhooks from chat/messaging platforms (Telegram, Blooio, Twilio, WhatsApp
Cloud API), verifies and deduplicates them, resolves the sender's Eliza
identity, and forwards the message to the correct agent-server pod over a
hash-ring router. It also accepts internal events (cron / notification /
system) from trusted in-cluster callers and forwards those to agents.

## Layout

- `src/index.ts` — entrypoint. Builds a Hono app served via `Bun.serve`, wires
  the platform adapters, and registers routes:
  - `GET /health`, `GET /ready`, `POST /drain` — liveness / readiness /
    graceful-drain (KEDA / k8s lifecycle). `/drain` is gated on
    `X-Internal-Secret` like `/internal/deliver`; the probe routes stay open.
  - `GET /ready/forwarder-auth/:project` — read-only forwarder-gate readiness;
    a headerless 401 is reserved for an enforced gate on that project.
  - `GET /ready/telegram-identity/:project` — value-free proof that the exact
    canonical Telegram credential matches the selected public bot identity.
  - `POST /internal/event` — internal event delivery (auth via
    `X-Internal-Secret`).
  - `GET /webhook/:project/whatsapp[/:agentId]` — WhatsApp `hub.challenge`
    verification handshake.
  - `POST /webhook/:project/:platform[/:agentId]` — platform message webhooks.
- `src/adapters/` — one `PlatformAdapter` per platform (`telegram`, `blooio`,
  `twilio`, `whatsapp`) plus `types.ts` (the `Platform`, `ChatEvent`,
  `PlatformAdapter`, `WebhookConfig` contracts). An adapter implements
  `verifyWebhook` / `extractEvent` / `sendReply` / `sendTypingIndicator`.
- `src/webhook-handler.ts` — the core flow: sync phase (resolve config → verify
  signature → extract event → dedup), then a fire-and-forget async phase
  (resolve identity → forward to agent-server → send reply). Unlinked Telegram
  senders enter personal Shared; SMS transports retain the onboarding flow.
- `src/server-router.ts` — `resolveIdentity`, `resolveAgentServer`,
  `forwardToServer` / `forwardEventToServer` (retry + fallback + KEDA
  wake-on-zero), and `refreshKedaActivity`.
- `src/hash-router.ts` — consistent-hash ring over agent-server pod IPs,
  resolved from k8s EndpointSlices; falls back to a direct target for non-`.svc`
  URLs.
- `src/auth.ts` — gateway service auth: bootstraps a JWT from the cloud API with
  `GATEWAY_BOOTSTRAP_SECRET` and auto-refreshes it; `getAuthHeader()` supplies
  the `Authorization` header for cloud calls.
- `src/internal-auth.ts` — constant-time `X-Internal-Secret` validation for
  `/internal/event` and shared BFF-forwarder gate state/enforcement.
- `src/forwarder-auth-readiness.ts` — non-mutating forwarder-gate readiness
  route; it never accepts a secret or enters provider/message handling.
- `src/telegram-identity.ts` — canonical Telegram startup, ingress, reminder,
  and readiness attestation shared by the gateway paths.
- `src/internal-event-handler.ts` — zod-validated internal event ingestion
  (64KB cap), then background forward.
- `src/webhook-config.ts` / `src/project-config.ts` — per-agent webhook config
  (fetched from the cloud API, Redis-cached) and per-project secrets (loaded
  from labeled k8s Secrets, refreshed on an interval, falling back to env vars).
- `src/redis.ts` — `GatewayRedis` abstraction over Upstash REST, native ioredis,
  or an in-memory mock.
- `src/billing.ts` — Twilio SMS segment + markup cost math (pure functions).
- `src/logger.ts` — `createServiceLogger("gateway-webhook")` from
  `@elizaos/cloud-services-common`.
- `__tests__/` and `src/__tests__/` — bun tests.
- `Dockerfile`, `railway.toml` — container build and Railway deploy config.

## Key scripts

Scope everything with `--cwd packages/cloud/services/gateway-webhook`:

```bash
bun run --cwd packages/cloud/services/gateway-webhook dev         # watch mode on PORT=3002
bun run --cwd packages/cloud/services/gateway-webhook start       # run src/index.ts (PORT=3002)
bun run --cwd packages/cloud/services/gateway-webhook build       # bun build src/index.ts → dist/ (node target)
bun run --cwd packages/cloud/services/gateway-webhook typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/gateway-webhook test        # bun test
bun run --cwd packages/cloud/services/gateway-webhook lint        # biome check
bun run --cwd packages/cloud/services/gateway-webhook docker:build
```

## Build & deploy

**The Docker build context is the repository root, not this directory.** The
service depends on the `@elizaos/cloud-services-common` workspace package, and
`workspace:*` cannot resolve from a context holding only this package:

```bash
docker build -f packages/cloud/services/gateway-webhook/Dockerfile .
```

The deps stage writes a pruned workspace root containing only this service and
the package it needs, so the install resolves the workspace link without pulling
the whole monorepo (32 packages, not several thousand).

This service has **no Railway repo trigger** — merging a change does not ship
it. Deploy staging or production only through the protected
`.github/workflows/deploy-gateway-webhook.yml` dispatcher. The workflow accepts
`develop` for staging and `main` for production, checks out and uploads the
exact dispatch SHA from the repository root, validates the protected Railway
project/environment/service ids and public URL, materializes the tracked
service manifest byte-for-byte at the root config path Railway expects, and
waits for that exact deployment id before proving its applied manifest and
active identity around live health and canonical fallback checks.
The successful run publishes a source/environment/deployment-id receipt for
the protected Telegram edge cutover, which verifies the receipt against the
currently active Railway service before and after mutation under the same
per-environment concurrency key. Protected-environment authorization completes
before either workflow enters that shared Cloudflare/gateway mutation lock, so
a waiting approval cannot block releases.
It then proves the dedicated headerless `/ready/forwarder-auth/eliza-app`
contract returns the exact enforced-gate 401 and reasserts the exact active
deployment. The route returns distinct non-401 states when the secret is
disabled or the configured forwarded project does not match, never enters
provider/message handling, and rejects any supplied forwarder-secret header
without comparing it.
Before upload, the workflow proves the Railway token and webhook secret match
the protected Worker pair and attests that token with Telegram `getMe`. The
expected production ID/username always comes from
`packages/homepage/src/lib/contact.ts`; staging uses its selected protected
Environment pair. The deployed service must then return an exact value-free
Telegram readiness receipt before the deployment receipt is published.
The pinned Railway CLI is invoked with no path argument from the repository
root; do not change this to relative `.` because v5.38.0 cannot strip its
absolute archive prefix from that relative project path when `--project` is
explicit.

Each protected GitHub Environment supplies `RAILWAY_PROJECT_ID`,
`RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK`, and
`ELIZA_APP_WEBHOOK_GATEWAY_URL` as variables plus `RAILWAY_TOKEN` as a secret.
The workflow validates the existing Railway variable names and canonical
non-secret values without printing or rewriting sensitive values. Keep runtime
secrets in Railway; do not copy their values into workflow YAML or logs. The
names-only inventory requires `ELIZA_APP_WEBHOOK_GATEWAY_SECRET`, which keeps
the cloud BFF forwarding trust gate enabled. Staging additionally requires the
complete `ELIZA_APP_BLOOIO_API_KEY`, `ELIZA_APP_BLOOIO_PHONE_NUMBER`, and
`ELIZA_APP_BLOOIO_WEBHOOK_SECRET` set before a deployment can start; production
keeps its existing contract. Provision staging values out of band through
`railway variable set --stdin --skip-deploys` so an incomplete update cannot
trigger a release, then use the protected dispatcher once all three names are
present. Restore or remove only those staged names before dispatch if setup
fails. All three staging values must match the Worker protected-environment
source, so the gateway workflow compares each Railway value against the
matching GitHub Environment secret through a per-run salted HMAC digest. Only
the digests are compared and neither side's value is printed, logged, or
written; a divergent-but-present pair now fails the deploy instead of passing a
names-only check and then rejecting every live webhook with 401. Staging is
branch/configuration gated but currently has no required reviewer; production
retains reviewer approval.

`__tests__/dockerfile-workspace-context.test.ts` guards the workspace build
context. The repository-level
`packages/scripts/__tests__/gateway-webhook-deploy-workflow.test.ts` guards the
protected deploy contract.

## Environment

Required (the process throws on startup if these are missing):

- `ELIZA_CLOUD_URL` — base URL of the cloud API (identity resolve, webhook
  config, onboarding chat, auth token endpoints).
- `GATEWAY_BOOTSTRAP_SECRET` — bootstrap secret used to acquire the gateway JWT.

Required production forwarding trust (the protected deploy fails closed when
this Railway variable is absent or blank):

- `ELIZA_APP_WEBHOOK_GATEWAY_SECRET` — shared trust secret required on cloud
  BFF forwards; it must match the Cloud Worker secret of the same name.

Redis (at least one of these must resolve, or `createRedis()` throws):

- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Upstash Redis REST.
- `REDIS_URL` — native Redis (ioredis).
- `MOCK_REDIS=1` — in-memory mock (tests / local).

Canonical transport fallback (both values are required together; when either
is absent or invalid the process rejects startup before binding `/health` or
`/ready` and does not contact a legacy agent hostname):

- `AGENT_ROUTER_ORIGIN_HOST` — canonical dedicated-agent router origin used
  after a direct transport failure. Production is
  `eliza-production-1.eliza.app`; staging is `eliza-staging-1.eliza.app`.
  The gateway sends the validated
  `<agent-id>.<ELIZA_CLOUD_AGENT_BASE_DOMAIN>` value as `X-Forwarded-Host`.
  Validation applies to the complete generated hostname, including the
  253-character total and 63-character per-label DNS limits.
- `ELIZA_CLOUD_AGENT_BASE_DOMAIN` — canonical dedicated-agent hostname suffix:
  `cloud.eliza.app` in production or `cloud-staging.eliza.app` in staging.

Other:

- `GATEWAY_INTERNAL_SECRET` — required to accept `POST /internal/event`,
  `POST /internal/deliver`, and `POST /drain`; when unset, every request to
  those routes is rejected (logged as a warning at boot).
- `AGENT_SERVER_SHARED_SECRET` — sent as `X-Server-Token` on forwards to
  agent-server pods.
- `PORT` (default 3000; `dev`/`start` scripts set 3002), `POD_NAME` /
  `HOSTNAME`.
- `KEDA_COOLDOWN_SECONDS` (default 900) — TTL on the KEDA activity key; must be
  a positive integer, otherwise the router refuses to load at boot.
- `TWILIO_PUBLIC_URL`, `TWILIO_SMS_COST_PER_SEGMENT_USD` — Twilio adapter /
  billing tuning.
- Per-project secrets are read via `getProjectEnv(project, KEY)`: labeled k8s
  Secrets first, else `<PROJECT_UPPER>_<KEY>` env vars (e.g. `eliza-app` →
  `ELIZA_APP_TELEGRAM_BOT_TOKEN`). The canonical Telegram project requires the
  complete `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ID`,
  `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET` set; startup,
  readiness, inbound turns, and proactive delivery fail closed unless the
  exact token attests to that ID/username. Other keys include `BLOOIO_*`,
  `TWILIO_*`, and `WHATSAPP_*`.

## Conventions / gotchas

- **Stateless service.** All shared state lives in Redis (dedup keys, identity
  cache, webhook-config cache, KEDA activity, agent→server routing). The hash
  ring is rebuilt from k8s EndpointSlices, not persisted.
- **Ack fast, work later.** Webhook and internal-event handlers do the minimum
  synchronously and return 200 immediately, then process in a detached promise.
  Errors in the async phase are logged, not surfaced to the caller — watch the
  `[gateway-webhook]` logs for `Forward to server failed`, `No server found for
  agent`, etc. There is no dead-letter queue.
- **Two auth paths, do not confuse them:** outbound calls to the cloud API use
  the JWT from `auth.ts` (`getAuthHeader()`); inbound `/internal/event` is
  gated by `internal-auth.ts` (`X-Internal-Secret`, constant-time compare).
- **Dedup** is keyed on `webhook:<platform>:<messageId>` with a 5-minute TTL;
  adapters must produce a stable `messageId` in `extractEvent`.
- **Routing hash key is `userId`, not `agentId`** — same user's messages and
  events stick to the same agent-server pod for hot session affinity.
- **Twilio acks differ:** `ackResponse` returns empty TwiML for `twilio` and
  JSON `{ ok: true }` for everyone else.
- **Adding a platform:** implement a `PlatformAdapter`, register it in the
  `adapters` map in `index.ts`, and add the platform to the `Platform` union and
  the per-platform config block in `webhook-config.ts`. Keep `WebhookConfig`
  additive.
- **K8s-only features degrade gracefully:** EndpointSlice resolution, KEDA
  wake-on-zero (`wakeServer`), and labeled-Secret project config all no-op when
  the service-account token/CA are absent (local/dev), falling back to direct
  targets and env vars.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
