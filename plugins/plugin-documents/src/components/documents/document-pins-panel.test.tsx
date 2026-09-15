/** Exercises the real pin editor's review, retained chat placement, conflict recovery and failed readback over controlled API responses. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getDocumentPins: vi.fn(),
  listConversations: vi.fn(),
  updateDocumentPins: vi.fn(),
}));
vi.mock("@elizaos/ui/api", () => ({
  client: api,
  isApiError: (error: { status?: number }) => typeof error?.status === "number",
}));
vi.mock("@elizaos/ui/hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => "agent",
}));

import { DocumentPinsPanel } from "./document-pins-panel";

beforeEach(() => {
  vi.resetAllMocks();
  api.getDocumentPins.mockResolvedValue({
    documentId: "doc",
    targets: { agent: false, roomIds: ["retained-room"] },
    pinRevision: "revision-1",
  });
  api.listConversations.mockResolvedValue({
    conversations: [
      { id: "conversation-id", roomId: "room-id", title: "Family planning" },
    ],
  });
  api.updateDocumentPins.mockResolvedValue({ ok: true, documentId: "doc" });
});
afterEach(cleanup);
async function selectPins() {
  render(<DocumentPinsPanel documentId="doc" />);
  fireEvent.click(screen.getByRole("button", { name: "Manage document pins" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Pin to this agent" }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /Family planning/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review pins" }));
}
it("reviews agent and actual room identities, preserving saved chats outside the directory", async () => {
  await selectPins();
  expect(api.updateDocumentPins).not.toHaveBeenCalled();
  expect(screen.getByText("Previously pinned chat")).toBeTruthy();
  api.getDocumentPins.mockResolvedValue({
    documentId: "doc",
    targets: { agent: true, roomIds: ["retained-room", "room-id"] },
    pinRevision: "revision-2",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed pins" }));
  await waitFor(() =>
    expect(api.updateDocumentPins).toHaveBeenCalledWith("doc", {
      agent: true,
      roomIds: ["retained-room", "room-id"],
      expectedPinRevision: "revision-1",
    }),
  );
  await screen.findByText("Pins saved. Current settings are shown below.");
  expect(
    screen
      .getByRole("button", { name: "Review pins" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("requires a new read and review after a conflict", async () => {
  api.updateDocumentPins.mockRejectedValueOnce({ status: 409 });
  await selectPins();
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed pins" }));
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Save reviewed pins" }),
  ).toBeNull();
  api.getDocumentPins.mockResolvedValue({
    documentId: "doc",
    targets: { agent: false, roomIds: [] },
    pinRevision: "revision-2",
  });
  fireEvent.click(screen.getByRole("button", { name: "Reload pins" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Pin to this agent" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review pins" }));
  expect(api.updateDocumentPins).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed pins" }));
  await waitFor(() =>
    expect(api.updateDocumentPins).toHaveBeenLastCalledWith("doc", {
      agent: true,
      roomIds: [],
      expectedPinRevision: "revision-2",
    }),
  );
});
it("hides the old review while readback is pending and does not confirm a failed readback", async () => {
  await selectPins();
  let rejectReadback!: (reason: Error) => void;
  api.getDocumentPins.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectReadback = reject;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save reviewed pins" }));
  await screen.findByText("Loading document pins…");
  expect(
    screen.queryByRole("button", { name: "Save reviewed pins" }),
  ).toBeNull();
  expect(
    screen.queryByText("Pins saved. Current settings are shown below."),
  ).toBeNull();
  await act(async () => {
    rejectReadback(new Error("offline"));
  });
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Pins saved. Current settings are shown below."),
  ).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.updateDocumentPins).toHaveBeenCalledTimes(1);
});
