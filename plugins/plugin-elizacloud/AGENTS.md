# @elizaos/plugin-elizacloud

Eliza Cloud integration — multi-model inference, container provisioning, agent bridge, and billing for elizaOS agents.

## Purpose / role

Connects an Eliza agent to Eliza Cloud for hosted AI inference (text, embeddings, TTS, STT, image), container lifecycle management, real-time agent bridging via WebSocket, and billing/credit flows. Auto-enables when `ELIZAOS_CLOUD_API_KEY` or `ELIZAOS_CLOUD_ENABLED=true` is present (see `auto-enable.ts`). This plugin has priority 50, which means it wins the default text-generation slot over other direct provider plugins (priority 0) when no explicit routing preference is configured — **unless the host writes `ELIZAOS_CLOUD_USE_INFERENCE=false`** (`applyCloudConfigToEnv`), in which case the chat-brain handlers (`TEXT_*`, `RESPONSE_HANDLER`, `ACTION_PLANNER`) are not registered at all and only the capability handlers (IMAGE, IMAGE_DESCRIPTION, TEXT_TO_SPEECH, TRANSCRIPTION, embeddings) stay active. This capability-only mode is how an agent keeps Cloud image/media/TTS while an external provider (a CLI/SDK subscription brain, a local model) owns the text brain (elizaOS/eliza#10819).

The plugin has two distinct export surfaces:

- **`elizaOSCloudPlugin`** (`src/index.ts`) — inference model handlers, cloud providers, and cloud services. Safe in both browser and Node.
- **`elizaCloudRoutePlugin`** (`src/plugin.ts`) — registers `/api/cloud/*` HTTP routes. Node-only; loaded lazily via `src/register-routes.ts`.

## Plugin surface

### Model handlers

Two registration groups (elizaOS/eliza#10819):

**Capability handlers — always registered (static `models` map).** These don't
compete with the chat brain and must survive an external text provider:

| Slot | Handler | File |
|---|---|---|
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `src/models/embeddings.ts` |
| `IMAGE` | `handleImageGeneration` | `src/models/image.ts` |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `src/models/image.ts` |
| `TEXT_TO_SPEECH` | `handleTextToSpeech` | `src/models/speech.ts` |
| `TRANSCRIPTION` | `handleTranscription` | `src/models/transcription.ts` |

**Chat-brain handlers — registered from `init()`** (`registerTextInferenceModels`,
`src/index.ts`), skipped when the host writes `ELIZAOS_CLOUD_USE_INFERENCE=false`
(registered when it is `true` or unset — unset preserves standalone plugin use):

| Slot | Handler | File |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | `src/models/text.ts` |
| `TEXT_SMALL` | `handleTextSmall` | `src/models/text.ts` |
| `TEXT_MEDIUM` | `handleTextMedium` | `src/models/text.ts` |
| `TEXT_LARGE` | `handleTextLarge` | `src/models/text.ts` |
| `TEXT_MEGA` | `handleTextMega` | `src/models/text.ts` |
| `RESPONSE_HANDLER` | `handleResponseHandler` | `src/models/text.ts` |
| `ACTION_PLANNER` | `handleActionPlanner` | `src/models/text.ts` |

### Providers

| Name | File | Description |
|---|---|---|
| `elizacloud_status` | `src/cloud-providers/cloud-status.ts` | Container and connection status (position 90, contexts: settings/finance) |
| `elizacloud_credits` | `src/cloud-providers/credit-balance.ts` | Credit balance with 60 s cache, low/critical alerts (position 91) |
| `elizacloud_health` | `src/cloud-providers/container-health.ts` | Container health approximation from cached state; private (position 92) |
| `elizacloud_models` | `src/cloud-providers/model-registry.ts` | Available models grouped by provider, 5 min cache (position 92) |

### Services (started in dependency order)

| Service type | Class | File | Description |
|---|---|---|---|
| `CLOUD_AUTH` | `CloudAuthService` | `src/services/cloud-auth.ts` | Auth entry points — device auto-signup and Cloud SSO OAuth flow |
| `CLOUD_BOOTSTRAP` | `CloudBootstrapServiceImpl` | `src/services/cloud-bootstrap.ts` | Exposes Cloud trust-anchor (JWKS URL, issuer, container id) without importing app-core |
| `CLOUD_MANAGED_GATEWAY_RELAY` | `CloudManagedGatewayRelayService` | `src/services/cloud-managed-gateway-relay.ts` | Long-poll relay enabling Cloud to push requests to a local agent |
| `CLOUD_MODEL_REGISTRY` | `CloudModelRegistryService` | `src/services/cloud-model-registry.ts` | Fetches and caches available models from Cloud (30 min TTL) |
| `CLOUD_CONTAINER` | `CloudContainerService` | `src/services/cloud-container.ts` | ECS container lifecycle: create, list, poll status, delete |
| `CLOUD_BRIDGE` | `CloudBridgeService` | `src/services/cloud-bridge.ts` | JSON-RPC 2.0 WebSocket bridge to cloud-hosted agents with exponential-backoff reconnect |
| `CLOUD_BACKUP` | `CloudBackupService` | `src/services/cloud-backup.ts` | Agent state snapshots/restore; periodic auto-backup and pre-eviction snapshots |

### Events

| Event | Handler | File |
|---|---|---|
| `MODEL_USED` | `createWaifuMeteringHandler()` | `src/utils/waifu-metering.ts` |

Forwards per-inference token and USD spend to the Cloud metering endpoint when the container is a hosted agent. Inactive otherwise.

### Routes (via `elizaCloudRoutePlugin`)

All paths use `rawPath: true`. Handled by three route groups:

- **Status** (`handleCloudStatusRoutes`): `GET /api/cloud/status`, `GET /api/cloud/credits`
- **Cloud routes** (`handleCloudRoute`): login, disconnect, relay-status, agents provisioning/connect/shutdown, coding-container create/sync/promotions
- **Billing proxy** (`handleCloudBillingRoute`): `GET|POST|PUT|PATCH|DELETE /api/cloud/billing/:path*` — forwards to authenticated Cloud API

## Layout

```
plugins/plugin-elizacloud/
  src/
    index.ts                        Main plugin object (elizaOSCloudPlugin)
    index.node.ts                   Node-specific re-exports
    index.browser.ts                Browser-compatible build entry
    plugin.ts                       Route-only plugin (elizaCloudRoutePlugin)
    register-routes.ts              Lazy-loads route plugin via registerAppRoutePluginLoader
    init.ts                         OpenAI-compatible client initialization
    auto-enable.ts                  Auto-enable check (reads ELIZAOS_CLOUD_API_KEY / ELIZAOS_CLOUD_ENABLED)
    cloud-setup.ts                  Interactive Cloud setup flow (runCloudSetup)
    cloud-voice-catalog.ts          Fetches available TTS voice catalog from Cloud
    models/
      text.ts                       Text generation handlers for all model tiers
      embeddings.ts                 TEXT_EMBEDDING handler
      image.ts                      IMAGE and IMAGE_DESCRIPTION handlers
      speech.ts                     TEXT_TO_SPEECH handler + CloudTtsUnavailableError
      transcription.ts              TRANSCRIPTION handler
      tokenization.ts               TEXT_TOKENIZER_ENCODE/DECODE handlers
      index.ts                      Re-exports all model handlers
    services/
      cloud-auth.ts                 CloudAuthService (CLOUD_AUTH)
      cloud-bootstrap.ts            CloudBootstrapServiceImpl (CLOUD_BOOTSTRAP)
      cloud-managed-gateway-relay.ts CloudManagedGatewayRelayService (CLOUD_MANAGED_GATEWAY_RELAY)
      cloud-model-registry.ts       CloudModelRegistryService (CLOUD_MODEL_REGISTRY)
      cloud-container.ts            CloudContainerService (CLOUD_CONTAINER)
      cloud-bridge.ts               CloudBridgeService (CLOUD_BRIDGE)
      cloud-backup.ts               CloudBackupService (CLOUD_BACKUP)
    cloud-providers/
      cloud-status.ts               elizacloud_status provider
      credit-balance.ts             elizacloud_credits provider
      container-health.ts           elizacloud_health provider
      model-registry.ts             elizacloud_models provider
    routes/
      cloud-routes.ts               Core cloud login/disconnect/agent routes
      cloud-routes-autonomous.ts    Autonomous-mode cloud route handler
      cloud-status-routes.ts        /api/cloud/status and /api/cloud/credits
      cloud-status-routes-autonomous.ts  Autonomous-mode status route handler
      cloud-billing-routes.ts       /api/cloud/billing/* proxy
      cloud-relay-routes.ts         Relay-status route
      cloud-provisioning.ts         isCloudProvisionedContainer helper
      cloud-coding-container-routes.ts  Coding-container management
      cloud-compat-routes.ts        Compat route shims
      cloud-features-routes.ts      Feature-flag routes
      travel-provider-relay-routes.ts   Travel provider relay routes
      home-remote-runner-access-url.ts  Remote runner access URL helper
    cloud/
      auth.ts                       Auth helpers
      auth-service-types.ts         CloudAuthApiKeyService interface, normalizeCloudApiKey, isCloudAuthApiKeyService
      backup.ts                     Backup helpers
      base-url.ts                   resolveCloudApiBaseUrl, normalizeCloudSiteUrl
      bridge-client.ts              ElizaCloudClient, CloudWalletDescriptor
      cloud-api-key.ts              resolveCloudApiKey, resolveCloudApiBaseUrl, normalizeCloudSecret
      cloud-manager.ts              CloudManager orchestrator
      cloud-proxy.ts                Proxy utilities
      cloud-wallet.ts               Wallet descriptor types
      clack-observer.ts             ClackObserver (interactive CLI setup feedback)
      null-observer.ts              NullCloudSetupObserver
      setup-observer.ts             CloudSetupObserver interface
      reconnect.ts                  Reconnect helpers
      validate-url.ts               validateCloudBaseUrl
      duffel-client.ts              Duffel travel/flight booking client (searchFlights, createOrder, readDuffelConfigFromEnv, DuffelConfigError)
      lifeops-schedule-sync-client.ts  LifeOps schedule sync client (resolveLifeOpsScheduleSyncConfig)
      lifeops-schedule-sync-contracts.ts  LifeOps schedule sync contract types
      managed-payment-clients.ts    Managed payment client helpers
      x402-payment-handler.ts       x402 payment protocol handler (parseX402Response, requestPayment, PaymentRequiredError)
      index.ts                      Barrel
    lib/
      cloud-connection.ts           CloudAuthLike interface
      cloud-secrets.ts              getCloudSecret, clearCloudSecrets, scrubCloudSecretsFromEnv
      config-env.ts                 Env-to-config mapping
      config-like.ts                ElizaConfig type
      feature-flags.ts              Feature flag helpers
      http.ts                       sendJson HTTP helper
      server-cloud-tts.ts           TTS compat layer, resolveCloudTtsBaseUrl
      state-paths.ts                State directory path helpers
      tts-debug.ts                  TTS debug utilities
    providers/
      openai.ts                     createOpenAIClient (Vercel AI SDK OpenAI-compatible adapter)
    utils/
      cloud-api.ts                  CloudApiClient — base HTTP client for Cloud API
      sdk-client.ts                 createCloudApiClient, createElizaCloudClient
      waifu-metering.ts             createWaifuMeteringHandler (MODEL_USED event bridge)
      config.ts                     Model string resolution helpers (getNanoModel, getLargeModel, …)
      events.ts                     emitModelUsageEvent, ModelUsageEventMeta
      helpers.ts                    Misc internal helpers
      responses-output.ts           extractResponsesOutputText (Responses API output parser)
      cloud/sdk/                    Internal SDK surface wrappers
    types/
      cloud.ts                      CloudContainer, DevicePlatform, DEFAULT_CLOUD_CONFIG, and all Cloud API types
      index.ts                      Type barrel
  __tests__/
    unit/                           Unit tests (no live API)
    integration/                    Integration tests
    *.test.ts                       Feature-level test suites
  auto-enable.ts                    Auto-enable entry point (package.json elizaos.plugin.autoEnableModule)
  build.ts                          Dual-target (node + browser) build script
  package.json
```

## Commands

```bash
bun run --cwd plugins/plugin-elizacloud build       # compile node + browser bundles
bun run --cwd plugins/plugin-elizacloud typecheck   # type check only (tsc --noEmit)
bun run --cwd plugins/plugin-elizacloud test        # run all tests via vitest
bun run --cwd plugins/plugin-elizacloud test:unit   # unit tests only
bun run --cwd plugins/plugin-elizacloud test:integration  # integration tests only
bun run --cwd plugins/plugin-elizacloud test:e2e    # live smoke test via app-core script
bun run --cwd plugins/plugin-elizacloud lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-elizacloud clean       # rm -rf dist .turbo .turbo-tsconfig.json tsconfig.tsbuildinfo
```

## Config / env vars

All settings are optional except `ELIZAOS_CLOUD_API_KEY` (required for any authenticated call).

### Required

| Var | Description |
|---|---|
| `ELIZAOS_CLOUD_API_KEY` | API key (`eliza_xxxxx`). Manage it inside Eliza at https://cloud.eliza.app/cloud/api-keys |

### Optional — core

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_BASE_URL` | `https://api.eliza.app/api/v1` |
| `ELIZAOS_CLOUD_ENABLED` | `false` — when true, enables container provisioning, device auth, bridge, and backup services |
| `ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY` | `false` |
| `ELIZAOS_CLOUD_APP_VERSION` | `2.0.0-beta.0` |
| `ELIZAOS_CLOUD_NATIVE_CONCURRENCY` | `8` — per-process cap on CONCURRENT native cloud text calls. Covers BOTH native text routes sharing the one cerebras key: `/chat/completions` (native-transport callers) AND `/responses` (bare-`{ prompt }` callers, incl. the primary reply action). The per-turn burst comes from the prompt batcher (`dynamicPromptExecFromState`, always sets providerOptions -> `/chat/completions`) and the merged evaluator call — NOT from composeState providers (no provider calls `useModel` during composeState); firing them at once can overrun the shared cerebras key's concurrent limit -> 429 -> retries. The default `8` is a SAFETY CEILING, not full serialization: with the paid cerebras key (1000 req/min) and leaner per-turn call counts the typical 1-3 concurrent calls/turn run unguarded while a pathological burst is still bounded. The limiter is process-global and keys on native transport (not the model), so it also bounds non-cerebras native calls (e.g. zai-glm-4.7) — hence the high default. Set to `1` to fully serialize on a cerebras-bottlenecked single-key deployment, or raise for more parallelism. Embeddings use a separate `/embeddings` route and are NOT gated. |

### Optional — model tiers (each has a fallback bare env alias)

| Cloud var | Bare fallback | Default |
|---|---|---|
| `ELIZAOS_CLOUD_NANO_MODEL` | `NANO_MODEL` | falls back to small model |
| `ELIZAOS_CLOUD_SMALL_MODEL` | `SMALL_MODEL` | `gemma-4-31b` |
| `ELIZAOS_CLOUD_MEDIUM_MODEL` | `MEDIUM_MODEL` | falls back to small model |
| `ELIZAOS_CLOUD_LARGE_MODEL` | `LARGE_MODEL` | `gemma-4-31b` |
| `ELIZAOS_CLOUD_MEGA_MODEL` | `MEGA_MODEL` | falls back to large |
| `ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL` | `RESPONSE_HANDLER_MODEL` | falls back to small model |
| `ELIZAOS_CLOUD_ACTION_PLANNER_MODEL` | `ACTION_PLANNER_MODEL` | falls back to large model |

### Optional — embeddings

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_EMBEDDING_MODEL` | `text-embedding-3-small` |
| `ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS` | `1536` |
| `ELIZAOS_CLOUD_EMBEDDING_URL` | unset (uses base URL) |
| `ELIZAOS_CLOUD_EMBEDDING_API_KEY` | falls back to `ELIZAOS_CLOUD_API_KEY` |

### Optional — image / audio

| Var | Default |
|---|---|
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL` | `gpt-5.4-mini` |
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS` | unset; only an explicit positive integer sends a provider output cap |
| `ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL` | `google/nano-banana-2/text-to-image` |
| `ELIZAOS_CLOUD_TTS_MODEL` | `gpt-5-mini-tts` |
| `ELIZAOS_CLOUD_TTS_TIMEOUT_MS` | `60000`; `0` disables the deadline |
| `ELIZAOS_CLOUD_USE_STT` | unset — per-service opt-in for Cloud STT in capability-only mode (`ELIZAOS_CLOUD_ENABLED` unset) |
| `ELIZAOS_CLOUD_STT_TIMEOUT_MS` | `60000` |

### Browser-only proxy vars (no secrets in client bundles)

| Var |
|---|
| `ELIZAOS_CLOUD_BROWSER_BASE_URL` |
| `ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL` |

## How to extend

### Add a model handler

1. Add a handler function in the appropriate file under `src/models/`.
2. Export it from `src/models/index.ts`.
3. Register it in the `models` map in `src/index.ts` keyed by the `ModelType` constant.
4. Use `createCloudApiClient(runtime)` for raw API-base calls (see `src/utils/sdk-client.ts`).
5. Call `emitModelUsageEvent(runtime, type, prompt, usage, meta)` after each inference call.

### Add a provider

1. Create a new file in `src/cloud-providers/` exporting a `Provider` object.
2. Export it from `src/cloud-providers/index.ts`.
3. Add it to the `providers` array in `src/index.ts`.
4. Gate it with `contextGate` so it only fires in relevant context windows.

### Add a service

1. Create a new file in `src/services/` with a class extending `Service` from `@elizaos/core`.
2. Set a static `serviceType` string (used for `runtime.getService(...)` lookups).
3. Add it to the `services` array in `src/index.ts` in dependency order.
4. Add a matching `await runtime.getService(YourService.serviceType)?.stop()` line in `dispose()`.

## Conventions / gotchas

- **No direct `fetch()` for Cloud API calls.** Use `createCloudApiClient(runtime)` or `createElizaCloudClient(runtime)` from `src/utils/sdk-client.ts`. The one exception is the plugin test suite downloading a public audio fixture.
- **`ELIZAOS_CLOUD_ENABLED` gates infrastructure services.** When false, only inference model handlers are active. Container, bridge, backup, and relay services start only when this flag is true.
- **Browser build is separate.** `src/index.browser.ts` is the entry for `dist/browser/`. It must not import Node-only modules. The route plugin (`src/plugin.ts`) is Node-only and is excluded from the browser bundle.
- **Routes use `rawPath: true`.** All `/api/cloud/*` routes bypass the plugin-name prefix so paths stay stable.
- **TTS routing precedence.** This plugin's priority (50) does not govern TTS routing. The router-handler in `plugin-local-inference` runs at `MAX_SAFE_INTEGER` priority and enforces the `prefer-local` policy. Cloud TTS is a fallback; `CloudTtsUnavailableError` (from `src/models/speech.ts`) signals the router to try the next provider.
- **Cloud STT gate mirrors the TTS gate.** `handleTranscription` serves when a Cloud API key is present AND (`ELIZAOS_CLOUD_ENABLED` OR `ELIZAOS_CLOUD_USE_STT`) is truthy — `isCloudSttAvailable` in `src/utils/config.ts`. Otherwise it throws `CloudSttUnavailableError` so the local-inference router falls through to the next TRANSCRIPTION provider. `audioUrl`/string inputs are fetched through core's `fetchWithSsrfGuard`.
- **Cloud TTS availability gate ≠ core `isCloudConnected`.** `handleTextToSpeech` and `fetchCloudVoiceCatalog` serve when a Cloud API key is present AND (`ELIZAOS_CLOUD_ENABLED` OR `ELIZAOS_CLOUD_USE_TTS`) is truthy — `isCloudTtsAvailable` in `src/utils/config.ts`. The `USE_TTS` leg is what keeps Cloud TTS alive in capability-only mode, where `applyCloudConfigToEnv` deliberately leaves `ELIZAOS_CLOUD_ENABLED` unset (many consumers read ENABLED as "cloud is the text brain"). Do not "simplify" this back to core `isCloudConnected` — that regates TTS on inference and reopens the capability-only gap (elizaOS/eliza#10961 follow-up).
- **Services start in dependency order.** `CloudAuthService` must be first; every other service calls `runtime.getService("CLOUD_AUTH")`. `dispose()` stops them in reverse order.
- **`CloudBootstrapService` fails closed.** `getExpectedIssuer()` throws when `ELIZA_CLOUD_ISSUER` is unset. Never add a silent default.
- **No `as` casts or `?? 0` fallbacks for missing pipeline data.** Follow the architecture rules in `AGENTS.md` at the repo root.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
