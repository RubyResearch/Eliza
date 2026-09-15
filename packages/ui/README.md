# @elizaos/ui

Shared UI primitives, composites, and layout utilities for elizaOS apps.

`@elizaos/ui` is the design system and front-end runtime glue used across the
elizaOS ecosystem. It bundles the React component library, the agent dashboard
shell, a typed HTTP/WebSocket API client for the agent runtime, the
agent-surface layer that makes plugin views controllable by the agent, GenUI,
voice, theming, i18n, and platform/bridge integration for web, desktop
(Electrobun), and mobile (Capacitor).

## Who uses it

It is imported by the elizaOS web and desktop app, the cloud frontend, the
marketing/OS homepages, and many plugin UI packages. React and react-dom are
peer dependencies — the host application owns the React instance.

## Install

```bash
bun add @elizaos/ui
```

Requires `react` and `react-dom` `19.2.7` as peer dependencies.

## Usage

Import components and utilities from the root barrel or, preferably, from a
subpath to keep bundles lean:

```tsx
import { Button } from "@elizaos/ui/button";
import { ElizaClient } from "@elizaos/ui/api";
import { isAuthenticatedNow } from "@elizaos/ui/auth-status";
import { useMediaQuery } from "@elizaos/ui/hooks";
import "@elizaos/ui/styles"; // default stylesheets (renderer only)
```

Login components, wallet providers and authentication hooks are exported from
the root `@elizaos/ui` barrel. The authentication client and service are owned
by `@elizaos/login`. The imported login source retains its original MIT notice
in [`src/login/LICENSE`](src/login/LICENSE), included in the published UI artifact.

```tsx
import { LoginProvider, LoginForm, useAuth, useLogin } from "@elizaos/ui";
import type { LoginFormProps } from "@elizaos/ui";
```

Wallet providers load their adapters on demand and show a loading state while
initializing. `createDefaultWagmiConfig` is asynchronous at the root export;
await it before passing its result to `EVMWalletProvider`. Supply your own
WalletConnect project ID or a prebuilt configuration. The bundled login form
also accepts `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; no external project's ID
is supplied by default.


Cloud-frontend components live under a dedicated subpath:

```tsx
import { DashboardActionCards } from "@elizaos/ui/cloud-ui";
import "@elizaos/ui/cloud-ui/index.css";
```

Stylesheets are intentionally separate from the JS barrel so Node-side plugin
loaders can import `@elizaos/ui` without evaluating CSS. Import
`@elizaos/ui/styles` explicitly from the renderer.

## Notable subsystems

- **API client** (`@elizaos/ui/api`) — `ElizaClient` plus per-domain client
  modules for agents, chat, cloud, automations, and more.
- **Auth status** (`@elizaos/ui/auth-status`) — a narrow, read-only snapshot and
  subscription seam for session-gated renderer background services.
- **Agent surface** (re-exported from `@elizaos/ui`) — `useAgentElement` and the
  provider/overlay that let the agent address, focus, fill, and click view
  elements. See `src/agent-surface/README.md`.
- **GenUI** (`@elizaos/ui/genui`) — declarative, agent-generated UI (an
  A2UI-compatible subset). See `src/genui/README.md`.
- **Config** (`@elizaos/ui/config`) — boot config, branding, and the
  plugin-config UI-spec engine.
- **Registries** — `registerAppShellPage` for runtime nav tabs, the widget and
  overlay-app registries, and `registerProviderLogo`.
- **Devices & Runtimes** — Settings management for local, Cloud, E2EE relay,
  and fingerprint-pinned SSH runtimes. Renderer state stores only public trust
  metadata and native credential references, never controller private keys or
  durable runtime bearer values.

## Registered plugin pages

Register a page with `registerAppShellPage` and let its surface manifest own the
framing contract. The default `header: "normal"` gives both signed in-process
and remotely loaded versions exactly one shell `ViewHeader`, titled from the
registration. Use `fullscreen`, `immersive`, or `modal` only when the page owns
that framing deliberately; those policies suppress the injected header.

Plugin pages can import the shared recipe from narrow stable subpaths:

```tsx
import {
  ActionListRow,
  AppPageSidebar,
  SectionNav,
  ViewBackButton,
  ViewHeader,
} from "@elizaos/ui/components/shared";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "@elizaos/ui/components/composites/settings";
```

Normal pages render only their body. Do not recreate a header, safe-area pad,
or floating-chat clearance inside the plugin; the shell owns those layers.

## Notifications

See [notification-policy.md](notification-policy.md) for shared native delivery,
viewport fallback ownership, interactive popup exceptions, and platform limits.

The separate `/dev` chat polls recent foreground trajectory summaries for the
active room. Background activity cannot displace those token counts. Opening
Inspect retrieves all runs linked to that message, including background work;
the advanced inspector retains global pagination. Raw payloads remain on demand.
Token attribution requires a recorded reply link; unlinked legacy messages and
background notices never borrow the preceding request's counts.

## Development

```bash
bun run --cwd packages/ui build       # build the publishable dist/
bun run --cwd packages/ui typecheck
bun run --cwd packages/ui test
bun run --cwd packages/ui lint
bun run --cwd packages/ui stories:dev # component stories
bun run --cwd packages/ui audit:story-coverage # report current story coverage
bun run --cwd packages/ui audit:stories:build  # build and gate every story
```

The realtime voice playback sample-rate boundary has a browser audio check:
`bun run --cwd packages/ui test:voice-playback-e2e` renders the streaming sink in
Chromium at 16, 44.1, and 48 kHz. Set `PLAYBACK_EVIDENCE_DIR` to retain the rendered
WAV files and duration, pitch, continuity, and interruption measurements.

This is a library; there is no standalone dev server — run it through a host app.

The ownership, adapter, variant, and exception rules for shared UI live in
[`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md). Run
`bun run --cwd packages/ui audit:design-system` before submitting changes to
tokens, controls, or reusable UI patterns.
