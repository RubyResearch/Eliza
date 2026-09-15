# @elizaos/plugin-browser

Browser automation and companion bridge plugin for elizaOS. Adds the `BROWSER` action and `MANAGE_BROWSER_BRIDGE` action to any Eliza agent, owns the Eliza browser workspace (electrobun-embedded `BrowserView` on desktop, JSDOM fallback on web/mobile), and manages the Chrome, Firefox, and Safari Agent Browser Bridge companion extension.

## What this plugin provides

### Actions

**BROWSER** — Controls a registered browser target. The agent picks the best available backend automatically, or you can pin a specific target with the `target` parameter. Supported operations:

| `action` value | What it does |
|---|---|
| `open` | Open a URL in a new tab |
| `navigate` | Navigate an existing tab to a URL |
| `click` | Click a DOM element by CSS selector |
| `type` | Type text into a selector |
| `fill` / `clear` | Replace a form control's value or clear it |
| `press` | Press a keyboard key |
| `scroll` / `scroll_into` | Scroll by direction and pixels, or reveal a selector |
| `hover` | Hover a DOM element by CSS selector |
| `drag` | Drag a source selector to `targetSelector` |
| `get` | Get a DOM value |
| `state` | Return current tab state (URL, title) |
| `snapshot` | Capture a DOM snapshot |
| `screenshot` | Capture a screenshot |
| `reload` | Reload the current tab |
| `back` / `forward` | Browser history navigation |
| `close` | Close a tab |
| `show` / `hide` | Show or hide the browser window |
| `wait` | Wait for a selector to appear |
| `tab` | Tab management (list/new/close/switch) |
| `realistic_click` | Animated cursor click (visible to user) |
| `realistic_fill` | Animated fill with per-character delay |
| `realistic_type` | Animated typing |
| `realistic_press` | Animated key press |
| `cursor_move` | Animate cursor to a position |
| `cursor_hide` | Hide the cursor overlay |
| `autofill_login` | Fill saved credentials into a browser tab (vault-gated; requires `domain`) |

**MANAGE_BROWSER_BRIDGE** — Manages the Chrome, Firefox, and Safari companion extension. Subactions: `install` (build + reveal + open manager), `reveal_folder` (open the build folder in Finder/Explorer), `open_manager` (the selected browser's extension manager), `refresh` (report the complete paired-companion inventory, exact count, and settings). Owner-only.

Promoted Browser operations expose login fields (`domain`, `username`, `submit`)
only for `BROWSER_AUTOFILL_LOGIN`, and URL-wait fields (`pattern`,
`pollIntervalMs`) only for `BROWSER_WAIT_FOR_URL`. These fields belong to the
specialized handlers, not ordinary workspace commands. The parent `BROWSER`
retains every parameter, and target selection, vault authorization and URL-wait
validation still run in the shared handlers.

Promoted operations also restrict tab, scroll, keyboard, drag, cursor and typing
options to their applicable operations. Navigation no longer repeats those
interaction-only fields. The parent still exposes the full contract, every
authorized child remains discoverable, and common target, tab ID and timeout
arguments remain available. This changes schema exposure, not command dispatch.

The `script` parameter remains on the parent and `BROWSER_WAIT`, where a
target may accept a wait predicate under its existing script policy. Other
promoted operations do not consume it. Web script execution stays disabled;
desktop script execution still requires explicit opt-in.

When a model omits `url`, the dispatcher recognizes the first explicit HTTP(S)
link in the current message using standard linkification boundaries. Sentence
punctuation is excluded; explicit `url` arguments retain their exact value.

### Browser targets

The plugin uses a pluggable target registry in `BrowserService`. Targets are selected automatically by availability and score:

| Target ID | Backend | When available |
|---|---|---|
| `workspace` | Electrobun `BrowserView` (desktop) or JSDOM (web) | Always |
| `bridge` | Paired Chrome, Firefox, or Safari via companion extension | At least one companion paired |
| `stagehand` | Playwright/Stagehand via HTTP endpoint | `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` or `STAGEHAND_SERVER_URL` set |

External plugins can register additional targets by calling `BrowserService.registerTarget(target)`.

### Confirmed uploads

Generic `eval`, `upload`, and `realistic-upload` commands fail closed. Uploads
must use `BrowserService.executeConfirmedUpload` with the core v2 interaction
contract: an explicitly granted account profile, a pinned adapter advertising
the upload action, the exact semantic action digest, and an atomically
consume-once confirmation. A target must separately opt in through
`executeAuthorizedUpload` and return an applied effect receipt for the exact
surface, generation, operation, and action idempotency key. The receipt records
only opaque session, account-grant, and resource identities; raw owner/profile
handles and file handles are excluded.

The built-in `workspace`, `bridge`, and `stagehand` targets do not yet expose a
proof-producing upload hook, so they reject uploads before consuming a
confirmation. A custom target must not opt in until its underlying browser or
provider can return authoritative acceptance evidence.

### Provider

`browser_workspace` — Injects the current dispatch mode (`desktop` / `web`) and the complete list of open tabs into agent context. Active when the `browser` or `web` context is selected.

### Routes

`/api/browser-bridge/*` — HTTP surface for the companion extension: pairing, settings, tab sync, page-context ingest, session progress, and extension package build/download.

## Requirements

### Auto-enable

The plugin is opt-in. It activates when `config.features.browser` is truthy in the elizaOS agent config:

```json
{
  "features": {
    "browser": true
  }
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` | Full URL for the Stagehand command endpoint |
| `STAGEHAND_SERVER_URL` | Stagehand base URL (commands go to `<url>/api/browser-command`) |
| `ELIZA_BROWSER_STAGEHAND_URL` | Alias for `STAGEHAND_SERVER_URL` |
| `ELIZA_BROWSER_STAGEHAND_AUTO_SETUP` | Set `false` to disable automatic stagehand-server install/build |
| `ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE` | Set `true` to allow stagehand target on mobile |
| `ELIZA_MOBILE_PLATFORM` / `ELIZA_PLATFORM` / `CAPACITOR_PLATFORM` | Platform hint for target scoring (`ios`/`android`/`mobile`) |
| `ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL` | Chrome Web Store listing override |
| `ELIZA_BROWSER_BRIDGE_FIREFOX_ADDONS_URL` | Firefox Add-ons listing override |
| `ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL` | Safari App Store listing override |

### Vault keys (set by the user, not env vars)

`autofill_login` only fires when the user has pre-authorized it per domain:

- `creds.<domain>.:autoallow = "1"` — set via Settings → Vault → Logins.

Without this flag, the action returns an error rather than prompting interactively.

## Companion extension authentication

Companion-scoped endpoints require two headers:

```
X-Browser-Bridge-Companion-Id: <companion uuid>
Authorization: Bearer <pairing token>
```

Legacy header aliases (`X-LifeOps-Browser-Companion-Id`, `x-eliza-browser-companion-id`) are not accepted.

## Database

Drizzle tables in the `browser` PostgreSQL schema (applied by elizaOS `plugin-sql` migrator):

- `browser_bridge_companions`
- `browser_bridge_settings`
- `browser_bridge_tabs`
- `browser_bridge_page_contexts`

## Registering a custom browser target

### Native app connected to a remote runtime

On Capacitor clients, `uiBrowserSurface: "native"` identifies the Browser
implementation; it does not grant authority or supply tools. The host binds
`BrowserService.setNativeClientTransport` to its authenticated, client-targeted view
interaction transport, including when the plugin starts after the API server.
The ordinary BROWSER action and its OWNER/domain policies remain in use.

Native open/navigate/show target the client's existing shell navigation channel,
not the Mac tab store. Show Browser before reading its native page. Native `snapshot` and `get` text/title/URL
read the requesting client's mounted page, never a substitute Mac document.
Snapshots report truncation; native reads are limited to visible page text and
exclude form values. Native click/fill/script/upload and other unsupported
commands fail explicitly rather than being replayed on the Mac. This is not a
claim of complete native browser automation parity.

Any plugin can extend the browser dispatch surface at runtime:

```ts
import { BrowserService, BROWSER_SERVICE_TYPE } from "@elizaos/plugin-browser";
import type { BrowserTarget } from "@elizaos/plugin-browser";

const myTarget: BrowserTarget = {
  id: "my-target",
  name: "My Browser",
  description: "Custom browser backend.",
  kind: "external",
  priority: 50,
  available: async () => true,
  execute: async (command) => { /* ... */ },
};

const browserService = runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE);
browserService?.registerTarget(myTarget);
```
