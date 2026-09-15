/** Exercises the real reader editor with controlled HTTP responses, including stale reviews and retained unknown identities. */
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
  getDocumentAccess: vi.fn(),
  getRelationshipsPeople: vi.fn(),
  updateDocumentAccess: vi.fn(),
}));
vi.mock("@elizaos/ui/api", () => ({
  client: api,
  isApiError: (error: { status?: number }) => typeof error?.status === "number",
}));
vi.mock("@elizaos/ui/hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => "test-agent",
}));

import { DocumentAccessPanel } from "./document-access-panel";

beforeEach(() => {
  vi.resetAllMocks();
  api.getDocumentAccess.mockResolvedValue({
    documentId: "doc",
    directGrantEntityIds: ["retained-reader"],
    accessRevision: "review-1",
  });
  api.getRelationshipsPeople.mockResolvedValue({
    people: [
      {
        primaryEntityId: "selected-identity",
        groupId: "group",
        memberEntityIds: ["selected-identity", "unselected-alias"],
        displayName: "Casey",
      },
    ],
  });
  api.updateDocumentAccess.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

async function selectReader() {
  render(<DocumentAccessPanel documentId="doc" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Manage document readers" }),
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: /Casey/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Review reader changes" }),
  );
}

it("sends only the reviewed identities and preserves existing readers outside the people directory", async () => {
  await selectReader();
  expect(api.updateDocumentAccess).not.toHaveBeenCalled();
  expect(screen.getByText("Existing reader")).toBeTruthy();
  api.getDocumentAccess.mockResolvedValue({
    documentId: "doc",
    directGrantEntityIds: ["retained-reader", "selected-identity"],
    accessRevision: "review-2",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed readers" }),
  );
  await waitFor(() =>
    expect(api.updateDocumentAccess).toHaveBeenCalledWith("doc", {
      directGrantEntityIds: ["retained-reader", "selected-identity"],
      expectedAccessRevision: "review-1",
    }),
  );
  await screen.findByText("Sharing saved. Current readers are shown below.");
  expect(api.getDocumentAccess).toHaveBeenCalledTimes(2);
  expect(
    screen
      .getByRole("button", { name: "Review reader changes" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("requires fresh readback and another review after a conflict", async () => {
  api.updateDocumentAccess.mockRejectedValueOnce({ status: 409 });
  await selectReader();
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed readers" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Save reviewed readers" }),
  ).toBeNull();
  api.getDocumentAccess.mockResolvedValue({
    documentId: "doc",
    directGrantEntityIds: [],
    accessRevision: "review-2",
  });
  fireEvent.click(screen.getByRole("button", { name: "Reload readers" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Casey/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Review reader changes" }),
  );
  expect(api.updateDocumentAccess).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed readers" }),
  );
  await waitFor(() =>
    expect(api.updateDocumentAccess).toHaveBeenLastCalledWith("doc", {
      directGrantEntityIds: ["selected-identity"],
      expectedAccessRevision: "review-2",
    }),
  );
});

it("does not turn an unavailable directory into an empty reader list", async () => {
  api.getRelationshipsPeople.mockRejectedValue(new Error("offline"));
  render(<DocumentAccessPanel documentId="doc" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Manage document readers" }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.updateDocumentAccess).not.toHaveBeenCalled();
});

it("keeps a committed save unconfirmed until readback succeeds and surfaces a failed confirmation", async () => {
  await selectReader();
  let rejectReadback!: (cause: Error) => void;
  const readback = new Promise((_resolve, reject) => {
    rejectReadback = reject;
  });
  api.getDocumentAccess.mockReturnValueOnce(readback);
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed readers" }),
  );
  await waitFor(() => expect(api.getDocumentAccess).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("button", { name: "Save reviewed readers" }),
  ).toBeNull();
  expect(
    screen.queryByText("Sharing saved. Current readers are shown below."),
  ).toBeNull();
  await act(async () => {
    rejectReadback(new Error("Readback unavailable"));
  });
  await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.updateDocumentAccess).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText("Sharing saved. Current readers are shown below."),
  ).toBeNull();
});
