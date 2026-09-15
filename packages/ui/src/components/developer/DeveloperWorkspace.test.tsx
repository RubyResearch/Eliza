// @vitest-environment jsdom
/** Tests canonical chat dispatch and inspector polling with mocked transport. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import type {
  TrajectoryDetailResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import {
  callLane,
  DeveloperReplyDetails,
  DeveloperTrace,
  DeveloperWorkspace,
} from "./DeveloperWorkspace";
import { useDeveloperTrajectories } from "./useDeveloperTrajectories";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  send: vi.fn(),
  relay: vi.fn(),
  stop: vi.fn(),
}));
const record = {
  id: "run-1",
  agentId: "agent-1",
  entityId: null,
  conversationId: "conversation-1",
  source: "client_chat",
  roomId: "room-1",
  status: "completed",
  updatedAt: "one",
  llmCallCount: 1,
  startTime: 1,
  endTime: 1501,
  providerAccessCount: 0,
  createdAt: "2026-09-09T00:00:00Z",
  durationMs: 1500,
  totalPromptTokens: 100,
  totalCompletionTokens: 20,
  metadata: { messageId: "user-1" },
} satisfies TrajectoryRecord;
const detail = {
  trajectory: record,
  llmCalls: [],
  providerAccesses: [],
} as TrajectoryDetailResult;
const appState = {
  activeConversationId: "conversation-1",
  conversations: [
    { id: "conversation-1", roomId: "room-1", title: "Current chat" },
  ],
  conversationMessages: [],
  chatSending: false,
  chatFirstTokenReceived: false,
  agentStatus: { canRespond: true },
  sendChatText: mocks.send,
  handleChatStop: mocks.stop,
  tab: "notes",
};
vi.mock("../../state/developer-tab-bridge", () => {
  const snapshot = {
    peers: [
      { id: "app-tab", path: "/notes", conversationId: "conversation-1" },
    ],
    selectedId: "app-tab",
  };
  return {
    getDeveloperTabState: () => snapshot,
    subscribeDeveloperTabs: () => () => {},
    selectDeveloperAppTab: vi.fn(),
    sendToDeveloperAppTab: mocks.relay,
    stopDeveloperAppTurn: mocks.stop,
  };
});
vi.mock("../../api/client", () => ({
  client: { getTrajectories: mocks.list, getTrajectoryDetail: mocks.detail },
}));
vi.mock("../../state/ChatComposerContext.hooks", async () => {
  const { useState } = await import("react");
  return {
    useChatComposer: () => {
      const [chatInput, setChatInput] = useState("");
      return { chatSending: appState.chatSending, chatInput, setChatInput };
    },
  };
});
const messageFixtures: ConversationMessage[] = [];
vi.mock("../../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({ conversationMessages: messageFixtures }),
}));
vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => "local-agent",
}));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (select: (state: typeof appState) => unknown) =>
    select(appState),
}));
vi.mock("../../state", () => ({
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
      copyToClipboard: vi.fn(),
    }),
}));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));
vi.mock("../RoleGate", () => ({
  RoleGate: ({ children }: { children: ReactNode }) => children,
  OwnerOnlyNotice: () => null,
}));
vi.mock("../chat/MessageContent", () => ({
  MessageContent: ({ message }: { message: { text: string } }) => (
    <p>{message.text}</p>
  ),
}));
vi.mock("../accounts/AddAccountDialog", () => ({
  AddAccountDialog: () => null,
}));
vi.mock("../settings/ModelConfigurationPanel", () => ({
  ModelConfigurationPanel: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  messageFixtures.splice(
    0,
    messageFixtures.length,
    {
      id: "user-1",
      role: "user",
      text: "Which view is open?",
      timestamp: 1000,
    },
    {
      id: "reply-1",
      role: "assistant",
      text: "You are on Notes.",
      timestamp: 1001,
      replyToMessageId: "user-1",
    },
  );
  appState.agentStatus.canRespond = true;
  appState.chatSending = false;
  mocks.list.mockResolvedValue({
    trajectories: [record],
    total: 1,
    offset: 0,
    limit: 50,
  });
  mocks.detail.mockResolvedValue(detail);
  mocks.send.mockResolvedValue(undefined);
  mocks.relay.mockResolvedValue(undefined);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("developer workspace", () => {
  it("keeps original usage separate from a newer recovery and opens both real run ids", async () => {
    const recovery = {
      ...record,
      id: "recovery-1",
      startTime: 2000,
      durationMs: 2700,
      totalPromptTokens: 57656,
      totalCompletionTokens: 99,
      metadata: { messageId: "user-1", replyRecovery: true },
    };
    mocks.list.mockResolvedValue({
      trajectories: [recovery, record],
      total: 2,
    });
    mocks.detail.mockImplementation((id) =>
      Promise.resolve({
        ...detail,
        trajectory: id === recovery.id ? recovery : record,
      }),
    );
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(
      screen.getByText(/Original run: 100 tokens in/).textContent,
    ).toContain("1.50s server run");
    expect(screen.getByText(/Reply recovery 1:/).textContent).toContain(
      "57,656 tokens in · 99 out · 2.70s server run",
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Trajectories" }), {
      button: 0,
      ctrlKey: false,
    });
    await flush();
    expect(screen.getByRole("option", { name: /Chat run/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Reply recovery/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Run" }), {
      target: { value: recovery.id },
    });
    await flush();
    expect(mocks.detail).toHaveBeenCalledWith(recovery.id, expect.anything());
    expect(
      screen.getByText(/Original run: 100 tokens in/).textContent,
    ).toContain("1.50s server run");
  });

  it("uses recorded run ownership without inferring post-turn timing from stage names", () => {
    expect(callLane("client_chat")).toBe("Chat run");
    expect(callLane("background_memory")).toBe("Background memory");
    expect(callLane("recovery")).toBe("recovery");
  });
  it("relays to the selected normal app tab without sending from the hidden developer client", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    fireEvent.change(screen.getByLabelText("Message Eliza"), {
      target: { value: "Open Calendar without changing anything" },
    });
    const form = screen.getByRole("button", { name: "Send" }).closest("form");
    if (!form) throw new Error("Composer form missing");
    fireEvent.submit(form);
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.relay).toHaveBeenCalledExactlyOnceWith(
      "Open Calendar without changing anything",
      "conversation-1",
    );
    expect(screen.getByText("Existing app")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Exit" }).getAttribute("href"),
    ).toBe("/notes");
    expect(screen.getByTestId("developer-reply").textContent).toBe(
      "You are on Notes.",
    );
  });

  it("shows the conversation and tokens, fetching details only after expansion", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText("Which view is open?")).toBeTruthy();
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
    expect(screen.getByText(/1 model attempt · 1.50s server run/)).toBeTruthy();
    expect(screen.queryByText("Recorded runs")).toBeNull();
    expect(screen.queryByText("Run input")).toBeNull();
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      expect.objectContaining({ includePayloads: false }),
    );
    expect(screen.getByText("Run input")).toBeTruthy();
    expect(screen.queryByLabelText("Full trajectory JSON")).toBeNull();
  });

  it("loads full trajectories only in their tab, including older/background runs with exact ownership", async () => {
    const background = {
      ...record,
      id: "memory-run",
      source: "background_memory",
      startTime: 2000,
    };
    const older = { ...record, id: "older-run", startTime: 0 };
    mocks.list.mockImplementation((options) =>
      Promise.resolve(
        options.search
          ? {
              trajectories: options.offset
                ? [background]
                : [
                    older,
                    record,
                    { ...record, id: "wrong-room", roomId: "other" },
                    {
                      ...record,
                      id: "wrong-message",
                      metadata: { messageId: "other" },
                    },
                  ],
              total: 5,
            }
          : { trajectories: [record], total: 1 },
      ),
    );
    mocks.detail.mockImplementation((id, options) =>
      Promise.resolve({
        ...detail,
        trajectory: { ...record, id },
        llmCalls:
          options.includePayloads === false
            ? []
            : [
                {
                  id: "call-1",
                  model: "qwen",
                  timestamp: 1100,
                  maxTokens: 0,
                  temperature: 0,
                  userPrompt: "Actual model input",
                  response: "Actual model output",
                  systemPrompt: "Actual system instructions",
                },
              ],
        semanticStages: [
          {
            schemaVersion: 1,
            stageId: "tool-step",
            kind: "tool",
            startedAt: 1000,
            endedAt: 1200,
            latencyMs: 200,
            payload: {
              tool: {
                name: "OPEN_NOTES",
                args: { view: "notes" },
                result: { success: true, visibleView: "notes" },
              },
            },
          },
        ],
      }),
    );
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    expect(
      mocks.detail.mock.calls.every(
        ([, options]) => options.includePayloads === false,
      ),
    ).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Trajectories" }), {
      button: 0,
      ctrlKey: false,
    });
    await flush();
    const panel = screen.getByRole("tabpanel", { name: "Trajectories" });
    expect(
      within(panel).getByText(/Background memory · 1 model attempt/),
    ).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith(
      { search: "user-1", limit: 100, offset: 4 },
      expect.anything(),
    );
    expect(
      mocks.detail.mock.calls.some(
        ([id]) => id === "wrong-room" || id === "wrong-message",
      ),
    ).toBe(false);
    expect(within(panel).getByLabelText("Model call")).toBeTruthy();
    expect(within(panel).getByText("Actual model input")).toBeTruthy();
    fireEvent.mouseDown(within(panel).getByRole("tab", { name: "Output" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(within(panel).getByText("Actual model output")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Steps" }));
    await flush();
    expect(within(panel).getByLabelText("Recorded step")).toBeTruthy();
    expect(
      within(panel).getByRole("region", { name: "Input" }).textContent,
    ).toContain('"view": "notes"');
    fireEvent.mouseDown(within(panel).getByRole("tab", { name: "Output" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      within(panel).getByRole("region", { name: "Output" }).textContent,
    ).toContain('"success": true');
    expect(within(panel).queryByLabelText("Full trajectory JSON")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    await flush();
    expect(screen.queryByRole("tabpanel", { name: "Trajectories" })).toBeNull();
    expect(
      screen.getByText("Full prompts, tools, results & context"),
    ).toBeTruthy();
  });

  it("loads complete wire evidence only when expanded and keeps it selectable", async () => {
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Full prompts, tools, results & context",
      }),
    );
    await flush();
    expect(mocks.detail).toHaveBeenLastCalledWith(
      "run-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      screen.getByRole("textbox", { name: "Full trajectory JSON" }),
    ).toHaveProperty("value", JSON.stringify(detail, null, 2));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Full prompts, tools, results & context",
      }),
    );
    expect(
      screen.queryByRole("textbox", { name: "Full trajectory JSON" }),
    ).toBeNull();
    expect(mocks.detail).toHaveBeenCalledTimes(2);
  });

  it("loads older reply counts on inspection without calling unloaded counts unavailable", async () => {
    mocks.list.mockImplementation((options) =>
      Promise.resolve({
        trajectories: options.search ? [record] : [],
        total: options.search ? 1 : 0,
      }),
    );
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.queryByText(/Token count unavailable/)).toBeNull();
    expect(mocks.list.mock.calls.some(([options]) => options.search)).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith(
      { search: "user-1", limit: 100, offset: 0 },
      expect.anything(),
    );
    expect(mocks.detail).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ includePayloads: false }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
  });

  it.each([
    { input: 0, output: 0, label: "Usage details" },
    { input: 0, output: 12, label: "0 tokens in · 12 out" },
  ])(
    "does not label zero input as missing usage ($output output)",
    async ({ input, output, label }) => {
      render(
        <DeveloperReplyDetails
          record={{
            ...record,
            totalPromptTokens: input,
            totalCompletionTokens: output,
          }}
        />,
      );
      await flush();
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
      expect(screen.queryByText(/not recorded|unavailable/)).toBeNull();
    },
  );

  it("keeps background-only history inspectable without claiming no matching run", async () => {
    const background = {
      ...record,
      id: "memory-only",
      source: "background_memory",
    };
    mocks.list.mockResolvedValue({ trajectories: [background], total: 1 });
    mocks.detail.mockResolvedValue({ ...detail, trajectory: background });
    render(<DeveloperReplyDetails roomId="room-1" messageId="user-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    expect(screen.getByText("No foreground counts")).toBeTruthy();
    expect(screen.queryByText("No recorded run")).toBeNull();
    expect(
      screen.getByText(/Open Trajectories to inspect the other recorded runs/),
    ).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Trajectories" }), {
      button: 0,
      ctrlKey: false,
    });
    await flush();
    expect(
      screen.getByText(/Background memory · 1 model attempt/),
    ).toBeTruthy();
    expect(mocks.detail).toHaveBeenCalledWith("memory-only", expect.anything());
  });

  it("shows live elapsed time before usage arrives without inventing token counts", async () => {
    appState.chatSending = true;
    mocks.list.mockResolvedValue({ trajectories: [], total: 0 });
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Thinking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status").textContent).toContain("1.00s");
    expect(screen.getByText(/Waiting for the run/)).toBeTruthy();
    expect(screen.queryByText(/tokens in/)).toBeNull();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("never attaches another room's token counts to a reply", async () => {
    mocks.list.mockResolvedValue({
      trajectories: [{ ...record, roomId: "other-room" }],
      total: 1,
    });
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.queryByText(/tokens in/)).toBeNull();
  });

  it("uses explicit reply linkage for interleaved messages, including history lookup", async () => {
    messageFixtures.splice(
      0,
      messageFixtures.length,
      { id: "user-1", role: "user", text: "First request", timestamp: 1000 },
      { id: "user-2", role: "user", text: "Second request", timestamp: 1001 },
      {
        id: "reply-1",
        role: "assistant",
        text: "Reply to first",
        timestamp: 1002,
        replyToMessageId: "user-1",
      },
    );
    mocks.list.mockResolvedValue({
      trajectories: [
        {
          ...record,
          id: "second-run",
          totalPromptTokens: 700,
          metadata: { messageId: "user-2" },
        },
        record,
        { ...record, id: "first-memory", source: "background_memory" },
      ],
      total: 3,
    });
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText(/100 tokens in/)).toBeTruthy();
    expect(screen.queryByText(/700 tokens in/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await flush();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Trajectories" }), {
      button: 0,
      ctrlKey: false,
    });
    await flush();
    expect(mocks.list).toHaveBeenCalledWith(
      { search: "user-1", limit: 100, offset: 0 },
      expect.anything(),
    );
    expect(
      screen.getByText(/Background memory · 1 model attempt/),
    ).toBeTruthy();
  });

  it("never gives an unlinked notification the previous reply's usage", async () => {
    messageFixtures.push({
      id: "notice",
      role: "assistant",
      text: "Background recovery notice",
      timestamp: 2000,
    });
    render(
      <DeveloperWorkspace>
        <p>App</p>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getAllByText(/100 tokens in/)).toHaveLength(1);
    const notice = screen.getAllByRole("article", { name: "Eliza" }).at(-1);
    if (!notice) throw new Error("Missing notification fixture");
    expect(within(notice).queryByText(/tokens in/)).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Inspect" }));
    await flush();
    expect(screen.getByText("No linked run")).toBeTruthy();
    expect(mocks.list.mock.calls.some(([options]) => options.search)).toBe(
      false,
    );
  });

  it("keeps chat summaries visible when background runs fill the global page", async () => {
    const noise = Array.from({ length: 50 }, (_, index) => ({
      ...record,
      id: `background-${index}`,
      source: "background_memory",
    }));
    mocks.list.mockImplementation(async (options) => ({
      trajectories:
        options.source === "client_chat" && options.roomId === "room-1"
          ? [record]
          : noise,
      total: 51,
    }));
    render(
      <DeveloperWorkspace>
        <p>App</p>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText(/100 tokens in · 20 out/)).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.list).toHaveBeenLastCalledWith(
      { limit: 50, offset: 0, source: "client_chat", roomId: "room-1" },
      expect.anything(),
    );
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("uses global pagination only in the advanced inspector", async () => {
    const { result, rerender } = renderHook(
      ({ inspect }) => useDeveloperTrajectories("room-1", false, inspect),
      { initialProps: { inspect: true } },
    );
    await flush();
    act(() => result.current.setOffset(50));
    await flush();
    expect(mocks.list).toHaveBeenLastCalledWith(
      { limit: 50, offset: 50 },
      expect.anything(),
    );
    rerender({ inspect: false });
    await flush();
    expect(mocks.list).toHaveBeenLastCalledWith(
      { limit: 50, offset: 0, source: "client_chat", roomId: "room-1" },
      expect.anything(),
    );
  });

  it("polls small evidence, caches settled runs, pauses and resumes without discarding inspection", async () => {
    const { result } = renderHook(() =>
      useDeveloperTrajectories("room-1", false),
    );
    await flush();
    expect(mocks.detail).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        includePayloads: false,
        signal: expect.any(AbortSignal),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    act(() => result.current.setPaused(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(result.current.inspection?.record.id).toBe("run-1");
    act(() => result.current.setPaused(false));
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(5);
  });

  it("does not overlap slow reads or accept data after unmount", async () => {
    let resolveList!: (result: unknown) => void;
    mocks.list.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const { unmount } = renderHook(() =>
      useDeveloperTrajectories("room-1", true),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const signal = mocks.list.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    resolveList({ trajectories: [record], total: 1 });
    await flush();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("includes final response evaluation in run totals while keeping unknown usage explicit", () => {
    const calls = [
      {
        id: "one",
        purpose: "reply",
        model: "qwen",
        promptTokens: 100,
        completionTokens: 0,
      },
      { id: "two", purpose: "reply", model: "qwen" },
      { id: "three", purpose: "evaluation", model: "qwen", promptTokens: 800 },
    ] as TrajectoryDetailResult["llmCalls"];
    render(
      <DeveloperTrace
        record={record}
        detail={{ ...detail, llmCalls: calls }}
      />,
    );
    expect(screen.getByText("900+ (partial)")).toBeTruthy();
    expect(screen.queryByText("Post-turn evaluation")).toBeNull();
  });
  it("shows unknown instead of an invented zero for wholly missing usage", () => {
    render(
      <DeveloperTrace
        record={record}
        detail={{
          ...detail,
          llmCalls: [
            { id: "unknown", purpose: "reply", model: "qwen" },
          ] as TrajectoryDetailResult["llmCalls"],
        }}
      />,
    );
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.queryByText("0+")).toBeNull();
  });
  it("distinguishes the reported 3.43s run from 2.29s combined model time and includes cached tokens", () => {
    const calls = [
      [29431, 390, 24576, 989],
      [11759, 59, 6144, 813],
      [9665, 61, 4096, 490],
    ].map(
      (
        [promptTokens, completionTokens, cacheReadInputTokens, latencyMs],
        index,
      ) => ({
        id: String(index),
        model: "qwen",
        purpose: "reply",
        promptTokens,
        completionTokens,
        cacheReadInputTokens,
        latencyMs,
      }),
    ) as TrajectoryDetailResult["llmCalls"];
    render(
      <DeveloperTrace
        record={{ ...record, llmCallCount: 3, durationMs: 3427 }}
        detail={{ ...detail, llmCalls: calls }}
      />,
    );
    expect(screen.getByText("50,855")).toBeTruthy();
    expect(screen.getByText("3.43s")).toBeTruthy();
    expect(screen.getByText("Server run time")).toBeTruthy();
    expect(
      screen.getByText(/excludes waiting before the run starts/),
    ).toBeTruthy();
    expect(
      screen.getByText("Combined model time").nextElementSibling?.textContent,
    ).toBe("2.29s");
    expect(
      screen.getByText("Cached input (included)").nextElementSibling
        ?.textContent,
    ).toBe("34,816");
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
  it("does not fabricate overhead from concurrent calls whose combined duration exceeds the run", () => {
    const calls = [0, 1].map((id) => ({
      id: String(id),
      timestamp: 1000,
      model: "qwen",
      latencyMs: 1000,
    })) as TrajectoryDetailResult["llmCalls"];
    render(
      <DeveloperTrace
        record={{ ...record, llmCallCount: 2 }}
        detail={{ ...detail, llmCalls: calls }}
      />,
    );
    expect(
      screen.getByText("Combined model time").nextElementSibling?.textContent,
    ).toBe("2.00s");
    expect(screen.getByText("1.50s")).toBeTruthy();
    expect(screen.getByText(/Concurrent calls can overlap/)).toBeTruthy();
    expect(screen.queryByText(/-0.50s/)).toBeNull();
  });
  it("marks missing, invalid and unloaded call measurements partial while retaining measured zero", () => {
    const calls = [
      {
        id: "measured",
        latencyMs: 0,
        promptTokens: 0,
        cacheReadInputTokens: 0,
      },
      {
        id: "invalid",
        latencyMs: Number.NaN,
        promptTokens: -1,
        cacheReadInputTokens: Number.POSITIVE_INFINITY,
      },
    ] as TrajectoryDetailResult["llmCalls"];
    render(
      <DeveloperTrace
        record={{ ...record, llmCallCount: 3 }}
        detail={{ ...detail, llmCalls: calls }}
      />,
    );
    expect(
      screen.getByText("Combined model time").nextElementSibling?.textContent,
    ).toBe("0.00s+ (partial)");
    expect(screen.getAllByText("0+ (partial)")).toHaveLength(2);
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });
  it("does not call an active run's duration a completed total", () => {
    render(<DeveloperReplyDetails record={{ ...record, status: "active" }} />);
    expect(screen.getByText(/1.50s server run so far · Working/)).toBeTruthy();
    expect(screen.queryByText(/1.50s total/)).toBeNull();
  });
  it("does not label an unavailable agent ready", async () => {
    appState.agentStatus.canRespond = false;
    render(
      <DeveloperWorkspace>
        <div>Existing app</div>
      </DeveloperWorkspace>,
    );
    await flush();
    expect(screen.getByText(/Agent unavailable/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
