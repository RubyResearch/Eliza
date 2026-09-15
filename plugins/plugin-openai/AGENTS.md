# @elizaos/plugin-openai

OpenAI model-provider plugin for elizaOS: text generation, embeddings, image generation/description, audio transcription, text-to-speech, and deep research via the OpenAI Responses API.

## Purpose / role

Registers model handlers on the elizaOS `AgentRuntime` so Eliza agents can call `runtime.useModel(ModelType.*, ...)` backed by OpenAI (or any OpenAI-compatible endpoint — Cerebras, EvoLink, OpenRouter, local servers). Auto-enables when `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is present in the environment. No actions, providers, services, or evaluators — only model handlers.

## Plugin surface

This plugin registers **model handlers only** (no actions, providers, services, evaluators, routes, or events):

| `ModelType` | Default model | Handler |
|---|---|---|
| `TEXT_SMALL` | `gpt-5.6-luna` | `handleTextSmall` |
| `TEXT_NANO` | falls back to small | `handleTextNano` |
| `TEXT_MEDIUM` | falls back to small | `handleTextMedium` |
| `TEXT_LARGE` | `gpt-5.6-sol` | `handleTextLarge` |
| `TEXT_MEGA` | falls back to large | `handleTextMega` |
| `RESPONSE_HANDLER` | falls back to small | `handleResponseHandler` |
| `ACTION_PLANNER` | falls back to medium | `handleActionPlanner` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` | `handleTextEmbedding` |
| `TEXT_TOKENIZER_ENCODE` | js-tiktoken | `handleTokenizerEncode` |
| `TEXT_TOKENIZER_DECODE` | js-tiktoken | `handleTokenizerDecode` |
| `IMAGE` | `dall-e-3` | `handleImageGeneration` |
| `IMAGE_DESCRIPTION` | `gpt-5-mini` | `handleImageDescription` |
| `TRANSCRIPTION` | `gpt-5-mini-transcribe` | `handleTranscription` |
| `TEXT_TO_SPEECH` | `gpt-5-mini-tts` / voice `nova` | `handleTextToSpeech` |
| `RESEARCH` | `o3-deep-research` | `handleResearch` (Responses API) |

All text handlers support streaming (`params.stream = true`) and structured output (`params.responseSchema`).

## Layout

```
plugins/plugin-openai/
  index.ts               # Plugin object (openaiPlugin); registers all model handlers
  index.node.ts          # Node entrypoint
  index.browser.ts       # Browser entrypoint
  auto-enable.ts         # shouldEnable(): true when OPENAI_API_KEY, CEREBRAS_API_KEY, or EVOLINK_API_KEY set
  build.ts               # Bun.build config (node ESM + browser ESM) + tsc declarations
  models/
    index.ts             # Re-exports all handlers
    text.ts              # handleTextSmall/Nano/Medium/Large/Mega/ResponseHandler/ActionPlanner
    embedding.ts         # handleTextEmbedding (deterministic local fallback in Cerebras mode)
    image.ts             # handleImageGeneration, handleImageDescription
    audio.ts             # handleTranscription, handleTextToSpeech
    tokenizer.ts         # handleTokenizerEncode, handleTokenizerDecode (js-tiktoken)
    research.ts          # handleResearch (OpenAI Responses API, o3/o4-mini deep research)
  providers/
    openai.ts            # createOpenAIClient(): @ai-sdk/openai factory (proxy-aware)
    index.ts
  utils/
    config.ts            # All getSetting/getModel/getBaseURL helpers; Cerebras/EvoLink detection
    events.ts            # emitModelUsageEvent: fires model-usage telemetry on runtime
    audio.ts             # detectAudioMimeType, getFilenameForMimeType
    tokenization.ts      # tiktoken helpers
    index.ts
  types/
    index.ts             # Plugin-local types: TTSVoice, ImageSize, TokenUsage, TextStreamResult,
                         #   OpenAIPluginConfig, API response shapes, etc.
  prompts/               # evaluators.json (empty manifest — plugin ships no evaluators)
  __tests__/             # Vitest unit tests
```

## Commands

```bash
bun run --cwd plugins/plugin-openai build          # Bun.build (node ESM + browser ESM) + tsc d.ts
bun run --cwd plugins/plugin-openai dev            # hot-reload build (bun --hot build.ts)
bun run --cwd plugins/plugin-openai test           # vitest unit suite
bun run --cwd plugins/plugin-openai typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-openai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-openai lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-openai format         # biome format --write
bun run --cwd plugins/plugin-openai clean          # rm -rf dist .turbo
```

## Config / env vars

All settings are read via `getSetting(runtime, key)` (runtime config first, then `process.env`).

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | no | — | Direct auth for OpenAI endpoints; unnecessary for authenticated proxy mode or another compatible-provider key |
| `CEREBRAS_API_KEY` | one-of | — | Auth when using Cerebras endpoint |
| `EVOLINK_API_KEY` | one-of | — | Auth when using EvoLink endpoint |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override API endpoint |
| `OPENAI_SMALL_MODEL` / `SMALL_MODEL` | no | `gpt-5.6-luna` | TEXT_SMALL model |
| `OPENAI_NANO_MODEL` / `NANO_MODEL` | no | falls back to small | TEXT_NANO model |
| `OPENAI_MEDIUM_MODEL` / `MEDIUM_MODEL` | no | falls back to small | TEXT_MEDIUM model |
| `OPENAI_LARGE_MODEL` / `LARGE_MODEL` | no | `gpt-5.6-sol` | TEXT_LARGE model |
| `OPENAI_MEGA_MODEL` / `MEGA_MODEL` | no | falls back to large | TEXT_MEGA model |
| `OPENAI_RESPONSE_HANDLER_MODEL` | no | falls back to small | RESPONSE_HANDLER model |
| `OPENAI_ACTION_PLANNER_MODEL` | no | falls back to medium | ACTION_PLANNER model |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model |
| `OPENAI_EMBEDDING_URL` | no | `OPENAI_BASE_URL` | Override embeddings endpoint |
| `OPENAI_EMBEDDING_API_KEY` | no | `OPENAI_API_KEY` | Separate embedding auth |
| `OPENAI_EMBEDDING_DIMENSIONS` | no | `1536` | Embedding vector dimensions |
| `OPENAI_IMAGE_DESCRIPTION_MODEL` | no | `gpt-5-mini` | Vision model |
| `OPENAI_IMAGE_DESCRIPTION_BASE_URL` | no | `OPENAI_BASE_URL` | Override vision endpoint |
| `OPENAI_IMAGE_DESCRIPTION_API_KEY` | no | `OPENAI_API_KEY` | Separate vision auth |
| `OPENAI_IMAGE_MODEL` | no | `dall-e-3` | Image generation model |
| `OPENAI_TTS_MODEL` | no | `gpt-5-mini-tts` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | no | `nova` | TTS voice (alloy/echo/fable/onyx/nova/shimmer) |
| `OPENAI_TTS_INSTRUCTIONS` | no | — | Style instructions for TTS |
| `OPENAI_TRANSCRIPTION_MODEL` | no | `gpt-5-mini-transcribe` | Audio transcription model |
| `OPENAI_RESEARCH_MODEL` | no | `o3-deep-research` | Deep research model |
| `OPENAI_RESEARCH_TIMEOUT` | no | `3600000` (1 hr) | Timeout for research requests (ms) |
| `OPENAI_EXPERIMENTAL_TELEMETRY` | no | `false` | Enable AI SDK telemetry |
| `OPENAI_REASONING_EFFORT` | no | — | `minimal`/`low`/`medium`/`high` for o-series models |
| `OPENAI_BROWSER_BASE_URL` | no | — | Browser-only proxy URL (keeps key server-side) |
| `OPENAI_BROWSER_UPSTREAM_BASE_URL` | no | — | Actual proxy upstream used for endpoint-specific capability checks |
| `OPENAI_BROWSER_EMBEDDING_URL` | no | — | Browser-only embeddings proxy URL |
| `OPENAI_ALLOW_BROWSER_API_KEY` | no | `false` | Send auth header in browser (opt-in) |
| `ELIZA_PROVIDER` | no | — | Set to `cerebras` or `evolink` to force that provider mode |
| `CEREBRAS_BASE_URL` | no | `https://api.cerebras.ai/v1` | Cerebras API base |
| `CEREBRAS_SMALL_MODEL` / `CEREBRAS_LARGE_MODEL` | no | — | Per-tier Cerebras model overrides |
| `CEREBRAS_MODEL` | no | — | Legacy Cerebras small-tier fallback; also used for large when no large-tier override exists |
| `EVOLINK_BASE_URL` | no | `https://direct.evolink.ai/v1` | EvoLink API base |
| `EVOLINK_MODEL` | no | `gpt-5.2` | Override model name in EvoLink mode |

*The plugin auto-enables when `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is present. A manually enabled authenticated proxy can operate without any local provider key; direct provider calls still fail explicitly when their required credential is unavailable.

## How to extend

**Add a new model handler:**

1. Create `models/<name>.ts` exporting an async handler function matching the relevant `@elizaos/core` params/return type.
2. Re-export from `models/index.ts`.
3. Add a new `models: { [ModelType.NEW_TYPE]: async (runtime, params) => handler(runtime, params) }` entry in `index.ts`.
4. Add config helpers for any new env vars to `utils/config.ts`.

**Add a new model size tier:**

Model tiers (nano/medium/mega/response-handler/action-planner) all call the shared `generateTextByModelType()` in `models/text.ts`. Add a getter to `utils/config.ts` following the `OPENAI_<TIER>_MODEL` / `<TIER>_MODEL` fallback pattern, then wire it in `index.ts`.

## Conventions / gotchas

- **Dual build (node + browser).** Exports differ: `dist/node/index.node.js` and `dist/browser/index.browser.js`. Browser build avoids sending `Authorization` headers by default; set `OPENAI_BROWSER_BASE_URL` to a server-side proxy.
- **Cerebras mode.** Detected automatically from `ELIZA_PROVIDER=cerebras`, `OPENAI_BASE_URL` matching `*.cerebras.ai`, or presence of `CEREBRAS_API_KEY` without `OPENAI_API_KEY`. In Cerebras mode: caller-supplied response schemas use strict `json_schema` output without OpenAI's all-properties-required rewrite; explicit JSON-only requests retain `json_object`; `reasoning_effort` defaults to `"none"` for Qwen 3.8 and `"low"` for GPT-OSS/GLM; `promptCacheRetention` is stripped (Cerebras rejects it); embeddings fall back to a deterministic local hash when no explicit embedding URL is set.
- **Strict-schema stripping (default for strict/unspecified tools, ALL providers).** `sanitizeJsonSchema` in `models/text.ts` is the single wire choke point for non-Cerebras `response_format` schemas (`buildStructuredOutput`) and every strict or unspecified tool schema (`normalizeNativeTools`). It strips the constraint keywords strict-grammar providers (Cerebras via Eliza Cloud, OpenAI strict) 400 on — `maxItems`, `minItems`, `maxLength`, `minLength`, `pattern`, `format`, `minProperties`, `maxProperties` — folding each into the node's `description` so the model keeps the intent, and recurses through `properties`/`items`/`anyOf`/`oneOf`/`allOf`/`$defs`/`patternProperties`/`contains`/`if`-`then`-`else`. Numeric bounds (`minimum`/`maximum`/`multipleOf`/`uniqueItems`) pass through untouched. This is **not** gated on Cerebras mode — `isCerebrasMode` is proxy-blind (an agent on `api.eliza.app` with `OPENAI_API_KEY` looks like plain OpenAI, which is exactly where the 400s fired). Real bounds are still enforced app-side: `parseAndValidate` re-checks the caller's ORIGINAL schema. So do NOT add per-schema constraint-stripping — the choke point already does it (#11123 / #11153).
- **Explicit non-strict tools preserve their schema.** A core `ToolDefinition` with `strict: false` bypasses strict-schema rewriting and reaches a non-Cerebras OpenAI-compatible endpoint with the caller's exact parameter schema and `strict: false`. This is reserved for transports whose contract requires optional fields to remain optional; strict/unspecified tools continue through the sanitizer above, and Cerebras mode still applies its compatibility normalization.
- **Optional-compatible strict opt-in.** Core Action adapters mark aggregators that require optional fields with `strictWithOptionalProperties: true`. Cerebras can normalize these tools through the existing strict-safe, reversible schema path while keeping optional properties optional. Arbitrary native tools with `strict: false` and no opt-in keep their prior behavior; other providers do not upgrade the flag.
- **Cerebras optional tool arguments stay optional.** Native-tool normalization preserves declared required fields; other providers retain the all-properties-required strict contract. Returned tool arguments still validate against the original schema.
- **Free-form record/map tool args use the #13111 strict-safe transform.** `sanitizeJsonSchema` still forces `additionalProperties: false` on every object for strict-grammar providers, but `normalizeNativeTools` rewrites declared free-form record/map tool args (`additionalProperties: true` or a value schema, e.g. contact `customFields`) into a model-facing `__eliza_record_entries` key/value array. Returned tool calls are reverse-mapped back to the original object shape before runtime validation, so tool authors still receive the schema they declared without reopening #11123/#11156 strict-schema 400s. Structured planner responses use their own reversible response-format transform; direct Cerebras response schemas otherwise retain caller semantics, while non-Cerebras response schemas use compatibility sanitization.
- **EvoLink mode.** Detected automatically from `ELIZA_PROVIDER=evolink`, `OPENAI_BASE_URL` matching `*.evolink.ai`, or presence of `EVOLINK_API_KEY` without a conflicting key. Uses `EVOLINK_BASE_URL` (default `https://direct.evolink.ai/v1`) and defaults to `gpt-5.2` as the model.
- **Per-call model override.** Text handlers honor `params.model` before slot-level model settings. Workflow generation uses this for isolated calls such as Cerebras `gpt-oss-120b` without changing every OpenAI text call.
- **Usage attribution.** Every usage-bearing model call emits `MODEL_USED` with the resolved concrete model in `model` / `modelName`, the logical slot in `type` / `modelLabel`, and the backend that actually served the request in `provider` (`openai`, `cerebras`, or `evolink`). Keep `source: "openai"` as the plugin/transport identity; never substitute the logical slot for the billable model id.
- **Explicit OpenRouter fallback.** `OPENROUTER_FALLBACK_MODEL` plus server-side `OPENROUTER_API_KEY` permits Cerebras HTTP 429/cooldown recovery inside the same model call. An eligible pre-output 429 yields to the configured fallback on its first attempt, including when Retry-After is absent; other transient failures keep their bounded retry policy. The handler preserves complete input and never replays tools, retries partial output, changes runtime settings, or exports credentials to browser builds. Endpoint cooldowns are separate; serving model/provider metadata and usage identify OpenRouter. Its wire adapter preserves strict schema semantics, translates reasoning, and requires parameter support with data collection denied. See README for configuration.
- **Reasoning models.** Pass `OPENAI_REASONING_EFFORT=low|medium|high` to control o-series / gpt-oss reasoning budgets. Valid values: `minimal`, `low`, `medium`, `high`.
- **Prompt caching.** Pass `providerOptions: { openai: { promptCacheKey: "...", promptCacheRetention: "24h" } }` on any `GenerateTextParams` call to enable OpenAI prompt caching.
- **Deep research.** `ModelType.RESEARCH` uses the OpenAI Responses API (`POST /responses`), not Chat Completions. It defaults to `o3-deep-research` and can take minutes to hours; use `params.background = true` for long jobs.
- **Tokenizer.** Uses `js-tiktoken` (WASM, browser-safe). `TEXT_TOKENIZER_ENCODE/DECODE` do not hit the network.
- **All API calls go through `recordLlmCall()`** from `@elizaos/core` for trajectory logging. Audio/embedding handlers carry a `// @trajectory-allow` comment where appropriate.
- **No barrel re-export of internal utils.** Import from `"../utils/config"`, `"../utils/events"`, etc. directly within the plugin.
- See root `CLAUDE.md` for repo-wide architecture rules, logger conventions, ESM requirements, and naming standards.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
