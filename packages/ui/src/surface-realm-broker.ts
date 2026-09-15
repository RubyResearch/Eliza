/**
 * In-process host-realm broker (#14179). An `in-process` view shares the host
 * DOM/JS realm with the shell, so without a boundary it can mutate global state
 * that belongs to the shell or bleeds into the next view: root/body classes,
 * `:root` CSS variables, `localStorage`/`sessionStorage`, and `history`
 * navigation. #14068 landed the wallpaper vector (the background broker); this
 * module completes the remaining four, driven by the SAME resolved surface
 * manifest so there is one policy source, not a parallel table.
 *
 * The broker mirrors `view-capability-broker.ts`: it reads a
 * {@link ResolvedSurfaceManifest} and gates each mutation on the grant that
 * governs it — `storage` for host-scoped persistence, `navigate` for shell
 * navigation — and scopes the DOM class/CSS-var vectors to the shell-owned
 * token set so a view's global reach never survives a navigation. A denied
 * mutation is an observable failure ({@link SurfaceRealmDeniedError}) or an
 * explicit view-namespaced scope, never a fabricated success. Default-deny: a
 * view with no grants gets the safe scope.
 *
 * Two enforcement layers (#13452 acceptance criterion 1):
 *
 * 1. The **facade** ({@link SurfaceRealmScope}) — the sanctioned handles the
 *    shell resolves for the active view (`scope.storage`, `scope.navigate`).
 * 2. The **raw-global guards** ({@link ensureHostRealmGuards}, installed the
 *    first time a scope is published) — a Proxy over `window.localStorage` and
 *    a patch over `History.prototype.pushState`/`replaceState` that apply the
 *    same policy to code that bypasses the facade: a raw write to a
 *    shell-reserved storage key is denied for every view (grant or not, same
 *    as the facade), and a raw path-changing history mutation is denied unless
 *    the active manifest grants `navigate`. Shell code performs its own
 *    reserved-key writes and router navigation through the privileged channel
 *    ({@link shellLocalStorage} / {@link shellHistory} /
 *    {@link runAsPrivilegedShell}).
 *
 * Honest bound: everything here shares one JS realm, so the guards are
 * accident-hygiene for the trusted in-process tier, not an adversarial
 * boundary. Deliberately hostile code can capture pristine globals through a
 * same-origin iframe, assign `location.href` (a full reload, outside history),
 * write `sessionStorage` (unguarded; the shell keeps only the transient
 * focus-connector handoff and first-run session there), or simply import the
 * privileged channel — adversarial content belongs in the `sandboxed-iframe` /
 * `native-webview` isolation levels, which are real process/realm boundaries.
 *
 * Consumed by `App.tsx`, which resolves the active view's manifest and publishes
 * one {@link SurfaceRealmScope} per active view via
 * {@link setActiveSurfaceRealmScope}; the shell resets the DOM scope on view
 * teardown. Unit-tested in `surface-realm-broker.test.tsx`; proven end-to-end in
 * `App.surface-mutation-fuzz.test.tsx`.
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";
import { surfaceGrants } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { THEME_CSS_VAR_MAP, THEME_FONT_CSS_VARS } from "@elizaos/shared";
import { isPrivilegedShellActive } from "./surface-realm-channel";

// Re-export the shell-privileged channel so existing importers of the broker
// (App.tsx, the bridge barrel) keep working; the definitions live in the
// dependency-free `surface-realm-channel` leaf so shell writers don't drag this
// heavy module in. New leaf writers should import from the channel directly.
export {
  runAsPrivilegedShell,
  shellHistory,
  shellLocalStorage,
} from "./surface-realm-channel";

/**
 * Raised when a view attempts a host-realm mutation its manifest does not grant.
 * Thrown (not swallowed) so the denial reaches the caller/agent observably — a
 * blocked write is never turned into a silent no-op that reads as success.
 */
export class SurfaceRealmDeniedError extends Error {
  constructor(
    readonly viewId: string,
    readonly vector: "storage" | "navigate",
    readonly detail: string,
  ) {
    super(`View "${viewId}" denied ${vector}: ${detail}`);
    this.name = "SurfaceRealmDeniedError";
  }
}

// ── Storage vector ───────────────────────────────────────────────────────────

/** Namespace every view-scoped storage key lives under when a view lacks `storage`. */
export const SURFACE_VIEW_STORAGE_PREFIX = "surface:view:";

// The shell persists all of its own UI state under these key namespaces
// (`packages/ui/src/state/persistence.ts`). A view path may never write them:
// even a `storage`-granted view is denied here, so a view can never overwrite
// the owner's theme, background, wallet, or server records.
const SHELL_RESERVED_STORAGE_PREFIXES = [
  "eliza:",
  "eliza.",
  "eliza-",
  "eliza_",
  "elizaos:",
  "elizaos.",
  "elizaos_",
] as const;

/** Whether a storage key belongs to the shell's own reserved namespace. */
export function isShellReservedStorageKey(key: string): boolean {
  return SHELL_RESERVED_STORAGE_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
}

/** The keyspace prefix a view without the `storage` grant is confined to. */
export function surfaceViewStoragePrefix(viewId: string): string {
  return `${SURFACE_VIEW_STORAGE_PREFIX}${viewId}:`;
}

/**
 * The storage surface handed to a view. A strict subset of the DOM `Storage`
 * interface (no index signature) so the façades below are strongly typed without
 * a cast — a view uses the methods, never bracket access.
 */
export interface ScopedStorage {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function namespacedStorage(backing: Storage, prefix: string): ScopedStorage {
  const ownedKeys = (): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < backing.length; i += 1) {
      const key = backing.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };
  return {
    get length() {
      return ownedKeys().length;
    },
    clear() {
      for (const key of ownedKeys()) backing.removeItem(key);
    },
    getItem(key) {
      return backing.getItem(prefix + key);
    },
    key(index) {
      const key = ownedKeys()[index];
      return key === undefined ? null : key.slice(prefix.length);
    },
    removeItem(key) {
      backing.removeItem(prefix + key);
    },
    setItem(key, value) {
      backing.setItem(prefix + key, value);
    },
  };
}

function hostScopedStorage(backing: Storage, viewId: string): ScopedStorage {
  const assertWritable = (key: string): void => {
    if (isShellReservedStorageKey(key)) {
      throw new SurfaceRealmDeniedError(
        viewId,
        "storage",
        `reserved shell key "${key}" is not writable by a view`,
      );
    }
  };
  return {
    get length() {
      return backing.length;
    },
    clear() {
      // Never wipe the shell's own keys, even for a granted view: only clear
      // keys a view path was allowed to write.
      const removable: string[] = [];
      for (let i = 0; i < backing.length; i += 1) {
        const key = backing.key(i);
        if (key !== null && !isShellReservedStorageKey(key))
          removable.push(key);
      }
      for (const key of removable) backing.removeItem(key);
    },
    getItem(key) {
      return backing.getItem(key);
    },
    key(index) {
      return backing.key(index);
    },
    removeItem(key) {
      assertWritable(key);
      backing.removeItem(key);
    },
    setItem(key, value) {
      assertWritable(key);
      backing.setItem(key, value);
    },
  };
}

/**
 * The storage surface for a view, gated on its manifest. Without the `storage`
 * grant a view is confined to a view-prefixed keyspace it can never escape (its
 * writes cannot collide with the shell's keys). With the grant it uses the host
 * keyspace, but the shell's reserved keys stay off-limits — a view never
 * overwrites the owner's persisted shell state.
 */
export function brokerSurfaceStorage(
  manifest: ResolvedSurfaceManifest,
  backing: Storage,
  viewId: string,
): ScopedStorage {
  return surfaceGrants(manifest, "storage")
    ? hostScopedStorage(backing, viewId)
    : namespacedStorage(backing, surfaceViewStoragePrefix(viewId));
}

// ── Navigation vector ────────────────────────────────────────────────────────

/**
 * Wrap the shell's navigate function with the `navigate` gate. A view without
 * the grant cannot drive shell/history navigation: the wrapper throws instead of
 * calling through, so the shell route never moves out from under the user. A
 * granted view navigates normally.
 */
export function brokerSurfaceNavigate(
  manifest: ResolvedSurfaceManifest,
  viewId: string,
  navigate: (path: string) => void,
): (path: string) => void {
  return (path: string) => {
    if (!surfaceGrants(manifest, "navigate")) {
      throw new SurfaceRealmDeniedError(
        viewId,
        "navigate",
        `no "navigate" grant; blocked navigation to "${path}"`,
      );
    }
    navigate(path);
  };
}

// ── Root/body class + :root CSS-variable vector ──────────────────────────────

// The shell's own writers (`platform/init.ts`, `themes/apply-theme.ts`,
// `state/persistence.ts` accent/theme) are the only sanctioned mutators of
// root/body classes and `:root` variables. They run from a provider ABOVE
// `<App/>`, so their tokens land after the shell's per-view scope is created;
// the token allowlist below — not a mount-time snapshot — is what keeps them
// from being mistaken for a view injection and reset. A view that reaches
// `document.documentElement`/`document.body` directly writes a token that is
// neither shell-owned nor present when the view activated, so it is removed on
// teardown and cannot survive into the next view.

const SHELL_OWNED_ROOT_CLASSES: ReadonlySet<string> = new Set([
  "dark",
  "light",
]);

// Every `:root` CSS variable the shell writes. Sourced from the shell's own
// token maps so this cannot drift as the theme grows; the prefixes cover the
// dynamically-suffixed families (accent ramp, per-edge safe-area, content-pack).
const SHELL_OWNED_ROOT_VARS: ReadonlySet<string> = new Set([
  ...Object.values(THEME_CSS_VAR_MAP),
  ...Object.values(THEME_FONT_CSS_VARS),
  "--eliza-chat-clearance",
  "--eliza-chat-side-clearance",
]);
const SHELL_OWNED_ROOT_VAR_PREFIXES = [
  "--accent",
  "--primary",
  "--txt",
  "--ring",
  "--border-hover",
  "--safe-area-",
  "--keyboard-",
  "--pack-",
] as const;

function isShellOwnedRootClass(cls: string): boolean {
  return SHELL_OWNED_ROOT_CLASSES.has(cls);
}

function isShellOwnedBodyClass(cls: string): boolean {
  return cls === "native" || cls.startsWith("platform-");
}

function isShellOwnedRootVar(name: string): boolean {
  return (
    SHELL_OWNED_ROOT_VARS.has(name) ||
    SHELL_OWNED_ROOT_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function readRootVarNames(el: HTMLElement): string[] {
  const names: string[] = [];
  const { style } = el;
  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i);
    if (name.startsWith("--")) names.push(name);
  }
  return names;
}

/**
 * What a host-realm reset changed — returned so callers can log/inspect. The
 * `removed*` fields are rogue tokens the view ADDED and the reset stripped; the
 * `restored*` fields are shell-owned baseline tokens the view DELETED or
 * MUTATED and the reset re-asserted (a view leaks just as much by deleting or
 * rewriting `dark`/`native`/`--accent` as by injecting a rogue token).
 */
export interface HostRealmResetResult {
  rootClasses: string[];
  bodyClasses: string[];
  rootVars: string[];
  restoredRootClasses: string[];
  restoredBodyClasses: string[];
  restoredRootVars: string[];
}

// ── The per-view scope the shell publishes ───────────────────────────────────

/**
 * The host-realm boundary for one active in-process view, resolved from its
 * surface manifest. The shell constructs one when a view becomes active and
 * tears it down on navigation. It captures the class/var tokens present at
 * activation so shell state that legitimately changes while the view is open is
 * preserved, while anything the view injected globally is reset on teardown.
 * The reset is symmetric: it strips the rogue tokens a view ADDED and restores
 * the shell-owned baseline tokens a view DELETED, so neither direction of
 * mutation survives into the next view.
 */
export class SurfaceRealmScope {
  readonly storage: ScopedStorage;
  readonly navigate: (path: string) => void;
  private readonly memberViewIds: ReadonlySet<string>;
  private readonly rootClassBaseline: ReadonlySet<string>;
  private readonly bodyClassBaseline: ReadonlySet<string>;
  private readonly rootVarBaseline: ReadonlySet<string>;
  // Baseline presence/values of the SHELL-OWNED tokens, snapshotted at
  // activation. Restored on teardown if same-realm view code deletes or rewrites
  // them; without a privileged shell-write channel, exact reset is the only
  // deterministic boundary between the view and the host realm.
  private readonly shellRootClassBaseline: readonly string[];
  private readonly shellBodyClassBaseline: readonly string[];
  private readonly shellRootVarBaseline: ReadonlyMap<string, string>;

  constructor(
    readonly manifest: ResolvedSurfaceManifest,
    readonly viewId: string,
    backing: Storage,
    navigate: (path: string) => void,
    memberViewIds: readonly string[] = [viewId],
  ) {
    this.memberViewIds = new Set([viewId, ...memberViewIds]);
    this.storage = brokerSurfaceStorage(manifest, backing, viewId);
    this.navigate = brokerSurfaceNavigate(manifest, viewId, navigate);
    if (typeof document === "undefined") {
      this.rootClassBaseline = new Set();
      this.bodyClassBaseline = new Set();
      this.rootVarBaseline = new Set();
      this.shellRootClassBaseline = [];
      this.shellBodyClassBaseline = [];
      this.shellRootVarBaseline = new Map();
    } else {
      const root = document.documentElement;
      const rootClasses = [...root.classList];
      const bodyClasses = [...document.body.classList];
      const rootVars = readRootVarNames(root);
      this.rootClassBaseline = new Set(rootClasses);
      this.bodyClassBaseline = new Set(bodyClasses);
      this.rootVarBaseline = new Set(rootVars);
      this.shellRootClassBaseline = rootClasses.filter(isShellOwnedRootClass);
      this.shellBodyClassBaseline = bodyClasses.filter(isShellOwnedBodyClass);
      this.shellRootVarBaseline = new Map(
        rootVars
          .filter(isShellOwnedRootVar)
          .map((name) => [name, root.style.getPropertyValue(name)]),
      );
    }
  }

  /** Only the routed owner or explicit layout members may evaluate in this scope. */
  ownsView(viewId: string): boolean {
    return this.memberViewIds.has(viewId);
  }

  /**
   * Undo a view's global root/body-class + `:root`-var mutations on teardown so
   * nothing it did to the host realm leaks into the next view. Two directions:
   * (1) remove tokens the view ADDED beyond the shell's own set, and (2) restore
   * shell-owned baseline tokens the view DELETED or MUTATED. The reset restores
   * the activation baseline for shell-owned tokens exactly: otherwise a view can
   * remove `dark` and add allowlisted `light`, or rewrite `--accent`, and have the
   * mutation survive into the next surface.
   */
  resetHostRealm(): HostRealmResetResult {
    const result: HostRealmResetResult = {
      rootClasses: [],
      bodyClasses: [],
      rootVars: [],
      restoredRootClasses: [],
      restoredBodyClasses: [],
      restoredRootVars: [],
    };
    if (typeof document === "undefined") return result;
    const root = document.documentElement;
    const { body } = document;
    for (const cls of [...root.classList]) {
      if (this.rootClassBaseline.has(cls)) continue;
      root.classList.remove(cls);
      result.rootClasses.push(cls);
    }
    for (const cls of [...body.classList]) {
      if (this.bodyClassBaseline.has(cls)) continue;
      body.classList.remove(cls);
      result.bodyClasses.push(cls);
    }
    for (const name of readRootVarNames(root)) {
      if (this.rootVarBaseline.has(name)) continue;
      if (isShellOwnedRootVar(name)) continue;
      root.style.removeProperty(name);
      result.rootVars.push(name);
    }

    for (const cls of this.shellRootClassBaseline) {
      if (root.classList.contains(cls)) continue;
      root.classList.add(cls);
      result.restoredRootClasses.push(cls);
    }
    for (const cls of this.shellBodyClassBaseline) {
      if (body.classList.contains(cls)) continue;
      body.classList.add(cls);
      result.restoredBodyClasses.push(cls);
    }
    for (const [name, value] of this.shellRootVarBaseline) {
      if (root.style.getPropertyValue(name) === value) continue;
      root.style.setProperty(name, value);
      result.restoredRootVars.push(name);
    }
    return result;
  }
}

// The active scope is a process-wide singleton because the host realm is: only
// one view owns the foreground at a time. The shell publishes it here so the
// active view (and the isolation tests) reach exactly the brokered handles the
// shell resolved for the current manifest, never the raw globals.
let activeScope: SurfaceRealmScope | null = null;
const activeScopeListeners = new Set<() => void>();

/** Observe committed scope replacement so evaluated views renew their handles. */
export function subscribeActiveSurfaceRealmScope(
  listener: () => void,
): () => void {
  activeScopeListeners.add(listener);
  return () => {
    activeScopeListeners.delete(listener);
  };
}

/** Publish the scope for the active view. Pass `null` on teardown. */
export function setActiveSurfaceRealmScope(
  scope: SurfaceRealmScope | null,
): void {
  if (activeScope === scope) return;
  activeScope = scope;
  // Guards install lazily on the first publish (not at module load) so server
  // consumers of the ui barrel never touch window, and so the guards wrap
  // whatever `window.localStorage` the environment (or a test stub) provides.
  if (scope !== null) ensureHostRealmGuards();
  for (const listener of activeScopeListeners) listener();
}

/** The scope for the active view, or `null` when no view is mounted. */
export function getActiveSurfaceRealmScope(): SurfaceRealmScope | null {
  return activeScope;
}

// ── Raw-global guards ────────────────────────────────────────────────────────

// The shell-privileged channel (`shellLocalStorage`/`shellHistory`/
// `runAsPrivilegedShell` + the depth flag the guards read) lives in the
// dependency-free `surface-realm-channel` leaf so the ~30 shell writers that
// migrated to it don't each pull this heavy module (core/shared/logger). The
// guards below consume the channel's `isPrivilegedShellActive`; this module
// re-exports the channel for back-compat (App.tsx, the bridge barrel).

// Marker so a re-publish can tell "window.localStorage is already my proxy"
// from "a test (or the platform) swapped in a fresh backing that needs
// wrapping". The get trap answers the symbol with the raw backing.
const STORAGE_GUARD_TARGET = Symbol("surface-realm-storage-guard-target");

function assertRawStorageWriteAllowed(op: string, key: string): void {
  if (isPrivilegedShellActive()) return;
  const scope = activeScope;
  if (scope === null) return;
  if (!isShellReservedStorageKey(key)) return;
  // Reserved keys are denied regardless of the `storage` grant — facade parity:
  // even a granted view may never overwrite the owner's persisted shell state.
  throw new SurfaceRealmDeniedError(
    scope.viewId,
    "storage",
    `raw localStorage ${op} on reserved shell key "${key}" — views use the ` +
      `surface storage facade (scope.storage); shell code uses shellLocalStorage`,
  );
}

function guardedLocalStorage(backing: Storage): Storage {
  const guardedClear = (): void => {
    const scope = activeScope;
    if (isPrivilegedShellActive() || scope === null) {
      backing.clear();
      return;
    }
    // Facade parity with hostScopedStorage.clear(): a view-path clear may wipe
    // exactly its own REACH. A `storage`-granted view reaches every
    // non-reserved key; an ungranted view reaches only its own
    // `surface:view:<id>:` namespace — never the shell's reserved keys and
    // never another view's namespace.
    const granted = surfaceGrants(scope.manifest, "storage");
    const ownPrefix = surfaceViewStoragePrefix(scope.viewId);
    const removable: string[] = [];
    for (let i = 0; i < backing.length; i += 1) {
      const key = backing.key(i);
      if (key === null) continue;
      if (granted ? !isShellReservedStorageKey(key) : key.startsWith(ownPrefix))
        removable.push(key);
    }
    for (const key of removable) backing.removeItem(key);
  };
  const guardedSetItem = (key: string, value: string): void => {
    assertRawStorageWriteAllowed("setItem", String(key));
    backing.setItem(String(key), String(value));
  };
  const guardedRemoveItem = (key: string): void => {
    assertRawStorageWriteAllowed("removeItem", String(key));
    backing.removeItem(String(key));
  };
  return new Proxy(backing, {
    get(target, prop) {
      if (prop === STORAGE_GUARD_TARGET) return target;
      if (prop === "setItem") return guardedSetItem;
      if (prop === "removeItem") return guardedRemoveItem;
      if (prop === "clear") return guardedClear;
      // Receiver must be the target: Storage methods brand-check `this`, and a
      // proxy receiver fails the internal-slot check.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    // Indexed assignment (`localStorage["eliza:x"] = …`) and `delete` reach
    // storage through the legacy named-property setter, not setItem — guard
    // them too or the method guard is trivially side-stepped by accident.
    set(target, prop, value) {
      if (typeof prop === "string") {
        assertRawStorageWriteAllowed("write", prop);
      }
      return Reflect.set(target, prop, value, target);
    },
    deleteProperty(target, prop) {
      if (typeof prop === "string") {
        assertRawStorageWriteAllowed("delete", prop);
      }
      return Reflect.deleteProperty(target, prop);
    },
  });
}

function assertRawHistoryMutationAllowed(
  op: "pushState" | "replaceState",
  url: string | URL | null | undefined,
): void {
  if (isPrivilegedShellActive()) return;
  const scope = activeScope;
  if (scope === null) return;
  // State-only mutation (no URL) cannot move the shell route.
  if (url === undefined || url === null || url === "") return;
  if (surfaceGrants(scope.manifest, "navigate")) return;
  let next: URL;
  try {
    next = new URL(String(url), window.location.href);
  } catch {
    // error-policy:J3 an unparsable URL is not a route escape; fall through so
    // the native implementation raises its own SyntaxError to the caller.
    return;
  }
  const current = window.location;
  // Hash-only mutation stays within the view's own page. The QUERY STRING is
  // shell routing state (`?runtime=first-run`, `?enableRuntimeChooser`,
  // assistant-launch payloads are consumed by shell boot paths), so it is
  // protected by the `navigate` grant exactly like the pathname.
  if (
    next.origin === current.origin &&
    next.pathname === current.pathname &&
    next.search === current.search
  ) {
    return;
  }
  throw new SurfaceRealmDeniedError(
    scope.viewId,
    "navigate",
    `raw history.${op} to "${next.pathname}" without the "navigate" grant — ` +
      `views use scope.navigate; shell code uses shellHistory`,
  );
}

let historyGuardInstalled = false;

function installHistoryGuard(): void {
  if (historyGuardInstalled || typeof History === "undefined") return;
  // Patch the prototype, not the instance: an own-property wrapper is
  // side-stepped by `History.prototype.pushState.call(history, …)`, the
  // prototype patch is not (an iframe's pristine prototype is a different
  // realm — see the header's honest-bound paragraph).
  const rawPushState = History.prototype.pushState;
  const rawReplaceState = History.prototype.replaceState;
  History.prototype.pushState = function pushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    assertRawHistoryMutationAllowed("pushState", url);
    rawPushState.call(this, data, unused, url);
  };
  History.prototype.replaceState = function replaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    assertRawHistoryMutationAllowed("replaceState", url);
    rawReplaceState.call(this, data, unused, url);
  };
  historyGuardInstalled = true;
}

/**
 * Install (or re-arm after a test swapped the backing) the raw-global guards.
 * Idempotent and cheap; called on every scope publish. The guards themselves
 * are policy-free pass-throughs while no scope is active, so installation
 * order relative to boot code does not change boot behavior.
 */
export function ensureHostRealmGuards(): void {
  if (typeof window === "undefined") return;
  installHistoryGuard();
  try {
    const current = window.localStorage as Storage & {
      [STORAGE_GUARD_TARGET]?: Storage;
    };
    if (current?.[STORAGE_GUARD_TARGET] !== undefined) return;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: guardedLocalStorage(current),
    });
  } catch (error) {
    // error-policy:J4 designed degrade — in storage-hostile environments
    // (privacy modes that throw on access, non-configurable stubs) the raw
    // guard cannot install; the facade and DOM-scope reset still enforce, so
    // surface the loss of the defense-in-depth layer and continue.
    logger.warn(
      { error },
      "[SurfaceRealmBroker] raw localStorage guard unavailable; facade enforcement only",
    );
  }
}
