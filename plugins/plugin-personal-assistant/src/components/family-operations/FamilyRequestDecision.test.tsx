// @vitest-environment jsdom
/** Exercises real resolution form retry retention, mandatory reasons and explicit reopening with deterministic transport outcomes. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { FamilyIntakeReview } from "../../lifeops/family-coordination/intake-review.js";
import { FamilyRequestDecision } from "./FamilyRequestDecision.js";

afterEach(cleanup);
it("keeps the complete reason and operation identity after failure, then clears after success", async () => {
  const calls: NonNullable<FamilyIntakeReview["requestDecision"]>[] = [];
  render(
    <FamilyRequestDecision
      factId="fact"
      unanswered
      disabled={false}
      onDirtyChange={() => undefined}
      save={async (input) => {
        calls.push(input);
        return calls.length > 1;
      }}
    />,
  );
  const save = screen.getByRole("button", {
    name: "Mark resolved",
    hidden: true,
  });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Resolve request"));
  const reason = screen.getByLabelText("What resolved this request?");
  fireEvent.change(reason, {
    target: { value: "Pickup confirmed.\nKeep this second line." },
  });
  fireEvent.click(save);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect((reason as HTMLTextAreaElement).value).toContain(
    "Keep this second line.",
  );
  fireEvent.click(save);
  await waitFor(() => expect((reason as HTMLTextAreaElement).value).toBe(""));
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]?.state).toBe("resolved");
});
it("records an explicit reopening reason", async () => {
  const calls: NonNullable<FamilyIntakeReview["requestDecision"]>[] = [];
  render(
    <FamilyRequestDecision
      factId="fact"
      unanswered={false}
      disabled={false}
      onDirtyChange={() => undefined}
      save={async (input) => {
        calls.push(input);
        return true;
      }}
    />,
  );
  fireEvent.click(screen.getByText("Reopen request", { selector: "summary" }));
  fireEvent.change(
    screen.getByLabelText("Why does this need an answer again?"),
    { target: { value: "The pickup plan changed." } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Reopen request" }));
  await waitFor(() =>
    expect(calls[0]).toMatchObject({
      state: "open",
      reason: "The pickup plan changed.",
    }),
  );
});
