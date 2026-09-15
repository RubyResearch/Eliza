/**
 * Structured error base for the fast-fail error policy (#12263 / parent #12182).
 *
 * `ElizaError` is the one shared error type new and rewritten throw sites use so
 * failures carry a machine-classifiable `code`, structured `context`, and a
 * preserved `cause` chain instead of a bare string. It is additive: existing
 * ad-hoc error classes (`CapabilityError`, `SecretsError`, …) are not
 * force-migrated and may extend it opportunistically. The runtime is throw-based
 * end to end — this is a plain `Error` subclass, not a `Result<T,E>` wrapper.
 */

/**
 * Severity hint for an {@link ElizaError}. `ephemeral` failures are expected to
 * be transient/recoverable (retry, reconfigure); `fatal` failures indicate a
 * broken invariant the current operation cannot proceed past.
 */
export type ElizaErrorSeverity = "ephemeral" | "fatal";

/** Options accepted by the {@link ElizaError} constructor. */
export interface ElizaErrorOptions {
	/** Earliest retry time in epoch milliseconds; schedulers may wait longer. */
	retryAt?: number;
	/**
	 * Stable, grep-able classification key (e.g. `DB_QUERY_FAILED`). Drives the
	 * per-code counter and escalation threshold in `runtime.reportError`.
	 */
	code: string;
	/** Underlying error being wrapped; preserved on `.cause` (context-adding rethrow). */
	cause?: unknown;
	/** Structured, serializable context for logs and the error event payload. */
	context?: Record<string, unknown>;
	/** Transient-vs-fatal hint. */
	severity?: ElizaErrorSeverity;
}

/**
 * Structured error with a classification `code`, optional `context`, an
 * optional `severity`, and a preserved `cause` chain.
 */
export class ElizaError extends Error {
	override readonly name: string = "ElizaError";
	readonly code: string;
	readonly retryAt?: number;
	readonly context?: Record<string, unknown>;
	readonly severity?: ElizaErrorSeverity;

	constructor(message: string, options: ElizaErrorOptions) {
		// Pass cause through to the native Error so `.cause` and the V8 cause
		// chain in stack traces are preserved.
		super(
			message,
			options.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.code = options.code;
		this.retryAt = options.retryAt;
		this.context = options.context;
		this.severity = options.severity;
		// Restore the prototype chain for reliable `instanceof` across the
		// transpiled ES target boundary.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * A single entry in the runtime's in-memory reported-error ring, produced by
 * `runtime.reportError` and read by the RECENT_ERRORS provider and the
 * escalation threshold.
 */
export interface ReportedError {
	/** Reporting subsystem — the `[scope]` log prefix. */
	scope: string;
	/** Machine-classifiable key (from `ElizaError.code`, else `UNCLASSIFIED`). */
	code: string;
	/** Human-readable failure message. */
	message: string;
	/** Serializable diagnostic context, when supplied. */
	context?: Record<string, unknown>;
	/** Epoch-ms timestamp the error was reported. */
	at: number;
}

/** Narrowing helper: true when `value` is an {@link ElizaError}. */
export function isElizaError(value: unknown): value is ElizaError {
	return value instanceof ElizaError;
}

/**
 * Normalize any thrown value into an {@link ElizaError}. An existing
 * `ElizaError` passes through unchanged; anything else is wrapped with the
 * supplied `fallbackCode` (default `UNCLASSIFIED`) and the original preserved on
 * `.cause`. Never throws — it is used on diagnostic paths that must not fail.
 */
export function toElizaError(
	value: unknown,
	fallbackCode = "UNCLASSIFIED",
): ElizaError {
	if (value instanceof ElizaError) return value;
	if (value instanceof Error) {
		return new ElizaError(value.message, { code: fallbackCode, cause: value });
	}
	return new ElizaError(typeof value === "string" ? value : String(value), {
		code: fallbackCode,
		cause: value,
	});
}
