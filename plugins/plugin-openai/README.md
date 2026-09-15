# @elizaos/plugin-openai

OpenAI model-provider plugin for [elizaOS](https://github.com/elizaos/eliza). Adds text generation, embeddings, image generation, image description, audio transcription, text-to-speech, and deep research to any Eliza agent by registering handlers for the standard `ModelType.*` slots on the `AgentRuntime`.

## What this plugin does

- **Text generation** — multiple tiers (nano, small, medium, large, mega), plus dedicated response-handler and action-planner slots. Supports streaming and structured JSON output.
- **Text embeddings** — `text-embedding-3-small` by default; dimension configurable.
- **Image generation** — DALL-E 3 by default (`dall-e-3`).
- **Image description** — vision model analyzes an image URL and returns `{ title, description }`.
- **Audio transcription** — speech-to-text (`gpt-5-mini-transcribe` by default); accepts `Buffer`, `Blob`, `File`, or a URL.
- **Text-to-speech** — returns an `ArrayBuffer` of audio. Six voices; mp3/wav/flac/opus/aac/pcm output.
- **Deep research** — `ModelType.RESEARCH` via the OpenAI Responses API (`o3-deep-research` by default); returns annotated, multi-source research reports.
- **Tokenizer** — encode/decode using js-tiktoken (browser-safe, no network calls).

Works with any OpenAI-compatible endpoint: OpenAI, Cerebras, EvoLink, OpenRouter, local servers, etc.

## Enabling the plugin

Add `@elizaos/plugin-openai` to your character's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-openai"]
}
```

The plugin auto-enables when `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is present in the environment.

## Authentication configuration

```
OPENAI_API_KEY=sk-...
```

Use `OPENAI_API_KEY` for direct OpenAI calls, `CEREBRAS_API_KEY` or
`EVOLINK_API_KEY` for those compatible providers, or configure an authenticated
OpenAI proxy. No individual key is universally required in plugin metadata;
direct calls still fail explicitly when their selected endpoint lacks auth.

## Full configuration reference

Set these as environment variables or in your character's `settings` object.

### API endpoint

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for compatible endpoints |
| `ELIZA_PROVIDER` | — | Set to `cerebras` or `evolink` to force a compatible-provider mode |
| `EVOLINK_API_KEY` | — | Auth for EvoLink's OpenAI-compatible endpoint |
| `EVOLINK_BASE_URL` | `https://direct.evolink.ai/v1` | EvoLink endpoint used when `EVOLINK_API_KEY` enables the plugin |
| `EVOLINK_MODEL` | `gpt-5.2` | Text model used by EvoLink mode |

### Text generation models

| Variable | Default | Description |
|---|---|---|
| `OPENAI_SMALL_MODEL` / `SMALL_MODEL` | `gpt-5.4-mini` | Fast, cost-effective responses |
| `OPENAI_NANO_MODEL` / `NANO_MODEL` | falls back to small | Fastest tier |
| `OPENAI_MEDIUM_MODEL` / `MEDIUM_MODEL` | falls back to small | Mid-tier |
| `OPENAI_LARGE_MODEL` / `LARGE_MODEL` | `gpt-5` | Complex reasoning |
| `OPENAI_MEGA_MODEL` / `MEGA_MODEL` | falls back to large | Highest tier |
| `OPENAI_RESPONSE_HANDLER_MODEL` | falls back to small | Response-handler slot |
| `OPENAI_ACTION_PLANNER_MODEL` | falls back to medium | Action-planner slot |
| `OPENAI_FALLBACK_MODEL` / `CEREBRAS_FALLBACK_MODEL` | unset | Optional same-endpoint model for requests made while the primary is in a rate-limit cooldown |
| `OPENROUTER_FALLBACK_MODEL` | unset | Explicit OpenRouter text model used after a Cerebras 429, e.g. `qwen/qwen3.8-27b` |
| `OPENROUTER_API_KEY` | unset | Server-side credential for the opt-in OpenRouter fallback |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter-compatible fallback endpoint |
| `OPENAI_REASONING_EFFORT` | — | `minimal`/`low`/`medium`/`high` for o-series models |

The optional fallback applies only after a provider rate-limit response has put
the primary model into cooldown. It keeps the full request and the same endpoint
and credentials; it does not switch providers. An unset, identical, or also-held
fallback preserves the explicit cooldown error. After cooldown expires, requests
return to the primary. Configure a fallback that supports the request's tools,
attachments, and structured output; unsupported requests still fail explicitly.

For cross-provider rate-limit recovery, configure both `OPENROUTER_API_KEY` and
`OPENROUTER_FALLBACK_MODEL` on the backend while leaving Cerebras primary. This
retries only the failed **model call**, not previously executed actions, with
the complete messages, tools, constraints and response schema. It applies to
all text tiers and the response-handler/planner slots. It never sends the
credential to a browser build, changes embeddings or voice, activates a local
model, or substitutes a canned reply.

OpenRouter recovery is limited to HTTP 429/cooldown failures before any output
has reached the caller. With that explicit fallback configured, the first eligible
429 yields immediately even without Retry-After; it does not repeat the same
rate-limited request through transient backoff first. Other transient errors
retain bounded retries, and installations without a fallback keep their prior
retry policy. Auth/schema failures and partial streams stay explicit;
an aborted call never starts a fallback. Each endpoint has an independent
credential-scoped cooldown, and Cerebras becomes primary again when its window
expires. OpenRouter routing requires all request parameters, denies providers
that collect prompts for training, and sorts eligible providers by latency.
The equivalent Qwen model retains disabled thinking through OpenRouter's
`reasoning.enabled=false` contract. Actual cost and speed depend on the serving
provider; monitor usage rather than assuming equal pricing or latency.

### Embeddings

| Variable | Default | Description |
|---|---|---|
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `OPENAI_EMBEDDING_URL` | `OPENAI_BASE_URL` | Separate endpoint for embeddings |
| `OPENAI_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | Separate key for embeddings |
| `OPENAI_EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions (must match model) |

### Image generation and description

| Variable | Default | Description |
|---|---|---|
| `OPENAI_IMAGE_MODEL` | `dall-e-3` | Image generation model |
| `OPENAI_IMAGE_DESCRIPTION_MODEL` | `gpt-5-mini` | Vision/description model |
| `OPENAI_IMAGE_DESCRIPTION_BASE_URL` | `OPENAI_BASE_URL` | Separate endpoint for vision |
| `OPENAI_IMAGE_DESCRIPTION_API_KEY` | `OPENAI_API_KEY` | Separate key for vision |

### Audio

| Variable | Default | Description |
|---|---|---|
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-5-mini-transcribe` | Speech-to-text model |
| `OPENAI_TTS_MODEL` | `tts-1` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | `nova` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `OPENAI_TTS_INSTRUCTIONS` | — | Style instructions for TTS |

### Deep research

| Variable | Default | Description |
|---|---|---|
| `OPENAI_RESEARCH_MODEL` | `o3-deep-research` | Research model (o3 or o4-mini variants) |
| `OPENAI_RESEARCH_TIMEOUT` | `3600000` (1 hr) | Request timeout in milliseconds |

### Browser and proxy

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BROWSER_BASE_URL` | — | Proxy URL for browser builds (keeps key server-side) |
| `OPENAI_BROWSER_UPSTREAM_BASE_URL` | — | Actual proxy upstream used for endpoint-specific capability checks |
| `OPENAI_BROWSER_EMBEDDING_URL` | — | Proxy URL for browser embedding requests |
| `OPENAI_ALLOW_BROWSER_API_KEY` | `false` | Send auth header in browser builds (opt-in) |

### Other

| Variable | Default | Description |
|---|---|---|
| `OPENAI_EXPERIMENTAL_TELEMETRY` | `false` | Enable AI SDK experimental telemetry |

## Usage examples

```ts
import { ModelType } from "@elizaos/core";

// Text generation
const reply = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum entanglement in plain English.",
});

// Streaming text
const result = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Count from 1 to 10.",
  stream: true,
  onStreamChunk: (chunk) => process.stdout.write(chunk),
});

// Structured JSON output
const data = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Return a JSON object with name and age fields.",
  responseSchema: {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  },
});

// Embedding
const vector = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "text to embed",
});

// Image generation
const images = await runtime.useModel(ModelType.IMAGE, {
  prompt: "A sunset over mountains",
  count: 1,
  size: "1024x1024",
});

// Image description
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  "https://example.com/photo.jpg"
);

// Audio transcription (Buffer, Blob, File, or URL string all accepted)
const transcript = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

// Text-to-speech
const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
  text: "Hello, world.",
  voice: "nova",
  format: "mp3",
});

// Deep research (may take minutes)
const researchController = new AbortController();
const report = await runtime.useModel(ModelType.RESEARCH, {
  input: "What are the latest advances in fusion energy?",
  tools: [{ type: "web_search_preview" }],
  signal: researchController.signal,
});
// Call researchController.abort() when the result is no longer needed.
console.log(report.text, report.annotations);
```

## Browser proxy setup

In browser builds this plugin does not send `Authorization` headers by default, to avoid exposing API keys in frontend bundles. Point `OPENAI_BROWSER_BASE_URL` at a server-side proxy that injects the key:

```ts
// Minimal Express proxy
import express from "express";
const app = express();
app.use(express.json());

app.all("/openai/*", async (req, res) => {
  const url = `https://api.openai.com/v1/${req.params[0]}`;
  const r = await fetch(url, {
    method: req.method,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
  });
  res.status(r.status).send(await r.text());
});

app.listen(3000);
```

Then set `OPENAI_BROWSER_BASE_URL=http://localhost:3000/openai`.

## Cerebras compatibility

Point `OPENAI_BASE_URL` at a Cerebras endpoint or set `ELIZA_PROVIDER=cerebras` and the plugin automatically adapts: caller-supplied response schemas use strict `json_schema` output without promoting optional fields to required; explicit JSON-only requests retain `json_object` mode, `reasoning_effort` defaults to `"none"` for Qwen 3.8 and `"low"` for GPT-OSS/GLM, and `CEREBRAS_API_KEY` is accepted as an alias for `OPENAI_API_KEY`. Embeddings fall back to a deterministic local hash when no explicit embedding URL is set, since Cerebras does not provide an embeddings endpoint.

## EvoLink compatibility

Set `EVOLINK_API_KEY` to use EvoLink through its OpenAI-compatible endpoint. The plugin defaults to `https://direct.evolink.ai/v1` and `gpt-5.2`; set `EVOLINK_BASE_URL` or `EVOLINK_MODEL` to override either value.

## Prompt caching

Pass `providerOptions.openai.promptCacheKey` and `promptCacheRetention` on any `GenerateTextParams` call to enable OpenAI prompt caching:

```ts
await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "...",
  providerOptions: {
    openai: { promptCacheKey: "my-key", promptCacheRetention: "24h" },
  },
});
```

For Cerebras, `providerOptions.cerebras.promptCacheKey` (or `prompt_cache_key`)
takes precedence over the OpenAI key. An explicit empty Cerebras options object
suppresses the legacy OpenAI key. Core supplies a stable conversation-and-stage
routing key when a conversation ID is available, so unrelated chats do not share
one routing hint merely because their system instructions match. Prefix changes
do not change that routing key. Calls that only supply the OpenAI key remain supported. This does not alter prompt text,
token counts, or permissions; Cerebras still matches actual prompt prefixes and
controls cache retention. See [Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching).

## Free-form record/map tool arguments

Strict tool schemas encode open maps as reversible key/value entry arrays.
Returned arguments are restored to the original object shape before runtime
validation. Structured planner responses use their own reversible transform.
Direct Cerebras response schemas preserve caller semantics, including optional
fields; unsupported schemas remain explicit provider errors. Other compatible
providers retain their existing strict-schema normalization.
