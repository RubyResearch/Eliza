/**
 * Unit coverage for the pure runtime-bootstrap failure policy: retry delay
 * schedule, fatal PGlite halt codes, attempt/duration error flip, and lastError
 * extraction. Drives the real module; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  nextRuntimeBootRetryDelayMs,
  RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD,
  RUNTIME_BOOT_ERROR_DURATION_MS,
  resolveRuntimeBootstrapFailure,
} from "./runtime-bootstrap-policy";

const NOW = 1_700_000_000_000;
const FATAL_PGLITE_CODES = [
  "ELIZA_PGLITE_DATA_DIR_IN_USE",
  "ELIZA_PGLITE_CORRUPT_DATA",
  "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
] as const;

function resolve(
  overrides: Partial<Parameters<typeof resolveRuntimeBootstrapFailure>[0]> = {},
) {
  return resolveRuntimeBootstrapFailure({
    attempt: 1,
    err: new Error("boot failed"),
    firstFailureAt: NOW,
    now: NOW + 1_000,
    ...overrides,
  });
}

describe("nextRuntimeBootRetryDelayMs", () => {
  it("starts at 1s for the first attempt and for non-positive attempts", () => {
    expect(nextRuntimeBootRetryDelayMs(1)).toBe(1_000);
    expect(nextRuntimeBootRetryDelayMs(0)).toBe(1_000);
    expect(nextRuntimeBootRetryDelayMs(-1)).toBe(1_000);
    expect(nextRuntimeBootRetryDelayMs(-100)).toBe(1_000);
  });

  it("doubles per subsequent attempt until the exponent clamp", () => {
    expect(nextRuntimeBootRetryDelayMs(2)).toBe(2_000);
    expect(nextRuntimeBootRetryDelayMs(3)).toBe(4_000);
    expect(nextRuntimeBootRetryDelayMs(4)).toBe(8_000);
    expect(nextRuntimeBootRetryDelayMs(5)).toBe(16_000);
  });

  it("caps delay at 30s once 2^(attempt-1) would overflow that bound", () => {
    // attempt 6 → raw 32s, then Math.min(30_000, 32_000)
    expect(nextRuntimeBootRetryDelayMs(6)).toBe(30_000);
    expect(nextRuntimeBootRetryDelayMs(7)).toBe(30_000);
    expect(nextRuntimeBootRetryDelayMs(100)).toBe(30_000);
    expect(nextRuntimeBootRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(30_000);
  });
});

describe("resolveRuntimeBootstrapFailure fatal PGlite codes", () => {
  it.each([...FATAL_PGLITE_CODES])(
    "halts immediately for Error.code %s without scheduling a retry",
    (code) => {
      const err = Object.assign(new Error("pglite halted"), { code });
      const result = resolve({ attempt: 1, err });

      expect(result).toEqual({
        lastError: "pglite halted",
        phase: "runtime-error",
        shouldRetry: false,
        state: "error",
      });
      expect(result).not.toHaveProperty("delayMs");
      expect(result).not.toHaveProperty("nextRetryAt");
    },
  );

  it.each([...FATAL_PGLITE_CODES])(
    "halts for a plain object carrying code %s",
    (code) => {
      const result = resolve({
        attempt: 1,
        err: { code, message: "plain fatal" },
      });
      expect(result.shouldRetry).toBe(false);
      expect(result.phase).toBe("runtime-error");
      expect(result.state).toBe("error");
      expect(result.lastError).toBe("plain fatal");
      expect(result.delayMs).toBeUndefined();
      expect(result.nextRetryAt).toBeUndefined();
    },
  );

  it("still halts when the fatal code is inherited on the prototype", () => {
    const proto = { code: "ELIZA_PGLITE_CORRUPT_DATA" };
    const err = Object.create(proto) as { code: string; message: string };
    err.message = "inherited code";
    const result = resolve({ err });
    expect(result.shouldRetry).toBe(false);
    expect(result.lastError).toBe("inherited code");
  });

  it("stringifies a non-string fatal code before matching the halt set", () => {
    const result = resolve({
      err: {
        code: {
          toString() {
            return "ELIZA_PGLITE_MANUAL_RESET_REQUIRED";
          },
        },
      },
    });
    expect(result.shouldRetry).toBe(false);
    expect(result.phase).toBe("runtime-error");
  });

  it("does not treat lookalike or case-mismatched codes as fatal", () => {
    for (const code of [
      "ELIZA_PGLITE_CORRUPT_DATA ",
      "eliza_pglite_corrupt_data",
      "ELIZA_PGLITE_UNKNOWN",
      "ELIZA_AUTO_RESET_PGLITE_ERROR_CODE",
      "",
    ]) {
      const result = resolve({
        attempt: 1,
        err: { code, message: "not fatal" },
      });
      expect(result.shouldRetry).toBe(true);
      expect(result.phase).toBe("runtime-retry");
      expect(result.state).toBe("starting");
    }
  });

  it("does not halt when the fatal code is only in a string or function", () => {
    const asString = resolve({
      err: "ELIZA_PGLITE_CORRUPT_DATA",
    });
    expect(asString.shouldRetry).toBe(true);
    expect(asString.lastError).toBe("ELIZA_PGLITE_CORRUPT_DATA");

    const fn = Object.assign(() => undefined, {
      code: "ELIZA_PGLITE_DATA_DIR_IN_USE",
      message: "function-coded",
    });
    const asFunction = resolve({ err: fn });
    expect(asFunction.shouldRetry).toBe(true);
  });
});

describe("resolveRuntimeBootstrapFailure retry vs error flip", () => {
  it("retries a generic Error below both thresholds in the starting/retry phase", () => {
    const result = resolve({
      attempt: 1,
      err: new Error("connection refused"),
      firstFailureAt: NOW,
      now: NOW + 1_000,
    });
    expect(result).toEqual({
      delayMs: 1_000,
      lastError: "connection refused",
      nextRetryAt: NOW + 1_000 + 1_000,
      phase: "runtime-retry",
      shouldRetry: true,
      state: "starting",
    });
  });

  it("keeps retrying on attempt 2 while elapsed duration is under the 2-minute cap", () => {
    const result = resolve({
      attempt: 2,
      firstFailureAt: NOW,
      now: NOW + RUNTIME_BOOT_ERROR_DURATION_MS - 1,
    });
    expect(result.shouldRetry).toBe(true);
    expect(result.phase).toBe("runtime-retry");
    expect(result.state).toBe("starting");
    expect(result.delayMs).toBe(2_000);
    expect(result.nextRetryAt).toBe(
      NOW + RUNTIME_BOOT_ERROR_DURATION_MS - 1 + 2_000,
    );
  });

  it("flips the UI to error at the attempt threshold but still schedules a retry", () => {
    const result = resolve({
      attempt: RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD,
      firstFailureAt: NOW,
      now: NOW + 1,
    });
    expect(result.shouldRetry).toBe(true);
    expect(result.phase).toBe("runtime-error");
    expect(result.state).toBe("error");
    expect(result.delayMs).toBe(4_000);
    expect(result.nextRetryAt).toBe(NOW + 1 + 4_000);
  });

  it("flips to error on attempts above the threshold", () => {
    const result = resolve({ attempt: 4, now: NOW, firstFailureAt: NOW });
    expect(result.shouldRetry).toBe(true);
    expect(result.phase).toBe("runtime-error");
    expect(result.state).toBe("error");
    expect(result.delayMs).toBe(8_000);
  });

  it("flips to error when elapsed duration hits the threshold even on attempt 1", () => {
    const result = resolve({
      attempt: 1,
      firstFailureAt: NOW,
      now: NOW + RUNTIME_BOOT_ERROR_DURATION_MS,
    });
    expect(result.shouldRetry).toBe(true);
    expect(result.phase).toBe("runtime-error");
    expect(result.state).toBe("error");
    expect(result.delayMs).toBe(1_000);
    expect(result.nextRetryAt).toBe(
      NOW + RUNTIME_BOOT_ERROR_DURATION_MS + 1_000,
    );
  });

  it("stays in retry when elapsed duration is one millisecond under the cap", () => {
    const result = resolve({
      attempt: 1,
      firstFailureAt: NOW,
      now: NOW + RUNTIME_BOOT_ERROR_DURATION_MS - 1,
    });
    expect(result.phase).toBe("runtime-retry");
    expect(result.state).toBe("starting");
    expect(result.shouldRetry).toBe(true);
  });

  it("uses the 30s capped delay for a long retry sequence that has already flipped to error", () => {
    const result = resolve({
      attempt: 8,
      firstFailureAt: NOW,
      now: NOW + 10_000,
    });
    expect(result.delayMs).toBe(30_000);
    expect(result.nextRetryAt).toBe(NOW + 10_000 + 30_000);
    expect(result.shouldRetry).toBe(true);
    expect(result.phase).toBe("runtime-error");
    expect(result.state).toBe("error");
  });

  it("fatal codes win over attempt/duration thresholds — no retry is scheduled", () => {
    const result = resolve({
      attempt: 10,
      firstFailureAt: NOW,
      now: NOW + RUNTIME_BOOT_ERROR_DURATION_MS * 2,
      err: {
        code: "ELIZA_PGLITE_DATA_DIR_IN_USE",
        message: "dir in use",
      },
    });
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBeUndefined();
    expect(result.nextRetryAt).toBeUndefined();
  });
});

describe("resolveRuntimeBootstrapFailure lastError extraction", () => {
  it("prefers Error.message, then a string, then a string message field", () => {
    expect(resolve({ err: new Error("from error") }).lastError).toBe(
      "from error",
    );
    expect(resolve({ err: "plain string" }).lastError).toBe("plain string");
    expect(resolve({ err: { message: "from object" } }).lastError).toBe(
      "from object",
    );
  });

  it("stringifies values that are not an Error, string, or { message: string }", () => {
    expect(resolve({ err: 42 }).lastError).toBe("42");
    expect(resolve({ err: null }).lastError).toBe("null");
    expect(resolve({ err: undefined }).lastError).toBe("undefined");
    expect(resolve({ err: { message: 99 } }).lastError).toBe("[object Object]");
    expect(resolve({ err: { code: "OTHER" } }).lastError).toBe(
      "[object Object]",
    );
    expect(resolve({ err: true }).lastError).toBe("true");
  });

  it("keeps an empty Error message instead of substituting a default", () => {
    expect(resolve({ err: new Error("") }).lastError).toBe("");
  });
});

describe("blocked destructive migrations", () => {
  it("halts immediately instead of retrying", () => {
    const result = resolve({
      err: new Error(
        "1 migration(s) failed: Destructive migration blocked for @elizaos/plugin-sql. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true to proceed.",
      ),
    });
    expect(result.shouldRetry).toBe(false);
    expect(result.phase).toBe("runtime-error");
    expect(result.state).toBe("error");
    expect(result.delayMs).toBeUndefined();
  });
});
