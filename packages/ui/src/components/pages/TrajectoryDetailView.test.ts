/**
 * Covers the sparse-trajectory rendering boundary of the trajectory detail
 * view: candidate fallback selection and line counting for recorded LLM calls
 * that omit or blank their prompt, message, and output fields. Deterministic
 * pure-function harness — no runtime, network, or DOM is involved.
 */

import { describe, expect, it } from "vitest";
import {
  countTrajectoryTextLines,
  normalizeTrajectoryCallText,
  trajectoryDetailTokenCount,
} from "./TrajectoryDetailView";

describe("trajectoryDetailTokenCount", () => {
  const calls = [
    { promptTokens: 38396, completionTokens: 425 },
    { promptTokens: 6298, completionTokens: 58 },
    { promptTokens: 2502, completionTokens: 80 },
    { promptTokens: 29501, completionTokens: 71 },
    { promptTokens: 11489, completionTokens: 200 },
    { promptTokens: 13394, completionTokens: 114 },
  ];

  it("recovers the live detail shape's missing rollups from all recorded calls", () => {
    expect(trajectoryDetailTokenCount({ llmCallCount: 6 }, calls)).toBe(102528);
  });

  it("preserves supplied aggregates including an explicit zero", () => {
    expect(
      trajectoryDetailTokenCount(
        { totalPromptTokens: 0, totalCompletionTokens: 0 },
        calls,
      ),
    ).toBe(0);
    expect(
      trajectoryDetailTokenCount(
        { totalPromptTokens: 101580, totalCompletionTokens: 948 },
        [],
      ),
    ).toBe(102528);
    expect(
      trajectoryDetailTokenCount(
        { totalPromptTokens: 101580, llmCallCount: 6 },
        calls,
      ),
    ).toBe(102528);
  });

  it("does not invent usage from incomplete or unknown recorded counts", () => {
    expect(trajectoryDetailTokenCount({}, calls)).toBeUndefined();
    expect(
      trajectoryDetailTokenCount({ llmCallCount: 6 }, calls.slice(0, 5)),
    ).toBeUndefined();
    expect(
      trajectoryDetailTokenCount({ llmCallCount: 1 }, [{ promptTokens: 10 }]),
    ).toBeUndefined();
    expect(
      trajectoryDetailTokenCount({ llmCallCount: 1 }, [
        { promptTokens: 10, completionTokens: Number.NaN },
      ]),
    ).toBeUndefined();
    expect(trajectoryDetailTokenCount({}, [])).toBeUndefined();
    expect(trajectoryDetailTokenCount({ llmCallCount: 0 }, [])).toBe(0);
  });
});

describe("normalizeTrajectoryCallText", () => {
  it("returns empty text when every candidate is absent", () => {
    expect(normalizeTrajectoryCallText()).toBe("");
    expect(normalizeTrajectoryCallText(undefined, null)).toBe("");
    expect(normalizeTrajectoryCallText(null, undefined, "")).toBe("");
  });

  it("falls through undefined and null primaries to a populated candidate", () => {
    expect(normalizeTrajectoryCallText(undefined, "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText(null, "fallback prompt")).toBe(
      "fallback prompt",
    );
  });

  it("falls through blank and whitespace-only primaries", () => {
    expect(normalizeTrajectoryCallText("", "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText("   \n\t ", "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(
      normalizeTrajectoryCallText("", undefined, [
        { role: "user", content: "message-only input" },
      ]),
    ).toContain('"content": "message-only input"');
  });

  it("treats an empty array as absent but preserves a populated one", () => {
    expect(normalizeTrajectoryCallText([], "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText([], [], undefined)).toBe("");
    expect(
      normalizeTrajectoryCallText(undefined, [
        { role: "user", content: "open notes" },
      ]),
    ).toContain('"content": "open notes"');
  });

  it("treats an empty recorded object as absent", () => {
    expect(normalizeTrajectoryCallText({}, "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText({}, {}, undefined)).toBe("");
    expect(normalizeTrajectoryCallText({}, { tool: "notes.open" })).toContain(
      '"tool": "notes.open"',
    );
  });

  it("keeps falsy scalars, which are real recorded values", () => {
    expect(normalizeTrajectoryCallText("", 0)).toBe("0");
    expect(normalizeTrajectoryCallText("   ", false)).toBe("false");
  });

  it("keeps the first populated candidate rather than a later one", () => {
    expect(normalizeTrajectoryCallText("primary", "fallback")).toBe("primary");
  });

  it("preserves structured fallback data as inspectable JSON", () => {
    expect(normalizeTrajectoryCallText({ tool: "notes.open" })).toBe(
      '{\n  "tool": "notes.open"\n}',
    );
  });

  it("renders a non-serializable payload instead of blanking the panel", () => {
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;
    expect(normalizeTrajectoryCallText(cyclic)).toBe("[object Object]");
  });
});

describe("countTrajectoryTextLines", () => {
  it("reports zero lines for absent normalized text", () => {
    expect(countTrajectoryTextLines("")).toBe(0);
    expect(
      countTrajectoryTextLines(normalizeTrajectoryCallText(undefined, null)),
    ).toBe(0);
  });

  it("counts real lines once text is present", () => {
    expect(countTrajectoryTextLines("one line")).toBe(1);
    expect(countTrajectoryTextLines("first\nsecond")).toBe(2);
    expect(countTrajectoryTextLines("trailing\n")).toBe(2);
  });
});
