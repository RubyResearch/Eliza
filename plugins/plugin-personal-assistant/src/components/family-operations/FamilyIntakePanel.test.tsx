// @vitest-environment jsdom
/** Exercises actual intake form state and retry/review interactions against deterministic transport fixtures; no live source or provider is accessed. */
import { randomUUID } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { FamilyIntakeReview } from "../../lifeops/family-coordination/intake-review.js";
import { FamilyIntakePanel } from "./FamilyIntakePanel.js";
import type { FamilyIntakeAdapter } from "./intake-adapter.js";

afterEach(cleanup);
it("retains failed import text and operation identity, then saves only explicitly reviewed recipients", async () => {
  const recipient = randomUUID();
  const saved: FamilyIntakeReview = {
    id: randomUUID(),
    periodKey: "2026-10",
    selectedByEntityId: randomUUID(),
    source: { documentId: randomUUID(), contentSha256: "a".repeat(64) },
    revision: 2,
    status: "proposed",
    reviewedByEntityId: null,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
    facts: [
      {
        id: randomUUID(),
        section: "unanswered",
        statement: "Confirm pickup.",
        sourceQuote: "Please confirm pickup at three.",
        dates: [],
        requests: ["Confirm pickup"],
        commitments: [],
        accountability: [],
        urgency: null,
        unanswered: true,
        recipientEntityIds: [],
      },
    ],
  };
  let rows: FamilyIntakeReview[] = [];
  const attempts: Array<{ id: string; text: string }> = [];
  let reviewed: FamilyIntakeReview | null = null;
  const adapter: FamilyIntakeAdapter = {
    async decideRequest() {
      throw new Error("Unexpected request decision in this fixture");
    },
    async answerInterview() {
      throw new Error("Interview writes are outside this fixture.");
    },
    async list() {
      return rows.map((review) => ({
        review,
        title: "Pickup email",
        sourceStatus: { state: "ready" as const },
        factsForReview: saved.facts.map(
          (fact) =>
            review.facts.find((current) => current.id === fact.id) ?? fact,
        ),
        requestHistory: [],
        excludedFactIds:
          review.status === "reviewed"
            ? saved.facts
                .filter(
                  (fact) =>
                    !review.facts.some((current) => current.id === fact.id),
                )
                .map((fact) => fact.id)
            : [],
      }));
    },
    async importSource(input) {
      attempts.push(input);
      if (attempts.length === 1) throw new Error("Connection interrupted");
      rows = [saved];
      return saved;
    },
    async change() {
      throw new Error("Unexpected operation");
    },
    async review(id, revision, facts) {
      expect(id).toBe(saved.id);
      expect(revision).toBe(rows[0].revision);
      reviewed = {
        ...saved,
        status: "reviewed",
        revision: revision + 1,
        facts: [...facts],
        reviewedByEntityId: saved.selectedByEntityId,
      };
      rows = [reviewed];
      return reviewed;
    },
  };
  render(
    <FamilyIntakePanel
      period="2026-10"
      adapter={adapter}
      emailOptions={{
        status: "ready",
        data: {
          accounts: [],
          recipients: [
            {
              entityId: recipient,
              name: "Synthetic contact",
              address: "test@example.test",
            },
          ],
        },
      }}
      onChanged={async () => undefined}
    />,
  );
  await screen.findByText("No correspondence selected for this month.");
  fireEvent.change(screen.getByLabelText("Source title"), {
    target: { value: "Pickup email" },
  });
  fireEvent.change(screen.getByLabelText("Email or message text"), {
    target: { value: "Please confirm pickup at three." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add private source" }));
  await screen.findByText("Connection interrupted");
  expect(
    (screen.getByLabelText("Email or message text") as HTMLTextAreaElement)
      .value,
  ).toBe("Please confirm pickup at three.");
  fireEvent.click(screen.getByRole("button", { name: "Add private source" }));
  await screen.findByLabelText("Proposed statement");
  expect(attempts[1]).toEqual(attempts[0]);
  const recipientBox = screen.getByRole("checkbox", {
    name: "Synthetic contact — test@example.test",
  }) as HTMLInputElement;
  expect(recipientBox.checked).toBe(false);
  fireEvent.click(recipientBox);
  fireEvent.change(screen.getByLabelText("Proposed statement"), {
    target: { value: "Discard this unsaved edit." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard fact edits" }));
  expect(
    (screen.getByLabelText("Proposed statement") as HTMLTextAreaElement).value,
  ).toBe(saved.facts[0].statement);
  expect(recipientBox.checked).toBe(false);
  expect(reviewed).toBeNull();
  fireEvent.click(recipientBox);
  fireEvent.change(screen.getByLabelText("Proposed statement"), {
    target: { value: "Please confirm the pickup time." },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "requests 1 for fact 1" }),
    { target: { value: "Confirm the corrected pickup time" } },
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Awaiting an answer" }));
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed facts" }));
  await waitFor(() =>
    expect(reviewed).toMatchObject({
      facts: [
        {
          statement: "Please confirm the pickup time.",
          requests: ["Confirm the corrected pickup time"],
          unanswered: false,
          sourceQuote: saved.facts[0].sourceQuote,
          recipientEntityIds: [recipient],
        },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Include this fact" }));
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed facts" }));
  await waitFor(() => expect(reviewed).toMatchObject({ facts: [] }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Include this fact",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  );
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Synthetic contact — test@example.test",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Include this fact" }));
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed facts" }));
  await waitFor(() =>
    expect(reviewed).toMatchObject({
      facts: [
        { sourceQuote: saved.facts[0].sourceQuote, recipientEntityIds: [] },
      ],
    }),
  );
});
