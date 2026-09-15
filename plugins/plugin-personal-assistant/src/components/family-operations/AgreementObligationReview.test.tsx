// @vitest-environment jsdom
/** Exercises per-clause decision state, duplicate-click protection and recovery with a controlled HTTP adapter and the real review component. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParentingAgreementObligation } from "../../lifeops/household/agreement-knowledge.js";
import { AgreementObligationReview } from "./AgreementObligationReview.js";

afterEach(cleanup);
const clause: ParentingAgreementObligation = {
  id: "travel",
  agentId: "synthetic-agent",
  artifactId: "synthetic-agreement",
  title: "Travel notice",
  obligationText: "Unanswered requests remain unresolved.",
  citationText: "Silence is not consent.",
  pageStart: 2,
  pageEnd: 2,
  status: "proposed",
  proposedByEntityId: "synthetic-agent",
  decidedByEntityId: null,
  decisionReason: null,
  decidedAt: null,
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};
const accepted: ParentingAgreementObligation = {
  ...clause,
  status: "approved",
  decidedByEntityId: "self",
  decisionReason: "Checked the source.",
  decidedAt: "2026-09-13T00:01:00Z",
};
function enterReason() {
  fireEvent.change(screen.getByLabelText("Decision reason"), {
    target: { value: "Checked the source." },
  });
}

describe("agreement clause decision", () => {
  it("sends one decision while pending and uses the confirmed receipt", async () => {
    let finish!: (value: ParentingAgreementObligation) => void;
    const decideObligation = vi.fn(
      () =>
        new Promise<ParentingAgreementObligation>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AgreementObligationReview
        obligation={clause}
        adapter={{ decideObligation }}
        onDecided={async () => {}}
      />,
    );
    enterReason();
    const approve = screen.getByRole("button", {
      name: "Approve",
      exact: true,
    });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(
      screen.getByRole("button", { name: "Reject", exact: true }),
    );
    expect(decideObligation).toHaveBeenCalledTimes(1);
    expect(
      screen.getByLabelText("Decision reason").hasAttribute("disabled"),
    ).toBe(true);
    finish(accepted);
    await screen.findByText("approved", { exact: true });
    expect(
      screen.queryByRole("button", { name: "Approve", exact: true }),
    ).toBeNull();
  });

  it("refreshes a confirmed decision after a readback failure without sending it again", async () => {
    const decideObligation = vi.fn(async () => accepted);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Readback unavailable"))
      .mockResolvedValue(undefined);
    render(
      <AgreementObligationReview
        obligation={clause}
        adapter={{ decideObligation }}
        onDecided={refresh}
      />,
    );
    enterReason();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve", exact: true }),
    );
    await screen.findByText("approved", { exact: true });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Decision saved",
    );
    expect(
      screen.queryByRole("button", { name: "Approve", exact: true }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh saved decision" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(decideObligation).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retains the draft reason when the write fails", async () => {
    const decideObligation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Decision unavailable"))
      .mockResolvedValue(accepted);
    render(
      <AgreementObligationReview
        obligation={clause}
        adapter={{ decideObligation }}
        onDecided={async () => {}}
      />,
    );
    enterReason();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve", exact: true }),
    );
    await screen.findByRole("alert");
    expect(
      (screen.getByLabelText("Decision reason") as HTMLInputElement).value,
    ).toBe("Checked the source.");
    fireEvent.click(
      screen.getByRole("button", { name: "Approve", exact: true }),
    );
    await screen.findByText("approved", { exact: true });
    expect(decideObligation).toHaveBeenLastCalledWith(
      clause,
      "approve",
      "Checked the source.",
    );
  });

  it("requires readback after a response for another clause and never claims that decision was saved", async () => {
    const decideObligation = vi.fn(async () => ({
      ...accepted,
      id: "another-clause",
    }));
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(undefined);
    render(
      <AgreementObligationReview
        obligation={clause}
        adapter={{ decideObligation }}
        onDecided={refresh}
      />,
    );
    enterReason();
    const approve = screen.getByRole("button", {
      name: "Approve",
      exact: true,
    });
    fireEvent.click(approve);
    await screen.findByRole("alert");
    expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Review could not refresh",
      ),
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Decision saved",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
    expect(decideObligation).toHaveBeenCalledTimes(1);
  });
});
