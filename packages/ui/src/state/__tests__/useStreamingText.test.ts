/**
 * Unit coverage for the streaming-text modification primitive: append/replace/
 * complete/fail/interrupt/drop modes and referential-equality preservation.
 * Pure function, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api";
import {
  applyStreamingTextModification,
  type StreamingTextSetter,
} from "../useStreamingText";

/**
 * Build a tiny test harness around React's `useState` setter contract.
 * We don't need React here — just somewhere to apply the updater function
 * and capture the resulting array reference.
 */
function makeSetter(initial: ConversationMessage[]) {
  let current = initial;
  const setter: StreamingTextSetter = (value) => {
    current = typeof value === "function" ? value(current) : value;
  };
  return {
    setter,
    get current() {
      return current;
    },
  };
}

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, timestamp: 0 };
}

function assistantMsg(
  id: string,
  text: string,
  extras: Partial<ConversationMessage> = {},
): ConversationMessage {
  return { id, role: "assistant", text, timestamp: 0, ...extras };
}

describe("applyStreamingTextModification", () => {
  it("append accumulates a token onto the targeted assistant turn", () => {
    const initial = [userMsg("u1", "hi"), assistantMsg("a1", "Hello")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "append",
      token: " world",
    });

    expect(harness.current[1].text).toBe("Hello world");
    expect(harness.current[0]).toBe(initial[0]);
    expect(harness.current).not.toBe(initial);
  });

  it("replace overwrites text from a cumulative snapshot", () => {
    const initial = [assistantMsg("a1", "Hel")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "replace",
      fullText: "Hello world",
    });

    expect(harness.current[0].text).toBe("Hello world");
  });

  it("complete is idempotent on identical text + failure state", () => {
    const initial = [assistantMsg("a1", "Done")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Done",
    });

    expect(harness.current).toBe(initial);
  });

  it("binds an unchanged terminal reply to its recorded user turn without inventing a durable reply ID", () => {
    const initial = [assistantMsg("temp-reply", "Try again.")];
    const harness = makeSetter(initial);
    const modification = {
      messageId: "temp-reply",
      mode: "complete" as const,
      fullText: "Try again.",
      assistantEphemeral: true,
      replyToMessageId: "server-user",
    };
    applyStreamingTextModification(harness.setter, modification);
    expect(harness.current[0]).toMatchObject({
      id: "temp-reply",
      replyToMessageId: "server-user",
      assistantEphemeral: true,
    });
    const linked = harness.current;
    applyStreamingTextModification(harness.setter, modification);
    expect(harness.current).toBe(linked);
    applyStreamingTextModification(harness.setter, {
      messageId: "temp-reply",
      mode: "complete",
      fullText: "Try again.",
      assistantEphemeral: true,
    });
    expect(harness.current).toBe(linked);
  });

  it("complete updates text and stamps failureKind together", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Connect a provider in Settings.",
      failureKind: "no_provider",
    });

    expect(harness.current[0].text).toBe("Connect a provider in Settings.");
    expect(harness.current[0].failureKind).toBe("no_provider");
  });

  it("complete retains typed terminal failure details", () => {
    const initial = [assistantMsg("a1", "Done")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Shell execution failed.",
      failureKind: "coding_tool_failure",
      terminalFailure: {
        kind: "coding_tool_failure",
        message: "Shell execution failed.",
        transient: true,
        code: "SHELL_UNAVAILABLE",
      },
    });

    expect(harness.current[0].terminalFailure).toMatchObject({
      kind: "coding_tool_failure",
      transient: true,
      code: "SHELL_UNAVAILABLE",
    });
  });

  it("complete clears a stale failureKind when none is provided", () => {
    const initial = [
      assistantMsg("a1", "partial", { failureKind: "no_provider" }),
    ];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Recovered text",
    });

    expect(harness.current[0].text).toBe("Recovered text");
    expect(harness.current[0].failureKind).toBeUndefined();
  });

  it("complete marks an intentionally non-persisted assistant turn", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Please try that again.",
      assistantEphemeral: true,
    });

    expect(harness.current[0]).toMatchObject({
      text: "Please try that again.",
      assistantEphemeral: true,
    });
  });

  it("complete stamps reasoning alongside the final text", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Done",
      reasoning: "Considered the options, picked the short answer.",
    });

    expect(harness.current[0].text).toBe("Done");
    expect(harness.current[0].reasoning).toBe(
      "Considered the options, picked the short answer.",
    );
  });

  it("complete stamps reasoning even when the text already matched", () => {
    const initial = [assistantMsg("a1", "Done")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Done",
      reasoning: "Late reasoning attached on the done event.",
    });

    expect(harness.current).not.toBe(initial);
    expect(harness.current[0].text).toBe("Done");
    expect(harness.current[0].reasoning).toBe(
      "Late reasoning attached on the done event.",
    );
  });

  it("complete swaps the streamed temp id to the persisted server id in place", () => {
    const initial = [
      userMsg("u1", "hi"),
      assistantMsg("temp-resp-1", "hello there"),
    ];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "temp-resp-1",
      mode: "complete",
      fullText: "hello there",
      persistedMessageId: "server-assistant-1",
    });

    expect(harness.current.map((m) => m.id)).toEqual([
      "u1",
      "server-assistant-1",
    ]);
    expect(harness.current[1].text).toBe("hello there");
  });

  it("rekey binds a durable user id without abusing assistant completion state", () => {
    const initial = [
      userMsg("temp-user-1", "hi"),
      assistantMsg("temp-resp-1", ""),
    ];
    initial[0].clientRenderId = "temp-user-1";
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "temp-user-1",
      mode: "rekey",
      persistedMessageId: "server-user-1",
    });

    expect(harness.current[0]).toMatchObject({
      id: "server-user-1",
      clientRenderId: "temp-user-1",
      role: "user",
      text: "hi",
    });
    expect(harness.current[1]).toBe(initial[1]);
  });

  it("complete id-swap drops an already-appended WS echo bubble carrying the persisted id", () => {
    // Action-callback turns persist + broadcast mid-turn, so the
    // proactive-message echo can land BEFORE the SSE `done` id-swap. The swap
    // must collapse the pair to one bubble at the streamed position.
    const initial = [
      userMsg("u1", "hi"),
      assistantMsg("temp-resp-1", "hello there"),
      assistantMsg("server-assistant-1", "hello there"),
    ];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "temp-resp-1",
      mode: "complete",
      fullText: "hello there",
      persistedMessageId: "server-assistant-1",
    });

    expect(harness.current.map((m) => m.id)).toEqual([
      "u1",
      "server-assistant-1",
    ]);
    expect(harness.current[1].text).toBe("hello there");
  });

  it("complete without persistedMessageId leaves the message id untouched", () => {
    const initial = [assistantMsg("temp-resp-1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "temp-resp-1",
      mode: "complete",
      fullText: "Done",
    });

    expect(harness.current[0].id).toBe("temp-resp-1");
    expect(harness.current[0].text).toBe("Done");
  });

  it("fail sets failureKind without touching text", () => {
    const initial = [assistantMsg("a1", "Streaming text")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "fail",
      failureKind: "no_provider",
    });

    expect(harness.current[0].text).toBe("Streaming text");
    expect(harness.current[0].failureKind).toBe("no_provider");
  });

  it("fail is idempotent when the same failureKind is already set", () => {
    const initial = [assistantMsg("a1", "x", { failureKind: "no_provider" })];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "fail",
      failureKind: "no_provider",
    });

    expect(harness.current).toBe(initial);
  });

  it("interrupt stamps the interrupted flag once", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "interrupt",
    });

    expect(harness.current[0].interrupted).toBe(true);

    const afterFirst = harness.current;
    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "interrupt",
    });
    expect(harness.current).toBe(afterFirst);
  });

  it("drop removes the assistant turn entirely", () => {
    const initial = [userMsg("u1", "hi"), assistantMsg("a1", "")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "drop",
    });

    expect(harness.current).toHaveLength(1);
    expect(harness.current[0].id).toBe("u1");
  });

  it("missing messageId returns the previous reference unchanged", () => {
    const initial = [assistantMsg("a1", "Hello")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "does-not-exist",
      mode: "replace",
      fullText: "ignored",
    });

    expect(harness.current).toBe(initial);
  });

  it("a no-op replace returns the previous reference unchanged", () => {
    const initial = [assistantMsg("a1", "same")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "replace",
      fullText: "same",
    });

    expect(harness.current).toBe(initial);
  });

  it("calls the setter exactly once per modification", () => {
    const setter = vi.fn<StreamingTextSetter>();
    setter.mockImplementation(() => undefined);

    applyStreamingTextModification(setter, {
      messageId: "a1",
      mode: "interrupt",
    });

    expect(setter).toHaveBeenCalledTimes(1);
  });
});
