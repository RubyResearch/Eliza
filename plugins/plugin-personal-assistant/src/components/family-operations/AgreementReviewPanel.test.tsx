// @vitest-environment jsdom
/** Exercises owner review loading, uncertain writes, retry, and artifact switching through the real React panel with a controlled transport. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgreementReview } from "../../lifeops/household/agreement-knowledge.js";
import { AgreementReviewPanel } from "./AgreementReviewPanel.js";

afterEach(cleanup);
const emptyReview: PreparedAgreementReview = {
  artifactId: "source-1",
  generatedAt: "2026-09-13T00:00:00Z",
  outcome: "no_proposals",
  explanation: "This synthetic source needs manual owner review.",
  obligations: [],
};

describe("owner agreement review preparation", () => {
  it("shows failed reads as unavailable and recovers a saved empty review without regenerating it", async () => {
    const adapter = {
      readAgreementReview: vi
        .fn()
        .mockRejectedValueOnce(new Error("Storage unavailable"))
        .mockResolvedValue(emptyReview),
      prepareAgreementReview: vi.fn(),
    };
    render(
      <AgreementReviewPanel
        artifactId="source-1"
        adapter={adapter}
        onPrepared={async () => {}}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Storage unavailable",
    );
    expect(screen.queryByRole("button", { name: "Prepare review" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading review" }),
    );
    await screen.findByText(emptyReview.explanation);
    expect(adapter.prepareAgreementReview).not.toHaveBeenCalled();
  });

  it("retries an uncertain response and refreshes owner data before presenting success", async () => {
    const adapter = {
      readAgreementReview: vi.fn().mockResolvedValue(null),
      prepareAgreementReview: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Connection interrupted; retry to recover saved review"),
        )
        .mockResolvedValue(emptyReview),
    };
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Saved obligations could not refresh"))
      .mockResolvedValue(undefined);
    render(
      <AgreementReviewPanel
        artifactId="source-1"
        adapter={adapter}
        onPrepared={refresh}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare review" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Connection interrupted",
    );
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare review" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Saved obligations could not refresh",
      ),
    );
    expect(screen.queryByText(emptyReview.explanation)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare review" }));
    await screen.findByText(emptyReview.explanation);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a preparation that finishes after the owner switches agreements", async () => {
    let finish!: (value: PreparedAgreementReview) => void;
    const adapter = {
      readAgreementReview: vi.fn().mockResolvedValue(null),
      prepareAgreementReview: vi.fn(
        () =>
          new Promise<PreparedAgreementReview>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const refresh = vi.fn(async () => {});
    const view = render(
      <AgreementReviewPanel
        artifactId="source-1"
        adapter={adapter}
        onPrepared={refresh}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare review" }),
    );
    view.rerender(
      <AgreementReviewPanel
        artifactId="source-2"
        adapter={adapter}
        onPrepared={refresh}
      />,
    );
    await screen.findByRole("button", { name: "Prepare review" });
    finish(emptyReview);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Prepare review" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByText(emptyReview.explanation)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
