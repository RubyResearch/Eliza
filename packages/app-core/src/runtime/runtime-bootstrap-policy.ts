/**
 * Pure decision helpers for runtime bootstrap failures — no I/O, no runtime
 * dependency. Classifies a boot error as retryable or terminal: fatal PGlite
 * conditions (data-dir in use, corrupt data, manual-reset-required) stop retries
 * immediately, otherwise callers back off via `nextRuntimeBootRetryDelayMs`
 * (exponential, capped at 30s) and flip to the terminal error state once the
 * attempt-count or elapsed-duration threshold is crossed.
 */
const FATAL_PGLITE_CODES = new Set([
  "ELIZA_PGLITE_DATA_DIR_IN_USE",
  "ELIZA_PGLITE_CORRUPT_DATA",
  "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
]);

export const RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD = 3;
export const RUNTIME_BOOT_ERROR_DURATION_MS = 2 * 60_000;

export function nextRuntimeBootRetryDelayMs(attempt: number): number {
  const raw = 1000 * 2 ** Math.max(0, Math.min(attempt - 1, 5));
  return Math.min(30_000, raw);
}

function getRuntimeBootErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function resolveRuntimeBootstrapFailure(params: {
  attempt: number;
  err: unknown;
  firstFailureAt: number;
  now: number;
}): {
  delayMs?: number;
  lastError: string;
  nextRetryAt?: number;
  phase: "runtime-error" | "runtime-retry";
  shouldRetry: boolean;
  state: "error" | "starting";
} {
  const lastError = getRuntimeBootErrorMessage(params.err);
  // A blocked destructive migration cannot succeed on retry: the schema on
  // disk is older than the database. Retrying for five minutes hid the real
  // cause behind "Runtime bootstrap failed" (live 2026-09-12, ~12 min outage).
  if (/Destructive migration blocked/i.test(lastError)) {
    return {
      lastError,
      phase: "runtime-error",
      shouldRetry: false,
      state: "error",
    };
  }
  if (
    typeof params.err === "object" &&
    params.err !== null &&
    "code" in params.err &&
    FATAL_PGLITE_CODES.has(String((params.err as { code?: unknown }).code))
  ) {
    return {
      lastError,
      phase: "runtime-error",
      shouldRetry: false,
      state: "error",
    };
  }

  const delayMs = nextRuntimeBootRetryDelayMs(params.attempt);
  const shouldMarkError =
    params.attempt >= RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD ||
    params.now - params.firstFailureAt >= RUNTIME_BOOT_ERROR_DURATION_MS;

  return {
    delayMs,
    lastError,
    nextRetryAt: params.now + delayMs,
    phase: shouldMarkError ? "runtime-error" : "runtime-retry",
    shouldRetry: true,
    state: shouldMarkError ? "error" : "starting",
  };
}
