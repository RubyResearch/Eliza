/**
 * Native Messages status-panel regression using a mocked plugin API response.
 * Verifies that the local connector is presented as macOS Messages rather than
 * as a legacy bridge or external service.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  value: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  },
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appMock.value) => unknown) =>
    selector(appMock.value),
}));

vi.mock("../../api", async () => {
  const actual = (await vi.importActual("../../api")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    client: {
      getIMessageStatus: vi.fn(),
      onWsEvent: () => () => {},
    },
  };
});

import { client } from "../../api";
import { IMessageStatusPanel } from "./IMessageStatusPanel";

describe("IMessageStatusPanel", () => {
  afterEach(() => cleanup());

  it("identifies the connected transport as local macOS Messages", async () => {
    const getStatus = client.getIMessageStatus as unknown as ReturnType<
      typeof vi.fn
    >;
    getStatus.mockResolvedValue({
      available: true,
      connected: true,
      bridgeType: "native",
      chatDbAvailable: true,
      sendOnly: false,
      chatDbPath: "/Users/test/Library/Messages/chat.db",
    });

    render(<IMessageStatusPanel />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "iMessage is connected. Messages are being read from the local database.",
        ),
      ).toBeTruthy();
    });
    expect(screen.getByText("Saved transport: macOS Messages")).toBeTruthy();
    expect(screen.queryByText(/BlueBubbles|Bridge:/i)).toBeNull();
  });
  it("shows hosted readiness without asking for macOS permissions", async () => {
    vi.mocked(client.getIMessageStatus).mockResolvedValue({
      available: true,
      connected: true,
      bridgeType: "blooio",
      chatDbAvailable: false,
      webhookPath: "/api/imessage/webhook/blooio",
    });
    render(<IMessageStatusPanel />);
    await screen.findByText(/iMessage is connected through Blooio/);
    expect(
      screen.queryByText(/Full Disk Access|chat.db|macOS Messages/),
    ).toBeNull();
    expect(screen.getByText(/Signed webhook:/)).toBeTruthy();
  });

  it("shows a failed refresh as unavailable rather than disconnected or connected", async () => {
    vi.mocked(client.getIMessageStatus).mockRejectedValue(
      new Error("Service unavailable"),
    );
    render(<IMessageStatusPanel />);
    await screen.findByText("iMessage status unavailable.");
    expect(screen.getByText("Service unavailable")).toBeTruthy();
    expect(
      screen.queryByText(/iMessage is connected|iMessage is not connected/),
    ).toBeNull();
  });
});
