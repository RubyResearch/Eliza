# @elizaos/prompts

Shared prompt templates and action specs for elizaOS.

The Stage-1 message-handler template uses the registered flat response schema:
`contexts`, `intents`, `candidateActionNames`, `facts`, `relationships`, and
`addressedTo`. Routing is derived by the runtime; the model is not asked to
invent retired `simple`, `requiresTool`, `parentActionHints`, `contextSlices`,
or nested `extract` fields. Complete history, provider data, context catalogs,
and registered field descriptions remain the responsibility of their existing
renderers. Changing this template does not truncate those inputs.

## Overview

This package is the single source of truth for prompt templates used by the runtime. Prompts are authored directly in `src/index.ts`.

## Structure

```
packages/prompts/
├── src/
│   ├── index.ts      # TypeScript prompt template exports
│   └── prompt-compression.ts # lossless compatibility helper
├── dist/             # generated JavaScript, declarations, and publish manifest
├── tsconfig.json     # package-owned source typecheck
├── specs/            # Merged action/provider specs (JSON) + generated plugins.generated.json
└── scripts/          # Spec + docs generators
    ├── generate-action-docs.js
    ├── generate-plugin-action-spec.js
    └── check-secrets.js
```

## Template Syntax

Prompts use Handlebars-style variables:

- `{{variableName}}` - simple variable substitution
- `{{#each items}}...{{/each}}` - iteration
- `{{#if condition}}...{{/if}}` - conditional

Use camelCase for variables (`{{agentName}}`, `{{providers}}`, `{{recentMessages}}`).

## Plugin-local `prompts/*.json` (under `plugins/**`)

Some plugins keep **hand-edited** `actions.json` / `evaluators.json` / `providers.json` next to their source. Those files feed **per-plugin codegen** (for example `generated/specs/spec-helpers.ts` via each plugin’s own workflow). They are **not** inputs to `scripts/generate-plugin-action-spec.js`, which instead scans `plugins/**/*.ts` for `export const …: Action` blocks and writes `specs/actions/plugins.generated.json`.

## Building

```bash
# Compile the publishable package, generate the plugin action spec, and action docs
bun run build

# Compile only the native-Node package artifact
bun run build:package
```

Bun workspace tooling resolves the maintained TypeScript source through the
`bun` export condition, and Vite resolves it through `module`. Vitest removes
that condition in Node mode, so clean-workspace Vitest configs must use the
explicit `eliza-source` condition or a targeted source alias. Workspace
TypeScript consumers resolve source types before `dist/` exists, while normal
native Node workspace consumers continue to use the compiled `dist/` entry.
The generated publish manifest rewrites every source-facing condition to
compiled JavaScript and declarations in `dist/`, so the release tarball never
publishes TypeScript source as runtime code.

The repository runs this package's tests serially because they rebuild and
temporarily remove `dist/` while checking consumer resolution. Concurrent
workspace tests may still be importing that compiled package.

## Usage

Runtime code imports the templates through `@elizaos/core`, which re-exports them and provides `composePrompt` to fill the `{{...}}` placeholders:

```typescript
import { REPLY_TEMPLATE, composePrompt } from "@elizaos/core";

const prompt = composePrompt({
  state: { agentName: "Alice" },
  template: REPLY_TEMPLATE,
});
```

Import directly from `@elizaos/prompts` only inside this package's tooling and tests.

## Adding New Prompts

1. Add a `camelCaseTemplate` string export in `src/index.ts`.
2. Add the paired `UPPER_SNAKE_CASE_TEMPLATE` export.

## Template Guidelines

1. **Start with a task description** — begin prompts with `# Task:` to state the objective.
2. **Include providers placeholder** — use `{{providers}}` where provider context should be injected.
3. **Use JSON output format** — standardize on JSON response format for consistent parsing.
4. **Add clear instructions** — explicit instructions for the LLM.
5. **End with output format** — always specify the expected output format.

## Security & Privacy

- **Do not embed real secrets** in prompt templates. Prompts are source-controlled.
- **Avoid including PII** (emails, phone numbers, addresses, IDs) in templates or examples.
- Prefer placeholders (e.g., `{{apiKey}}`, `{{userEmail}}`) and inject only the minimum needed at runtime.

### Secret scan

```bash
bun run check:secrets
```

Scans `packages/prompts/src/**/*.ts`, plugin prompt TS modules (paths matching `prompts/**/*.ts`, `workflow-prompts/**/*.ts`, etc.), and a few explicit files — see `scripts/check-secrets.js`.

The default handler groups routing, reply, crisis and authority rules without repeating the same constraints. Literal recall from supplied evidence can answer directly; live records and effects still plan. Registered field contracts and source selection remain complete.
