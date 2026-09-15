/**
 * Action-scoped routing context.
 *
 * The runtime wraps every action handler invocation in
 * {@link runWithActionRoutingContext}, exposing the executing action's
 * `modelClass` (if any) to any `useModel` call made transitively. The
 * `useModel` resolver reads {@link getActionRoutingContext} to decide whether
 * to reroute via the strategy registry in {@link ./action-model-routing}.
 *
 * Node.js: AsyncLocalStorage for async-safe propagation across `await`s
 * inside action handlers.
 * Browser / non-Node: stack-based fallback (sync-only).
 *
 * Why a separate context (rather than threading an extra `useModel` param):
 *   - `useModel` callers inside action handlers are deep call chains — every
 *     helper would have to take an extra param. The async-context pattern
 *     keeps the call sites unchanged and back-compat clean.
 *   - The trajectory recorder already uses the same pattern; this matches.
 */

import { getAmbientSingleton, setAmbientSingleton } from "../ambient-context";
import type { ActionModelClass } from "../types/components";
import { StackContextManager } from "../utils/stack-context-manager";

export interface ActionRoutingContext {
	/** Name of the action currently executing. Surfaced for telemetry. */
	readonly actionName: string;
	/** The action's `modelClass` hint, if set. */
	readonly modelClass: ActionModelClass | undefined;
	/** Trusted caller owns final synthesis; never inferred from tool arguments. */
	readonly replyOwner?: "planner";
	readonly messageId?: string;
}

interface IActionRoutingContextManager {
	run<T>(
		ctx: ActionRoutingContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): ActionRoutingContext | undefined;
}

const MANAGER_KEY = Symbol.for("elizaos.actionRoutingContextManager");

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function initManagerSync(): IActionRoutingContextManager {
	if (isNodeEnvironment() && typeof process.getBuiltinModule === "function") {
		try {
			const { AsyncLocalStorage } = process.getBuiltinModule(
				"node:async_hooks",
			) as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<ActionRoutingContext | undefined>();
			return {
				run<T>(
					ctx: ActionRoutingContext | undefined,
					fn: () => T | Promise<T>,
				): T | Promise<T> {
					return storage.run(ctx, fn);
				},
				active(): ActionRoutingContext | undefined {
					return storage.getStore();
				},
			};
		} catch {
			// error-policy:J4 AsyncLocalStorage is an optional Node optimization;
			// other runtimes use the explicit stack manager below.
		}
	}
	return new StackContextManager<ActionRoutingContext | undefined>();
}

function getOrCreate(): IActionRoutingContextManager {
	// Shared global slot is the single source of truth (no module-local cache),
	// matching the trajectory context manager — see ambient-context.ts.
	return getAmbientSingleton(MANAGER_KEY, initManagerSync);
}

export function runWithActionRoutingContext<T>(
	ctx: ActionRoutingContext | undefined,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreate().run(ctx, fn);
}

export function getActionRoutingContext(): ActionRoutingContext | undefined {
	return getOrCreate().active();
}

/**
 * Run `fn` with the action routing context temporarily cleared. Used by the
 * runtime's `useModel` to invoke a routed sub-call without re-entering the
 * routing seam (which would otherwise loop on the same chain).
 */
export function runWithoutActionRoutingContext<T>(
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreate().run(undefined, fn);
}

/**
 * Test-only helper to inject a context manager (e.g. a deterministic stack
 * implementation). Not used in production.
 */
export function setActionRoutingContextManager(
	manager: IActionRoutingContextManager,
): void {
	setAmbientSingleton(MANAGER_KEY, manager);
}
