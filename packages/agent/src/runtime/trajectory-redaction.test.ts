/**
 * Covers trajectory PII redaction: redactTrajectoryText masks emails, API keys,
 * and ETH addresses (and passes non-strings through), normalizeLlmCallPayload
 * redacts sensitive payload fields while leaving benign ones intact, and
 * shouldEnableTrajectoryLoggingByDefault stays off in production unless
 * ELIZA_TRAJECTORY_LOGGING opts in. Deterministic pure-function checks.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeLlmCallPayload,
  redactTrajectoryText,
  shouldEnableTrajectoryLoggingByDefault,
} from "./trajectory-internals.ts";

describe("redactTrajectoryText", () => {
  it("strips emails, API keys, and ETH addresses", () => {
    const input =
      "contact me at user@example.com using key sk-abcdefghijklmnopqrstuv and wallet 0x" +
      "a".repeat(40);
    const out = redactTrajectoryText(input);
    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(out).not.toContain(`0x${"a".repeat(40)}`);
    expect(out).toContain("<EMAIL>");
    expect(out).toContain("<API_KEY>");
    expect(out).toContain("<ETH_ADDR>");
  });

  it("returns non-string values unchanged", () => {
    expect(redactTrajectoryText(42)).toBe(42);
    expect(redactTrajectoryText(null)).toBe(null);
  });
});

describe("normalizeLlmCallPayload redaction", () => {
  it("preserves parseable PDF coordinates while redacting card-shaped text", () => {
    const source = {
      nativePositionedText: [
        { x: 48, y: 740, width: 328.31999999999994, height: 16 },
        { x: -0.1234567890123456, y: 300.1234567890123, width: 612 },
      ],
      text: "Synthetic card: 4111111111111111. Contact user@example.com.",
    };
    const result = normalizeLlmCallPayload([
      {
        stepId: "pdf-source",
        model: "test-model",
        purpose: "agreement-review",
        actionType: "reply",
        userPrompt: JSON.stringify(source),
        response: "Review required.",
      },
    ]);
    if (!result || typeof result.params.userPrompt !== "string") {
      throw new Error("The recorder must retain the source prompt");
    }
    expect(JSON.parse(result.params.userPrompt)).toEqual({
      ...source,
      text: "Synthetic card: <CARD>. Contact <EMAIL>.",
    });
  });

  it("redacts known sensitive fields in the payload", () => {
    const result = normalizeLlmCallPayload([
      {
        stepId: "s-1",
        model: "test-model",
        purpose: "test-redaction",
        actionType: "reply",
        userPrompt: "send to user@example.com",
        response: "ok",
      },
    ]);
    expect(result).not.toBeNull();
    expect(result?.params.userPrompt).toBe("send to <EMAIL>");
    // Non-sensitive content untouched.
    expect(result?.params.response).toBe("ok");
  });
});

describe("normalizeLlmCallPayload tool-call-only response coercion", () => {
  // A tool-call-only completion (finishReason=tool-calls) has no assistant
  // text, so producers pass response=undefined; the recorder must coerce it to
  // "" instead of rejecting the whole capture (TRAJECTORY_CAPTURE_INVALID) and
  // dropping the llm evidence for tool-heavy turns.
  const base = {
    model: "test-model",
    purpose: "planner",
    actionType: "tool-call",
    userPrompt: "check the CI on your PRs",
  };

  it("coerces a missing response to '' (object payload shape)", () => {
    const result = normalizeLlmCallPayload([
      { stepId: "s-1", ...base, finishReason: "tool-calls" },
    ]);
    expect(result?.params.response).toBe("");
  });

  it("coerces a missing response to '' (stepId + details shape)", () => {
    const result = normalizeLlmCallPayload(["s-1", { ...base }]);
    expect(result?.params.response).toBe("");
  });

  it("still rejects a present-but-non-string response", () => {
    expect(() =>
      normalizeLlmCallPayload([{ stepId: "s-1", ...base, response: 42 }]),
    ).toThrow();
  });

  it("preserves a real response unchanged", () => {
    const result = normalizeLlmCallPayload([
      { stepId: "s-1", ...base, response: "on it." },
    ]);
    expect(result?.params.response).toBe("on it.");
  });
});

describe("shouldEnableTrajectoryLoggingByDefault", () => {
  it("returns false in NODE_ENV=production without explicit opt-in", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("returns true in NODE_ENV=production when ELIZA_TRAJECTORY_LOGGING=1", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
        ELIZA_TRAJECTORY_LOGGING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns false in NODE_ENV=test", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
