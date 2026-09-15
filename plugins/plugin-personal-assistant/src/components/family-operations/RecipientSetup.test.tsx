// @vitest-environment jsdom
/** Exercises recipient review, stale confirmation invalidation, and visible retry with a deterministic adapter boundary. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecipientSetup } from "./RecipientSetup.js";
import type { FamilyOperationsAdapter } from "./types.js";

afterEach(cleanup);

it("requires a fresh review after an address change and selects only the confirmed result", async () => {
  const confirmEmailRecipient = vi.fn(
    async (
      input: Parameters<FamilyOperationsAdapter["confirmEmailRecipient"]>[0],
    ) => ({
      ...input,
      entityId: "person-1",
    }),
  );
  const adapter = {
    listRecipientContacts: async () => [{ entityId: "person-1", name: "Alex" }],
    confirmEmailRecipient,
  } satisfies Pick<
    FamilyOperationsAdapter,
    "listRecipientContacts" | "confirmEmailRecipient"
  >;
  const onConfirmed = vi.fn(async () => undefined);
  render(<RecipientSetup adapter={adapter} onConfirmed={onConfirmed} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Add or confirm email recipient" }),
  );
  fireEvent.change(await screen.findByLabelText("Person"), {
    target: { value: "person-1" },
  });
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "alex@example.test" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "corrected@example.test" },
  });
  expect(
    screen
      .getByRole("button", { name: "Confirm recipient" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(confirmEmailRecipient).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm recipient" }));
  await waitFor(() =>
    expect(onConfirmed).toHaveBeenCalledWith({
      entityId: "person-1",
      name: "Alex",
      address: "corrected@example.test",
    }),
  );
});

it("preserves a reviewed new contact when confirmation fails and retries the same pair", async () => {
  const confirmEmailRecipient = vi
    .fn()
    .mockRejectedValueOnce(new Error("Recipient could not be saved"))
    .mockResolvedValue({
      entityId: "new-person",
      name: "Sam",
      address: "sam@example.test",
    });
  const adapter = {
    listRecipientContacts: async () => [],
    confirmEmailRecipient,
  } satisfies Pick<
    FamilyOperationsAdapter,
    "listRecipientContacts" | "confirmEmailRecipient"
  >;
  const onConfirmed = vi.fn(async () => undefined);
  render(<RecipientSetup adapter={adapter} onConfirmed={onConfirmed} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Add or confirm email recipient" }),
  );
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Sam" },
  });
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "sam@example.test" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm recipient" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Recipient could not be saved",
  );
  expect(onConfirmed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm recipient" }));
  await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  expect(confirmEmailRecipient.mock.calls).toEqual([
    [{ entityId: null, name: "Sam", address: "sam@example.test" }],
    [{ entityId: null, name: "Sam", address: "sam@example.test" }],
  ]);
});

it("keeps failed contact loading distinct from an empty list and lets the owner cancel", async () => {
  const adapter = {
    listRecipientContacts: vi
      .fn()
      .mockRejectedValue(new Error("Contact service unavailable")),
    confirmEmailRecipient: vi.fn(),
  } satisfies Pick<
    FamilyOperationsAdapter,
    "listRecipientContacts" | "confirmEmailRecipient"
  >;
  render(<RecipientSetup adapter={adapter} onConfirmed={vi.fn()} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Add or confirm email recipient" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Contact service unavailable",
  );
  expect(screen.queryByLabelText("Name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("button", { name: "Add or confirm email recipient" }),
  ).toBeTruthy();
  expect(adapter.confirmEmailRecipient).not.toHaveBeenCalled();
});
