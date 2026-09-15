// @vitest-environment jsdom
/** Exercises owner correction validation, failed writes, and confirmed-write recovery through the real editor with a controlled transport. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgreementProposalEditor } from "./AgreementProposalEditor.js";
import type { FamilyOperationsAdapter } from "./types.js";

afterEach(cleanup);
const proposal = {
  title: "School notices",
  obligationText: "Share school notices within 24 hours.",
  citationText: "Share school notices within 24 hours.",
  pageStart: 1,
  pageEnd: 1,
};
const receipt: Awaited<
  ReturnType<FamilyOperationsAdapter["addAgreementProposal"]>
> = {
  created: true,
  obligation: {
    ...proposal,
    id: "owner-proposal",
    artifactId: "source",
    agentId: "agent",
    status: "proposed",
    proposedByEntityId: "self",
    decidedByEntityId: null,
    decisionReason: null,
    decidedAt: null,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z",
  },
};
function enter() {
  fireEvent.click(
    screen.getByRole("button", { name: "Add missing requirement" }),
  );
  fireEvent.change(screen.getByLabelText("Requirement title"), {
    target: { value: proposal.title },
  });
  fireEvent.change(screen.getByLabelText("Requirement", { exact: true }), {
    target: { value: proposal.obligationText },
  });
  fireEvent.change(screen.getByLabelText("Exact source quote"), {
    target: { value: proposal.citationText },
  });
  fireEvent.change(screen.getByLabelText("First page"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText("Last page"), {
    target: { value: "1" },
  });
}

it("preserves a rejected draft for correction, refuses invalid pages, and refreshes the saved proposal", async () => {
  const add = vi
    .fn()
    .mockRejectedValueOnce(new Error("Quote does not match the source"))
    .mockResolvedValue(receipt);
  const refreshed = vi.fn(async () => {});
  render(
    <AgreementProposalEditor
      artifactId="source"
      pageCount={2}
      adapter={{ addAgreementProposal: add }}
      onSaved={refreshed}
    />,
  );
  enter();
  fireEvent.change(screen.getByLabelText("Last page"), {
    target: { value: "3" },
  });
  expect(
    (screen.getByRole("button", { name: "Save proposal" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Last page"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Quote does not match",
  );
  expect(
    (screen.getByLabelText("Exact source quote") as HTMLTextAreaElement).value,
  ).toBe(proposal.citationText);
  expect(refreshed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));
  await screen.findByRole("button", { name: "Add missing requirement" });
  expect(add).toHaveBeenLastCalledWith("source", proposal);
  expect(refreshed).toHaveBeenCalledOnce();
});

it("blocks duplicate pending writes and retries only refresh after a confirmed save", async () => {
  let finish!: (value: typeof receipt) => void;
  const add = vi.fn(
    () =>
      new Promise<typeof receipt>((resolve) => {
        finish = resolve;
      }),
  );
  const refreshed = vi
    .fn()
    .mockRejectedValueOnce(new Error("Readback unavailable"))
    .mockResolvedValue(undefined);
  render(
    <AgreementProposalEditor
      artifactId="source"
      pageCount={2}
      adapter={{ addAgreementProposal: add }}
      onSaved={refreshed}
    />,
  );
  enter();
  const save = screen.getByRole("button", { name: "Save proposal" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(add).toHaveBeenCalledOnce();
  finish(receipt);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Proposal saved, but the review could not refresh",
  );
  expect(
    (screen.getByLabelText("Requirement title") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh saved proposal" }),
  );
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Add missing requirement" });
  expect(add).toHaveBeenCalledOnce();
});
