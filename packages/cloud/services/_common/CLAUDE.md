# @elizaos/cloud-services-common

Shared, import-light TypeScript utilities for Cloudflare Workers and the
`packages/cloud/services/*` sidecars: connector protocol, retry, delivery,
structured logging, and Kubernetes ServiceAccount helpers. Private
(unpublished), ESM, sources consumed directly from `src/` (no build step —
`main`/`types` point at `src/index.ts`).

## Layout / exports

- `src/index.ts` — barrel; re-exports everything below.
- `src/logger.ts` (`./logger`) — `createServiceLogger(serviceName, options?)`
  returns a `ServiceLogger` (`debug`/`info`/`warn`/`error`/`shouldLog`) that
  emits one JSON object per line. Level is gated by the `LOG_LEVEL` env var
  (`debug | info | warn | error`, default `info`), re-read on every call. Field
  order is selectable via `ServiceLoggerOptions.metaFirst`: default
  `{ timestamp, level, message, ...meta }`; `metaFirst: true` yields the
  agent-server shape `{ ...meta, timestamp, level, message }`.
- `src/k8s-service-account.ts` (`./k8s-service-account`) —
  `readServiceAccountToken()` and `readServiceAccountCaCert()` read the
  projected pod credentials under
  `/var/run/secrets/kubernetes.io/serviceaccount/`. Both return `null` when the
  files are absent (e.g. a developer laptop outside a cluster) and cache the
  first result. `__resetServiceAccountCacheForTests()` clears that cache for
  tests only.
- `src/k8s-deployment-wake.ts` (`./k8s-deployment-wake`) — performs a bounded
  Kubernetes Deployment scale PATCH and composes an optional caller abort
  signal with the operation deadline.
- `src/identity-link-code.ts` (`./identity-link-code`) — canonical connector
  LINK-code recognition and user-facing confirmation results.
- `src/integer-env.ts` (`./integer-env`) — lexical integer parsing for gateway
  environment variables (`parseIntegerEnvValue`,
  `parsePositiveIntegerEnvValue`); a present-but-invalid value throws a fatal
  `ElizaError` (`INVALID_GATEWAY_INTEGER_ENV`) naming the variable instead of
  becoming `NaN` or a default.
- `src/gateway-auth.ts` (`./gateway-auth`) — strict short-lived gateway token
  response validation plus shared refresh and jittered retry timing.
- `src/gateway-routing.ts` (`./gateway-routing`) — shared Redis route lookup,
  KEDA activity refresh, `resolveKedaCooldownSeconds` (the
  `KEDA_COOLDOWN_SECONDS` boot-time parser, default 900), and observed
  Kubernetes wake requests. Callers retain their public missing-route result
  shape.
- `src/gateway-forward.ts` (`./gateway-forward`) — target selection, fallback,
  wake-on-zero, and bounded HTTP POST attempts. Gateway facades supply response
  parsing, timeout replay policy, and any canonical ingress fallback.
- `src/bounded-fetch.ts` (`./bounded-fetch`) — Web-standard REST transport
  owning deadlines, bounded decoded response reads and cancellation cleanup.
  Cloud shared and gateway adapters supply limits and public error factories.
- `src/response-attempts.ts` (`./response-attempts`) — bounded observable HTTP
  retry behavior shared across transport runtimes.
- `src/telegram-connector.ts` (`./telegram-connector`) — Web-standard Telegram
  webhook verification, parsing, typing, voice download, reply delivery, and
  value-safe exact-token `getMe` identity attestation.
- `src/telegram-delivery.ts` (`./telegram-delivery`) — exact-once Telegram
  reply state machine over a runtime-provided atomic ledger.

## Key scripts

Scope to this package with `--cwd packages/cloud/services/_common`:

```bash
bun run --cwd packages/cloud/services/_common typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/_common lint         # biome check .
bun run --cwd packages/cloud/services/_common lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/_common test         # delivery state-machine tests
```

## Conventions / gotchas

- The log output format is consumed by production log parsers — do not change
  the field set or ordering. Add structured context via the `meta` argument.
- `serviceName` is accepted by `createServiceLogger` for call-site convention
  but is not currently written into the log line.
- The k8s helpers cache on first successful read; in tests that toggle the
  cluster files, call `__resetServiceAccountCacheForTests()` between cases.
- This is the one place in cloud-services where `console.*` is intentional —
  it is the logger sink itself. Other cloud-services code should log through
  `createServiceLogger`, not `console`.
- Keep the runtime graph minimal so every service can import it cheaply. The
  sole workspace dependency is the shared `@elizaos/core` error contract.
- Keep provider protocol and delivery semantics runtime-neutral: Workers and
  Railway must delegate to the same source rather than maintaining forks.
- Successful Telegram identity attestations are briefly cached by credential
  plus expected ID/username; failures are never cached. Attestation errors may
  expose only the safe reason/retryability classification, never their provider
  payload or a nested cause that can contain the credential-bearing URL.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
