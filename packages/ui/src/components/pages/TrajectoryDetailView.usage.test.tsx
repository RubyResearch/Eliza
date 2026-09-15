/** Verifies rendered totals for the detail endpoint's missing-rollup shape. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrajectoryDetailView } from "./TrajectoryDetailView";

const api = vi.hoisted(() => ({ getTrajectoryDetail: vi.fn(), copy: vi.fn() }));
vi.mock("../../api/client", () => ({ client: api }));
vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
      copyToClipboard: api.copy,
    }),
}));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const recordedUsage = [
  [38396, 425],
  [6298, 58],
  [2502, 80],
  [29501, 71],
  [11489, 200],
  [13394, 114],
];

function detail(unknownUsage = false) {
  return {
    trajectory: {
      id: "recorded-correction",
      status: "completed",
      llmCallCount: 6,
      providerAccessCount: 61,
      durationMs: 7468,
      createdAt: "2026-09-08T23:47:08.696Z",
    },
    llmCalls: recordedUsage.map(([promptTokens, completionTokens], index) => ({
      id: `call-${index}`,
      model: "fixture-model",
      purpose: "external_llm",
      timestamp: 1788911221228 + index,
      latencyMs: 100,
      maxTokens: 0,
      temperature: 0,
      promptTokens,
      completionTokens:
        unknownUsage && index === 0 ? undefined : completionTokens,
      userPrompt: "Recorded fixture input",
      response: "Recorded fixture output",
    })),
    providerAccesses: [],
  };
}

describe("TrajectoryDetailView recorded usage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("distinguishes missing provider text, captured text, empty results and raw metadata", async () => {
    const text = `Actual provider output\n${"context ".repeat(10000)}EXACT_END`;
    const legacy = {
      id: "legacy",
      providerName: "recent-conversations",
      purpose: "compose_state",
      query: { message: "hi\n[Language instruction]" },
      durationMs: 58,
      data: { textLength: 1782, outcome: "success", cacheHit: false },
    };
    const captured = {
      ...legacy,
      id: "captured",
      data: {
        text,
        textLength: text.length,
        outcome: "success",
        cacheHit: true,
      },
    };
    const empty = {
      ...legacy,
      id: "empty",
      data: { text: "", textLength: 0, outcome: "success" },
    };
    api.getTrajectoryDetail.mockResolvedValue({
      ...detail(),
      providerAccesses: [
        legacy,
        captured,
        empty,
        {
          ...legacy,
          id: "failed",
          data: { outcome: "error", errorCode: "PROVIDER_COMPOSITION_FAILED" },
        },
      ],
    });
    render(
      <TrajectoryDetailView
        trajectoryId="recorded-correction"
        collapsibleCalls
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Context & timeline" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Context & timeline" }));
    expect(
      screen.getByText(/Provider result text was not recorded/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Provider cache: result was not reused/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Full provider record" }),
    ).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Request" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.getByRole("region", { name: "Provider request" }).textContent,
    ).toBe(legacy.query.message);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Provider request" }),
    );
    expect(api.copy).toHaveBeenLastCalledWith(legacy.query.message);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Result" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: /Context provider/ }),
      { target: { value: "captured" } },
    );
    expect(
      screen.getByRole("region", { name: "Provider result text" }).textContent,
    ).toBe(text);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Provider result text" }),
    );
    expect(api.copy).toHaveBeenLastCalledWith(text);
    expect(screen.getByText(/Provider cache: reused result/)).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Raw data" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      JSON.parse(
        screen.getByRole("region", { name: "Full provider record" })
          .textContent ?? "",
      ),
    ).toEqual(captured);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Result" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: /Context provider/ }),
      { target: { value: "empty" } },
    );
    expect(screen.getByText("Provider returned no text.")).toBeTruthy();
    expect(
      screen.queryByText(/Provider result text was not recorded/),
    ).toBeNull();
  });

  it("renders 102.5k instead of zero when the detail response omits rollups", async () => {
    api.getTrajectoryDetail.mockResolvedValue(detail());
    render(<TrajectoryDetailView trajectoryId="recorded-correction" />);
    await waitFor(() => {
      expect(
        screen
          .getByText("Tokens", { selector: "dt" })
          .parentElement?.querySelector("dd")?.textContent,
      ).toBe("102.5k");
    });
    expect(
      screen
        .getByText("Model calls", { selector: "dt" })
        .parentElement?.querySelector("dd")?.textContent,
    ).toBe("6");
    expect(
      screen
        .getByText("Provider reads", { selector: "dt" })
        .parentElement?.querySelector("dd")?.textContent,
    ).toBe("61");
  });

  it("preserves complete model text and selected calls while a live run refreshes, and cancels closed reads", async () => {
    const original = detail();
    const input =
      Array.from(
        { length: 32 },
        (_, index) => `${index}: ${"context ".repeat(500)}`,
      ).join("\n") + "\nFINAL_INPUT_SENTINEL";
    original.llmCalls[0].userPrompt = input;
    api.getTrajectoryDetail.mockResolvedValue(original);
    const view = render(
      <TrajectoryDetailView
        trajectoryId="recorded-correction"
        revision="one"
        collapsibleCalls
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Model call")).toBeTruthy(),
    );
    expect(screen.getByRole("region", { name: "Input" }).textContent).toBe(
      input,
    );
    api.getTrajectoryDetail.mockResolvedValue({
      ...original,
      llmCalls: [
        ...original.llmCalls,
        {
          ...original.llmCalls[0],
          id: "late-evaluation",
          purpose: "evaluation",
          userPrompt: "Later evaluation input",
        },
      ],
    });
    view.rerender(
      <TrajectoryDetailView
        trajectoryId="recorded-correction"
        revision="two"
        collapsibleCalls
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(7));
    expect(
      (screen.getByLabelText("Model call") as HTMLSelectElement).value,
    ).toBe(original.llmCalls[0].id);
    expect(screen.getByRole("region", { name: "Input" }).textContent).toBe(
      input,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Input" }));
    expect(api.copy).toHaveBeenLastCalledWith(input);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Output" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("region", { name: "Output" }).textContent).toBe(
      "Recorded fixture output",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
    expect(api.copy).toHaveBeenLastCalledWith("Recorded fixture output");
    const signal = api.getTrajectoryDetail.mock.calls.at(-1)?.[1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("renders unknown total usage as a dash rather than a partial sum", async () => {
    api.getTrajectoryDetail.mockResolvedValue(detail(true));
    render(<TrajectoryDetailView trajectoryId="recorded-correction" />);
    await waitFor(() => {
      expect(
        screen
          .getByText("Tokens", { selector: "dt" })
          .parentElement?.querySelector("dd")?.textContent,
      ).toBe("—");
    });
  });
});
