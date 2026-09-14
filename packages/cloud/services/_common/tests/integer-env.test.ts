/**
 * Covers the shared gateway integer parser and the KEDA cooldown resolver
 * built on it. Deterministic; no environment or Redis involved.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  DEFAULT_KEDA_COOLDOWN_SECONDS,
  resolveKedaCooldownSeconds,
} from "../src/gateway-routing";
import {
  parseIntegerEnvValue,
  parsePositiveIntegerEnvValue,
} from "../src/integer-env";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("parseIntegerEnvValue", () => {
  test("returns undefined when unset", () => {
    expect(parseIntegerEnvValue("X", undefined)).toBeUndefined();
  });

  test("accepts clean, signed, and padded integers", () => {
    expect(parseIntegerEnvValue("X", "120")).toBe(120);
    expect(parseIntegerEnvValue("X", "+120")).toBe(120);
    expect(parseIntegerEnvValue("X", " 120 ")).toBe(120);
    expect(parseIntegerEnvValue("X", "-5")).toBe(-5);
  });

  test("rejects non-integer text with a fatal typed error naming the variable", () => {
    const thrown = capture(() => parseIntegerEnvValue("X", "3600junk"));
    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code: "INVALID_GATEWAY_INTEGER_ENV",
      context: { envKey: "X", configured: "3600junk" },
      severity: "fatal",
    });
  });
});

describe("parsePositiveIntegerEnvValue", () => {
  test("applies the default only when unset", () => {
    expect(parsePositiveIntegerEnvValue("X", undefined, 7)).toBe(7);
    expect(parsePositiveIntegerEnvValue("X", "3", 7)).toBe(3);
  });

  for (const configured of ["", "abc", "1.5", "NaN", "Infinity"]) {
    test(`rejects ${JSON.stringify(configured)} instead of defaulting`, () => {
      const thrown = capture(() =>
        parsePositiveIntegerEnvValue("X", configured, 7),
      );
      expect(thrown).toBeInstanceOf(ElizaError);
      expect(thrown).toMatchObject({
        code: "INVALID_GATEWAY_INTEGER_ENV",
        context: { envKey: "X", configured },
      });
    });
  }

  for (const configured of ["0", "-5"]) {
    test(`rejects ${configured} as non-positive with the parsed value in context`, () => {
      const thrown = capture(() =>
        parsePositiveIntegerEnvValue("X", configured, 7),
      );
      expect(thrown).toBeInstanceOf(ElizaError);
      expect(thrown).toMatchObject({
        code: "INVALID_GATEWAY_INTEGER_ENV",
        context: {
          envKey: "X",
          configured,
          parsed: Number(configured),
          minimum: 1,
        },
      });
      expect((thrown as ElizaError).message).toContain("positive integer");
    });
  }
});

describe("resolveKedaCooldownSeconds", () => {
  test("defaults to 900 when unset", () => {
    expect(resolveKedaCooldownSeconds(undefined)).toBe(
      DEFAULT_KEDA_COOLDOWN_SECONDS,
    );
    expect(DEFAULT_KEDA_COOLDOWN_SECONDS).toBe(900);
  });

  test('accepts "120"', () => {
    expect(resolveKedaCooldownSeconds("120")).toBe(120);
  });

  for (const configured of ["abc", "-5", ""]) {
    test(`names KEDA_COOLDOWN_SECONDS when rejecting ${JSON.stringify(configured)}`, () => {
      const thrown = capture(() => resolveKedaCooldownSeconds(configured));
      expect(thrown).toBeInstanceOf(ElizaError);
      expect(thrown).toMatchObject({
        code: "INVALID_GATEWAY_INTEGER_ENV",
        context: { envKey: "KEDA_COOLDOWN_SECONDS", configured },
        severity: "fatal",
      });
      expect((thrown as ElizaError).message).toContain(
        "Invalid KEDA_COOLDOWN_SECONDS environment variable",
      );
    });
  }
});
