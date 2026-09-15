# `@elizaos/app-core`

Shared application core for elizaOS agent app shells (desktop, mobile, web). It bundles the pieces every shell needs: the CLI bootstrap, the dashboard HTTP API, the Eliza runtime loader, the static app/plugin/connector registry, auth/secrets/vault services, and per-platform bootstrap.

## What's in here

| Subdir          | Contains                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| `src/entry.ts`  | CLI process bootstrap (built to `dist/entry.js`, imported by the generated app launcher).      |
| `src/cli/`      | Commander CLI: `start`, `setup`, `doctor`, `db`, `config`, `dashboard`, `update`, `auth`, …  |
| `src/api/`      | Dashboard HTTP API: server, auth/pairing routes, dev-stack discovery, secrets/wallet routes. |
| `src/runtime/`  | Eliza composition layer, focused startup lifecycle modules, dev server, runtime-mode, and Electrobun desktop runtimes. |
| `src/registry/` | Compatibility re-export of the canonical `@elizaos/registry/first-party` registry. |
| `src/security/` | Agent vault id + platform secure stores + wallet key hydration.                              |
| `src/services/` | Auth store, steward credentials/sidecar, vault mirror/bootstrap, account pool, and more.     |
| `src/platform/` | Per-platform bootstrap (Capacitor for mobile, browser stubs, native plugin entrypoints).     |
| `src/config/`   | `AppConfig` types and `DEFAULT_APP_CONFIG` (re-exported from `@elizaos/shared`).              |

## Usage

```ts
// Node/runtime barrel
import { startApiServer, loadRegistry, getPlugins } from "@elizaos/app-core";

// Targeted subpaths (see package.json exports for the full list)
import { loadRegistry } from "@elizaos/registry/first-party";
import { ensureRouteAuthorized } from "@elizaos/app-core/api/auth";
import { deriveAgentVaultId } from "@elizaos/app-core/security/agent-vault-id";
```

The full subpath list lives in the `exports` map of `package.json`.

## Build & test

```bash
bun run --cwd packages/app-core build       # tsc → flatten → copy assets → rewrite dist ESM imports
bun run --cwd packages/app-core typecheck   # tsc --noEmit
bun run --cwd packages/app-core test         # vitest
bun run --cwd packages/app-core lint         # Biome
```

This package supplies host integration to the `packages/app` shell and app-facing plugins. It targets Node `>=24`, with `react`/`react-dom`/`three` as peer dependencies and the `@elizaos/capacitor-*` mobile bridges as optional dependencies.

Renderer reuse compares source modification times with the manifest's build
start, not its output-write time. Inputs changed during compilation fail the
build before packaging; retry after edits settle. Older completion-only stamps
require one fresh renderer build. This is a local timestamp freshness guard,
not a substitute for reviewing the installed artifact or a content-addressed
source snapshot.

On the self-hosted dashboard, an owner browser session can authenticate a
WebSocket without exposing its HttpOnly session cookie to JavaScript. Cookie
admission uses the canonical session store, requires an owner identity and a
credentialed browser origin, and checks expiry and revocation on each new
connection. Broad cloud or wildcard-bind CORS reachability does not grant
cookie access. Explicit bearer and paired-device authentication retain their
existing transport contracts.

## Isolated local development

Give each concurrent instance distinct `ELIZA_UI_PORT`, `ELIZA_API_PORT`,
`ELIZA_STATE_DIR`, and `ELIZA_WORKSPACE_DIR` values. The development launcher
rejects occupied ports; it never terminates existing services or processes
from another workspace. Stop an old instance explicitly before reusing its ports.

Startup checks optional camera tools without installing them. To install those
tools intentionally, run `node packages/app-core/scripts/ensure-vision-deps.mjs --install` from the repository root. Ollama is a separately managed, optional
provider; Eliza does not need its daemon for in-process local inference.

The web development supervisor also hands diagnostic ownership to
its replacement API process after observing an exact child exit. New tracked
turns are enrolled before the runtime is published; a replacement settles only
matching active trajectories in the same persistent PGlite directory. It never
replays chat or actions. Startup records written before enrollment, historical
unowned records, supervisor/laptop failure, Bun watch mode and native hosts are outside
this recovery scope. Postgres and in-memory databases retain their normal
behavior.

## Local development voice

For the full checkout, provide `CARTESIA_API_KEY` securely in the launch
environment, then run `bun packages/app-core/scripts/dev-ui.mjs --cloud-target=offline`
from the repository root. The supervisor starts the Cartesia realtime gateway
after API readiness, configures Vite's same-origin voice proxy and realtime UI
eligibility, and stops the gateway with the other children. Microphone consent
and gateway health are still required. No separate voice flags are needed for
this local development path. Existing explicit flag overrides remain respected.

The default gateway port is `31338`; override it with
`ELIZA_LOCAL_VOICE_GATEWAY_PORT` when running concurrent checkouts. Check
`/api/v1/voice/session/health` on the UI origin before testing. Without a Cartesia
key, the supervisor does not start this gateway. Do not put the key in `VITE_*`
variables or commit it. This is a loopback development gateway, not a production
deployment recipe; remote and device voice require separate verification.

For the shared demo branch, use `nubsstableDONOTDELETE` and the same commit as
the other developer. Configure the local agent's Cerebras credential and Qwen
small/large text models separately; the voice gateway forwards turns to that
existing runtime and does not create a second agent or change its text model.

## Native inference setup

A normal root `bun install` initializes the pinned fused inference submodule,
ensures the host library and its companion libraries are current, and provisions
the hash-verified default embedding model. Setup then loads the native library
and computes a local embedding before reporting readiness. The runtime discovers these artifacts
under the same state directory without additional environment configuration.
Relative `ELIZA_STATE_DIR` paths resolve from the current working directory;
`~` expands to the user's home directory.

Reuse checks cover every staged native library, host architecture, and native
source changes. Missing or altered companions trigger a rebuild on install;
setup failures fail the install instead of reporting inference as ready.
`ELIZA_SKIP_FUSED_INFERENCE_SETUP=1` is an explicit escape hatch and does not
establish runtime readiness. Android and iOS packaging use their platform build
lanes to produce the corresponding NDK or Apple artifacts.


Android Bun runtime inputs for x64 and arm64 are pinned in
[`scripts/lib/android-bun-artifacts.lock.json`](scripts/lib/android-bun-artifacts.lock.json).
Both stable and canary channels resolve fixed GitHub release-asset IDs, archive
checksums, executable checksums, and source revisions. Staging verifies the
archive before extraction and the executable on every cache use; a mismatch
fails the build. Update the lock deliberately when changing runtime versions.
`ELIZA_BUN_X64_FILE` and `ELIZA_BUN_AARCH64_FILE` can supply downloaded ZIPs for
local or offline builds, and must match those same pins. RISC-V retains its
separate OS cross-build artifact and checksum contract.
