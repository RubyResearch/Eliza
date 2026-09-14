# @elizaos/gateway-discord

Multi-tenant Discord gateway service for Eliza Cloud. A standalone, stateless
Hono HTTP service that maintains Discord WebSocket (gateway) connections for many
bots from one pod, transcribes voice messages, and forwards events to
agent-server pods. It is deployed as its own container (Docker / Railway), not
loaded as an Eliza plugin.

## Layout

- `src/index.ts` — entrypoint. Boots the Hono HTTP server and a single
  `GatewayManager`; exposes `/health` (liveness) and `/ready` (readiness)
  unauthenticated for probes, plus `/drain` (preStop graceful drain),
  `/metrics` (Prometheus text), and `/status` behind the internal-secret
  gate. Wires `SIGTERM`/`SIGINT` to graceful shutdown.
- `src/internal-auth.ts` — `validateInternalSecret`, the constant-time
  `X-Internal-Secret` gate for the operational endpoints; fails closed when
  `GATEWAY_INTERNAL_SECRET` is unset.
- `src/gateway-manager.ts` — the bulk of the service (`GatewayManager`): polls
  Redis for bot assignments, opens `discord.js` `Client` connections, heartbeats
  pod state, handles failover, and runs Eliza App system-bot leader election.
- `src/server-router.ts` — resolves the agent-server for an agent via Redis and
  forwards messages with consistent-hash routing, retries, KEDA activity
  refresh, and K8s scale-from-zero wake-up (`forwardToServer`,
  `resolveAgentServer`, `refreshKedaActivity`).
- `src/hash-router.ts` — consistent hash ring (`hashring`) over agent-server pod
  IPs, resolved from K8s EndpointSlices; falls back to the URL directly for
  non-`.svc` (direct host:port) targets.
- `src/redis-adapter.ts` — `UpstashCompatRedis`, an Upstash-`@upstash/redis`-shaped
  facade over an `ioredis` client. `createNativeRedis(url)` for real TCP Redis,
  `createMockRedis()` (backed by `ioredis-mock`) for tests/CI.
- `src/voice-message-handler.ts` — downloads Discord voice attachments, uploads
  them to the Cloud API storage proxy, and produces pre-signed URLs
  (`VoiceMessageHandler`, `hasVoiceAttachments`).
- `src/managed-guild-voice.ts` — leader-owned, guild-only `/voice join|leave`,
  live Opus receive/playback, and the authenticated Cloud voice-turn bridge.
  It records only the canonical invoker and never reuses the private DM room.
- `src/logger.ts` — `createServiceLogger("gateway-discord")` from
  `@elizaos/cloud-services-common`.
- `tests/` — Vitest/`bun test` specs (hash-router, leader-election,
  redis-adapter, voice-message-handler).
- `Dockerfile`, `docker-compose.yml`, `railway.toml`, `scripts/deploy-railway.sh`
  — container build and deploy.

## Key scripts

Scope everything with `--cwd packages/cloud/services/gateway-discord`:

```bash
bun run --cwd packages/cloud/services/gateway-discord dev        # watch (PORT=3001, uses root .env.local)
bun run --cwd packages/cloud/services/gateway-discord dev:local  # watch, no env-file
bun run --cwd packages/cloud/services/gateway-discord build      # bun build -> dist (node target, zlib-sync external)
bun run --cwd packages/cloud/services/gateway-discord typecheck  # tsc --noEmit
bun run --cwd packages/cloud/services/gateway-discord test       # bun test
bun run --cwd packages/cloud/services/gateway-discord lint       # biome check
bun run --cwd packages/cloud/services/gateway-discord docker:build / docker:up / docker:logs
bun run --cwd packages/cloud/services/gateway-discord deploy:railway
```

## Environment variables

Required at startup (the process `exit(1)`s if missing):

- `GATEWAY_BOOTSTRAP_SECRET` — exchanged at startup for a JWT against the Cloud API.

Connection / routing:

- `ELIZA_CLOUD_URL` (falls back to `NEXT_PUBLIC_APP_URL`, then `https://api.eliza.app`)
- `REDIS_URL` (or `KV_REST_API_URL`) and `KV_REST_API_TOKEN` — Redis/Upstash.
- `AGENT_SERVER_SHARED_SECRET` — sent as `X-Server-Token` when forwarding to agent-servers.
- `GATEWAY_INTERNAL_SECRET` — shared secret callers present as `X-Internal-Secret`
  on `/internal/deliver`, `/drain`, `/status`, and `/metrics`. Those routes fail
  closed (401) when it is unset; `/health` and `/ready` stay unauthenticated for probes.
- `POD_NAME` — required in production (K8s downward API); falls back to `gateway-<hostname>`
  for local dev only, which can orphan connections on reschedule.
- `PORT` (default 3000), `PROJECT` (log tag, default `cloud`).

Optional features / toggles:

- `MOCK_REDIS=1` — explicit opt-in to the in-memory mock Redis (tests/CI only).
- `ELIZA_APP_DISCORD_BOT_ENABLED=true` + `ELIZA_APP_DISCORD_BOT_TOKEN` — run the
  Eliza App system bot; `ELIZA_APP_LEADER_KEY` (default `discord:eliza-app-bot:leader`)
  for leader election.
- `ELIZA_APP_DISCORD_PUBLIC_KEY` — recommended local Ed25519 verification key
  for the signed install webhook; avoids a bounded first-request key lookup.
- `ELIZA_APP_DISCORD_GUILD_VOICE_ENABLED=true` — register guild-only voice
  controls and enable live audio on the system-bot leader. The Cloud Worker must
  have its Shared runtime, ElevenLabs STT/TTS, and internal auth configured.
- `VOICE_MESSAGE_ENABLED` (`"false"` disables the voice path),
  `VOICE_AUDIO_TTL_SECONDS`, `VOICE_CLEANUP_INTERVAL_MS`,
  `CLOUD_API_BASE_URL`/`ELIZAOS_CLOUD_BASE_URL`, `BLOB_READ_WRITE_TOKEN` — voice upload.
- `KEDA_COOLDOWN_SECONDS` (default 900) — TTL on the KEDA activity key; must be
  a positive integer, otherwise the router refuses to load at boot.

## Conventions / gotchas

- Independent service: its own `package.json`, lockfile, `tsconfig` (`strict`,
  bundler resolution), and Biome config — not part of the Turbo project build.
  Build is `bun build` to `dist`, run with `bun run dist/index.js`.
- Use the package `logger` (never `console`); error messages are run through
  `sanitizeError` to redact anything matching the Discord bot-token pattern —
  never log raw tokens or full Discord payloads.
- `/health` returns 200 even when degraded (restarting would disconnect every
  bot); only `unhealthy` returns 503. `/ready` is the load-balancer signal and
  returns 503 while draining/degraded.
- Redis is real by default; the mock is only used when `MOCK_REDIS=1` is set
  explicitly — it is never silently substituted.
- `hash-router`/`server-router` read the K8s service-account token and CA from
  `/var/run/secrets/...`; absent (e.g. on Railway), they degrade gracefully and
  treat targets as direct host:port URLs rather than scaling a K8s Deployment.
- `discord.js` pulls in optional native deps; `build` marks `zlib-sync` external,
  so keep it (and other native modules) out of the bundle.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
