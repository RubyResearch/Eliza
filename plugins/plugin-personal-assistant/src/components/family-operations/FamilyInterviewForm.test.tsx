// @vitest-environment jsdom
/** Exercises owner answer entry, private retry payloads and explicit no-update/discard behavior with the real form and deterministic transport outcomes. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { FamilyInterviewAnswer } from "../../lifeops/family-coordination/interview.js";
import { FamilyInterviewForm } from "./FamilyInterviewForm.js";

afterEach(cleanup);
it("retains the complete failed answer and operation identity until a private save succeeds", async () => {
  const requests: FamilyInterviewAnswer[] = [];
  const dirty: boolean[] = [];
  render(
    <FamilyInterviewForm
      period="2026-11"
      busy={false}
      missingSections={["school"]}
      onDirtyChange={(_id, value) => {
        dirty.push(value);
      }}
      save={async (input) => {
        requests.push(input);
        return requests.length > 1;
      }}
    />,
  );
  fireEvent.click(screen.getByText("Fill missing information"));
  expect(
    (
      screen.getByRole("button", {
        name: "Save private answer",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("radio", { name: "I have an update", exact: true }),
  );
  const text =
    "Please confirm Friday pickup.\nThe second line must also be preserved.";
  fireEvent.change(screen.getByLabelText("Your update"), {
    target: { value: text },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "This update needs an answer" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save private answer" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(
    (screen.getByLabelText("Your update") as HTMLTextAreaElement).value,
  ).toBe(text);
  expect(dirty.at(-1)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save private answer" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toMatchObject({
    periodKey: "2026-11",
    section: "school",
    answer: { kind: "update", text, unanswered: true },
    recipientEntityIds: [],
  });
  await waitFor(() => expect(dirty.at(-1)).toBe(false));
  expect(screen.queryByLabelText("Your update")).toBeNull();
});

it("requires an explicit no-update choice and discards unfinished text without writing it", async () => {
  const requests: FamilyInterviewAnswer[] = [];
  render(
    <FamilyInterviewForm
      period="2026-11"
      busy={false}
      missingSections={[]}
      onDirtyChange={() => undefined}
      save={async (input) => {
        requests.push(input);
        return true;
      }}
    />,
  );
  fireEvent.click(screen.getByText("Fill missing information"));
  fireEvent.click(
    screen.getByRole("radio", { name: "I have an update", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Your update"), {
    target: { value: "Unsaved owner draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard answer" }));
  expect(requests).toEqual([]);
  expect(screen.queryByLabelText("Your update")).toBeNull();
  fireEvent.change(screen.getByLabelText("Topic"), {
    target: { value: "unanswered" },
  });
  fireEvent.click(
    screen.getByRole("radio", {
      name: "I have no additional updates",
      exact: true,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save private answer" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    section: "unanswered",
    answer: { kind: "no_additional_updates" },
    recipientEntityIds: [],
  });
  expect(JSON.stringify(requests[0])).not.toContain("Unsaved owner draft");
});
