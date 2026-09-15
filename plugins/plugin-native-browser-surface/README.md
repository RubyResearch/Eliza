# @elizaos/capacitor-browser-surface

`ElizaSurfaceManager` — the native Capacitor plugin that layers one **isolated
native web surface per Browser tab** on the mobile shell (issue #15245, deferred
from #14181, parent epic #13452).

The Browser view hosts arbitrary third-party web content. On desktop it embeds an
Electrobun `WebContentsView` (its own renderer process). On the web it degrades to
a sandboxed iframe. On a **native mobile shell** an in-realm iframe would still
share the host WebView's renderer process and storage partition — the exact
cross-surface leak the isolation epic closes. This plugin gives each tab its own
native child web surface instead:

- **iOS** — a `WKWebView` per surface. `isolated` process ⇒ a fresh
  `WKProcessPool` boundary; `isolated` storage ⇒
  `WKWebsiteDataStore.nonPersistent()` (its own cookies/localStorage/IndexedDB).
  `shared` reuses a plugin-owned pool / the default store.
- **Android** — a `WebView` per surface with a verified out-of-app sandboxed
  renderer; Android may reuse that renderer process across sibling WebViews.
  `isolated` storage ⇒ its own androidx.webkit multi-profile `Profile`. If the
  system WebView is too old for multi-profile or cannot expose an out-of-app
  renderer, `createSurface` **rejects** rather than silently weakening the
  boundary.

## Explicit-policy invariant

Every surface carries an **explicit** process + storage policy. `createSurface`
rejects when either field is absent — there is no implicit platform default,
because a defaulted storage partition is the leak this closes. The policy is
derived from the view's `SurfaceManifest` on the JS side
(`packages/ui/src/surface/native-surface-shell.ts` → `deriveSurfacePlacement`).

## Consumer

The renderer never imports this package directly. `@elizaos/ui`'s
`capacitor-native-surface-shell.ts` models the method set structurally and calls
it through the Capacitor `Plugins` registry under the jsName `ElizaSurfaceManager`;
`use-mobile-native-tab-surfaces.ts` drives one surface per Browser tab
(create → setBounds/navigate → foreground/background → destroy) on the
`native-mobile-webview` render path.

The mobile Back control calls `goBack` on that same native tab, never a server
workspace tab with an unrelated ID. Native page completion emits a
`navigationChanged` invalidation carrying the surface owner/session/epoch. The
driver reads the current native URL, discards stale observations, and updates
the React address bar without reloading the page. Listener cleanup and ownership
checks apply across remounts. A Back command is not automatically retried after
a lost acknowledgement, because repeating it could navigate back twice.

This URL/history channel does not expose native page DOM to the remote agent.
Server-side browser snapshots are not proof of what a native page displays.

`readPage` is the separate read-only native primitive. It runs the bundled
`resources/read-page.js` operation against the owned, foregrounded page; callers
may supply a CSS selector, not JavaScript. It returns URL, title, visible text,
and `truncated: false`. Hidden text, scripts and form values are excluded; every
visible text node is read without a character or node-count cap. Loading/failed pages,
ownership changes, navigation during the read, and a five-second timeout reject
the read instead of returning stale text. The web implementation rejects it as
native-only. Page content is untrusted data.

This primitive alone does not route runtime BROWSER actions to the phone. The
host must use the requesting client's authenticated interaction channel and
must not substitute a server-side page when the native read is unavailable.

`setBounds` carries both the page rectangle and its outer rounded clip in one
update. The renderer reads that clip from the actual computed overflow-clipping
host instead of copying a CSS radius token. Android and iOS update their paint
mask and hit-test shape in place, so responsive radius changes neither reload
the page nor interfere with the independent React-overlay occlusion holes.

## Non-goals

- Desktop `WebContentsView` embedding (shipped in #14181).
- Wallet / EIP-1193 injection and the desktop `BROWSER_TAB_PRELOAD_SCRIPT` — mobile
  native surfaces do not expose arbitrary script execution to the agent.

## Testing

- `bun run test` — web-fallback and native source-contract tests.
- Android `connectedAndroidTest` — cross-profile storage-isolation on a real
  emulator plus outer-corner/occlusion paint and touch composition
  (`BrowserSurfaceIsolationInstrumentedTest`).
- The JS driver + placement + per-tab hook are unit-tested in `@elizaos/ui`
  (`src/surface/*.test.ts`, `src/surface-embedding.test.ts`).
