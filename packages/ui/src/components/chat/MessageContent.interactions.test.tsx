/** Verifies MessageContent non-bytes interaction rendering through the package's configured test harness. */
// @vitest-environment jsdom
//
// Render coverage for the non-bytes interaction states surfaced in chat (the
// objects the product calls out: thinking/reasoning, suggestion chips, choice
// pickers, inline forms). Mirrors the story inputs in MessageContent.stories so
// the story-gate screenshots have a fast unit guard that they render at all.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

import { MessageContent } from "./MessageContent";

function assistant(over: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    timestamp: 1_700_000_000_000,
    ...over,
  } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent non-bytes interaction rendering", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders the visible reply alongside a reasoning/thinking block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          reasoning: "Cross-referencing the calendar before answering.",
          text: "You're free after 3pm.",
        })}
      />,
    );
    expect(screen.getByText(/free after 3pm/i)).toBeTruthy();
    // The thinking disclosure must ACTUALLY render — a single plain-text
    // reply is the common shape, and the single-segment fast path used to
    // return before the ThinkingBlock, silently dropping the reasoning.
    const toggle = screen.getByRole("button", { name: /thinking/i });
    fireEvent.click(toggle);
    expect(container.textContent ?? "").toContain(
      "Cross-referencing the calendar before answering.",
    );
  });

  it("renders the expandable tool-call log on a plain-text assistant reply", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Done — created the task.",
          toolEvents: [
            {
              id: "ev1",
              callId: "call1",
              type: "tool_call",
              status: "success",
              toolName: "TASKS_CREATE",
              arguments: { title: "Ship the demo" },
              result: { ok: true },
            } as never,
          ],
        })}
      />,
    );
    // The chosen action renders as its collapsible log row even though the
    // reply itself is a single plain-text segment (fast-path regression).
    expect(container.textContent ?? "").toContain("Done — created the task.");
    expect(container.textContent ?? "").toMatch(/TASKS_CREATE|Tasks Create/i);
  });

  it("renders suggestion chips from a [FOLLOWUPS] block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Done.\n[FOLLOWUPS]\nrerun=Run again\nexport=Export\n[/FOLLOWUPS]",
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Run again");
  });

  it("renders spaced CRLF followups without exposing wire markup", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Done.\r\n[ FOLLOWUPS ]\r\nreply:Again=Again\r\n[ / FOLLOWUPS ]",
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Again");
    expect(container.textContent ?? "").not.toContain("FOLLOWUPS");
    expect(container.textContent ?? "").not.toContain("reply:");
  });

  it("strips terminal unclaimed markers only from assistant messages", () => {
    const assistantView = withApp(
      <MessageContent
        message={assistant({
          text: "Done.\n[ FOLLOWUPS ]\nreply:Again=Again",
        })}
      />,
    );
    expect(assistantView.container.textContent ?? "").toBe("Done.");
    assistantView.unmount();

    const userMessage = assistant({
      role: "user",
      text: "Example:\n[ FOLLOWUPS ]\nreply:Again=Again",
    });
    const userView = withApp(<MessageContent message={userMessage} />);
    expect(userView.container.textContent ?? "").toContain("FOLLOWUPS");
  });

  it("renders a choice picker from a [CHOICE] block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Approve this booking?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]",
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Approve");
  });

  it("renders an inline form from a [FORM] block", () => {
    const form = JSON.stringify({
      title: "Trip details",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    });
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: `Fill this out:\n[FORM]\n${form}\n[/FORM]`,
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Destination");
  });

  it("renders the out-of-credits gate for an insufficient_credits failure and its CTA opens Settings", () => {
    const setTab = vi.fn();
    const appValue = {
      t: (key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? key),
      sendActionMessage: vi.fn(),
      setTab,
    } as never;
    __setAppValueForTests(appValue);
    render(
      <AppContext.Provider value={appValue}>
        <MessageContent
          message={assistant({
            failureKind: "insufficient_credits",
            text: "You're out of credits. Add more to keep chatting.",
          })}
        />
      </AppContext.Provider>,
    );

    // Designed gate, not a plain text bubble.
    expect(screen.getByText("Out of credits")).toBeTruthy();
    const cta = screen.getByRole("button", { name: "Add credits" });
    expect(cta).toBeTruthy();
    // The actionable server copy is surfaced verbatim.
    expect(
      screen.getByText(/out of credits\. Add more to keep chatting/i),
    ).toBeTruthy();

    fireEvent.click(cta);
    expect(setTab).toHaveBeenCalledWith("settings");
  });

  it("offers reply regeneration for a durable terminal failure and holds repeated clicks", async () => {
    let finish!: () => void;
    const handleChatRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const appValue = {
      t: (key: string) => key,
      sendActionMessage: vi.fn(),
      handleChatRetry,
    } as never;
    __setAppValueForTests(appValue);
    render(
      <AppContext.Provider value={appValue}>
        <MessageContent
          message={assistant({
            id: "saved-failure",
            text: "Reply failed after saving the note.",
            failureKind: "provider_issue",
            replyRecoveryAvailable: true,
            terminalFailure: {
              kind: "provider_issue",
              transient: false,
              message: "Reply failed.",
            },
          })}
        />
      </AppContext.Provider>,
    );
    const control = screen.getByRole("button", { name: "Regenerate reply" });
    fireEvent.click(control);
    fireEvent.click(control);
    expect(handleChatRetry).toHaveBeenCalledTimes(1);
    expect(handleChatRetry).toHaveBeenCalledWith("saved-failure");
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.textContent).toContain("Regenerating reply…");
    await act(async () => {
      finish();
    });
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders Retry for planner exhaustion and invokes the canonical retry handler", () => {
    const handleChatRetry = vi.fn();
    const appValue = {
      t: (key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? key),
      sendActionMessage: vi.fn(),
      handleChatRetry,
    } as never;
    __setAppValueForTests(appValue);
    render(
      <AppContext.Provider value={appValue}>
        <MessageContent
          message={assistant({
            id: "planner-failure",
            failureKind: "planner_exhaustion",
            text: "I ran out of attempts. Please try again.",
          })}
        />
      </AppContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handleChatRetry).toHaveBeenCalledWith("planner-failure");
  });
});
