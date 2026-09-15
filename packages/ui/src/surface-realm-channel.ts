/**
 * The shell-privileged raw-global channel for the surface-realm guards (#13452).
 * A deliberately dependency-free leaf: the raw-global guards in
 * `surface-realm-broker.ts` are a Proxy over `window.localStorage` + a
 * `History.prototype` patch installed for the whole realm, so EVERY shell writer
 * of a reserved key (`persistence`, chat drafts, resource-cache, first-run, …)
 * must route through this channel or it throws while a view is foreground. Those
 * writers are leaf modules; importing the broker (which pulls `@elizaos/core` /
 * `@elizaos/shared` / `@elizaos/logger`) into each of them makes them heavy and,
 * under `vi.resetModules()`, slow — so the channel lives here with no such deps
 * and the broker consumes IT, not the reverse.
 *
 * `runAsPrivilegedShell` is the shell's caller identity: one JS realm cannot tell
 * shell code from view code at a `localStorage.setItem` site, so shell code
 * declares itself by nesting its reserved-key writes / router navigation inside
 * this reentrant scope; the guard reads {@link isPrivilegedShellActive} and lets
 * those through. `shellLocalStorage` / `shellHistory` are same-signature stand-ins
 * for the raw calls they replace so migrating a shell write site is a one-token
 * edit. This is shell-internal — a view importing it disarms the accident-guard
 * on itself (the adversarial boundary is the sandboxed-iframe / native-webview
 * tier, not this flag; see the broker header).
 */

import { developerShellUrl } from "./navigation/developer-route";

// Reentrancy depth, not a boolean: privileged shell paths nest (e.g. the
// navigation reducer persisting the last tab while pushing a route).
let privilegedShellDepth = 0;

/** Whether the current call stack is inside a privileged shell scope. */
export function isPrivilegedShellActive(): boolean {
  return privilegedShellDepth > 0;
}

/**
 * Run `fn` with the raw-global guards disarmed for the current call stack. Shell
 * internals only. See the module header for the trust model.
 */
export function runAsPrivilegedShell<T>(fn: () => T): T {
  privilegedShellDepth += 1;
  try {
    return fn();
  } finally {
    privilegedShellDepth -= 1;
  }
}

/**
 * The shell's own localStorage writer. Reads are never guarded, so no `getItem`
 * is provided — read the global directly.
 */
export const shellLocalStorage = {
  setItem(key: string, value: string): void {
    runAsPrivilegedShell(() => window.localStorage.setItem(key, value));
  },
  removeItem(key: string): void {
    runAsPrivilegedShell(() => window.localStorage.removeItem(key));
  },
  clear(): void {
    runAsPrivilegedShell(() => window.localStorage.clear());
  },
};

/** The shell router/chrome's history writer (guard-exempt, DOM signatures). */
export const shellHistory = {
  pushState(data: unknown, unused: string, url?: string | URL | null): void {
    runAsPrivilegedShell(() =>
      window.history.pushState(data, unused, developerShellUrl(url)),
    );
  },
  replaceState(data: unknown, unused: string, url?: string | URL | null): void {
    runAsPrivilegedShell(() =>
      window.history.replaceState(data, unused, developerShellUrl(url)),
    );
  },
};
