/** Exercises the actual tab relay protocol over an in-memory channel: target binding, duplicate suppression, streamed rows, stop, and disconnects. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api/client-types-chat";
import { DeveloperTabBridge } from "./developer-tab-bridge";

const channels = new Set<TestChannel>();
const bridges: DeveloperTabBridge[] = [];
class TestChannel {
  handlers = new Set<(event: MessageEvent<unknown>) => void>();
  sent: Record<string, unknown>[] = [];
  constructor(readonly scope = "same-authority") {
    channels.add(this);
  }
  postMessage(data: Record<string, unknown>) {
    this.sent.push(data);
    for (const channel of channels)
      if (channel !== this && channel.scope === this.scope) {
        for (const handler of channel.handlers)
          handler({ data: structuredClone(data) } as MessageEvent<unknown>);
      }
  }
  addEventListener(
    _type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ) {
    this.handlers.add(handler);
  }
  removeEventListener(
    _type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ) {
    this.handlers.delete(handler);
  }
  close() {
    channels.delete(this);
  }
}
function mount(id: string, developer: boolean, scope?: string) {
  const channel = new TestChannel(scope);
  let finish: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  let messages: ConversationMessage[] | undefined;
  const host = {
    id,
    developer,
    snapshot: () => ({ path: "/notes", conversationId: "conv" }),
    messageSnapshot: vi.fn(() => messages),
    send: vi.fn(
      (_text: string, _conversationId: string, _requestId: string) =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    ),
    stop: vi.fn(),
    messages: vi.fn(),
    settled: vi.fn(),
  };
  const bridge = new DeveloperTabBridge(channel, host);
  bridges.push(bridge);
  return {
    bridge,
    host,
    channel,
    finish: () => finish(),
    fail: (error: Error) => fail(error),
    setMessages: (rows: ConversationMessage[] | undefined) => {
      messages = rows;
    },
    stream: (rows: ConversationMessage[]) => {
      messages = rows;
      bridge.stream();
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  channels.clear();
  vi.useRealTimers();
});

describe("developer app-tab relay", () => {
  it("sends once through only the chosen app and preserves the conversation/idempotency key", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "Open Notes", "conv");
    expect(app.host.send).toHaveBeenCalledExactlyOnceWith(
      "Open Notes",
      "conv",
      expect.any(String),
    );
    expect(other.host.send).not.toHaveBeenCalled();
    const request = dev.channel.sent.find((m) => m.kind === "send");
    if (!request) throw new Error("Missing send");
    dev.channel.postMessage(request);
    expect(app.host.send).toHaveBeenCalledTimes(1);
    app.finish();
    await promise;
    expect(dev.host.settled).toHaveBeenCalledExactlyOnceWith("conv");
  });

  it("isolates other API authorities and never falls back or automatically resends", async () => {
    const app = mount("app", false, "other-authority");
    const dev = mount("dev", true);
    const rejected = expect(
      dev.bridge.send("app", "do it", "conv"),
    ).rejects.toThrow("not automatically resent");
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(app.host.send).not.toHaveBeenCalled();
    expect(dev.channel.sent.filter((m) => m.kind === "send")).toHaveLength(1);
  });

  it("relays only changed renderer rows and their removals for the active request", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    const user: ConversationMessage = {
      id: "optimistic-user",
      role: "user",
      text: "hello",
      timestamp: 1,
    };
    app.stream([user]);
    app.stream([user]);
    expect(dev.host.messages).toHaveBeenCalledTimes(1);
    const durable = { ...user, id: "durable-user" };
    app.stream([durable]);
    expect(dev.host.messages).toHaveBeenLastCalledWith(
      "conv",
      [durable],
      ["optimistic-user"],
    );
    app.finish();
    await promise;
  });

  it("does not replay unchanged pre-send history over the developer transcript", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const old: ConversationMessage = {
      id: "durable-prior-reply",
      role: "assistant",
      text: "Earlier reply",
      timestamp: 1,
    };
    app.setMessages([old]);
    const promise = dev.bridge.send("app", "hello", "conv");
    try {
      // An app tab may retain an older snapshot of a row already refreshed in
      // dev. Starting a new turn does not make that history a new stream update.
      expect(dev.host.messages).not.toHaveBeenCalled();
      const user: ConversationMessage = {
        id: "optimistic-user",
        role: "user",
        text: "hello",
        timestamp: 2,
      };
      app.stream([old, user]);
      expect(dev.host.messages).toHaveBeenCalledExactlyOnceWith(
        "conv",
        [user],
        [],
      );
      const updated = { ...old, text: "Authoritative updated reply" };
      app.stream([updated, user]);
      expect(dev.host.messages).toHaveBeenLastCalledWith("conv", [updated], []);
    } finally {
      app.finish();
      await promise;
    }
  });

  it("binds stop to the selected app and in-flight request", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    dev.bridge.stop();
    expect(app.host.stop).toHaveBeenCalledOnce();
    expect(other.host.stop).not.toHaveBeenCalled();
    app.finish();
    await promise;
  });

  it("relays removal of an ephemeral reply retired synchronously by the next send", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const failed: ConversationMessage = {
      id: "temp-failure",
      role: "assistant",
      text: "Try again.",
      timestamp: 1,
      assistantEphemeral: true,
      replyToMessageId: "first-user",
    };
    app.setMessages([failed]);
    // The sender can retire the previous reply before React emits another
    // transcript snapshot. The relay needs the pre-send removal baseline.
    app.host.send.mockImplementationOnce(async () => {
      app.setMessages([]);
    });
    await dev.bridge.send("app", "hello", "conv");
    expect(dev.host.messages).toHaveBeenLastCalledWith("conv", [], [failed.id]);
  });

  it.each([false, true])(
    "flushes a final ephemeral reply before settlement even without another render (sender rejects: %s)",
    async (rejects) => {
      const app = mount("app", false);
      const dev = mount("dev", true);
      const promise = dev.bridge.send("app", "hello", "conv");
      const expected = rejects
        ? expect(promise).rejects.toThrow("stream failed")
        : promise;
      const reply: ConversationMessage = {
        id: "temp-final",
        clientRenderId: "temp-final",
        role: "assistant",
        text: "The model context is too large; nothing was changed.",
        timestamp: 2,
      };
      app.setMessages([reply]);
      // The sender commits synchronously, then resolves before React's stream effect.
      if (rejects) app.fail(new Error("stream failed"));
      else app.finish();
      await expected;
      expect(app.host.messageSnapshot).toHaveBeenCalledWith("conv");
      expect(dev.host.messages).toHaveBeenCalledExactlyOnceWith(
        "conv",
        [reply],
        [],
      );
      expect(app.channel.sent.map((m) => m.kind).slice(-2)).toEqual([
        "messages",
        "done",
      ]);
      expect(dev.host.messages.mock.invocationCallOrder[0]).toBeLessThan(
        dev.host.settled.mock.invocationCallOrder[0],
      );
    },
  );

  it("does not flush a transcript whose conversation ownership was released", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    app.setMessages(undefined);
    app.finish();
    await promise;
    expect(app.host.messageSnapshot).toHaveBeenCalledWith("conv");
    expect(dev.host.messages).not.toHaveBeenCalled();
    expect(dev.host.settled).toHaveBeenCalledExactlyOnceWith("conv");
  });

  it("rejects on target close with an uncertain-outcome warning instead of replaying", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const rejected = expect(
      dev.bridge.send("app", "do it", "conv"),
    ).rejects.toThrow("Check the recorded turn");
    app.bridge.close();
    await rejected;
    expect(app.host.send).toHaveBeenCalledOnce();
    app.finish();
  });

  it("ignores malformed rows and messages from a different app", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    const id = app.host.send.mock.calls[0]?.[2];
    other.channel.postMessage({
      source: "other",
      target: "dev",
      id,
      kind: "done",
      error: "",
    });
    app.channel.postMessage({
      source: "app",
      target: "dev",
      id,
      kind: "messages",
      changed: [{ id: "bad" }],
      removed: [],
    });
    expect(dev.host.settled).not.toHaveBeenCalled();
    expect(dev.host.messages).not.toHaveBeenCalled();
    app.finish();
    await promise;
  });
});
