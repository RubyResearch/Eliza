/** Relays developer chat to one same-authority app tab without replaying turns or broadcasting navigation to unrelated clients. */
import {
  type ConversationMessage,
  isConversationMessage,
} from "../api/client-types-chat";

export interface DeveloperAppPeer {
  id: string;
  path: string;
  conversationId: string | null;
}
export interface DeveloperTabState {
  peers: DeveloperAppPeer[];
  selectedId: string | null;
}
const EMPTY: DeveloperTabState = { peers: [], selectedId: null };
let state = EMPTY;
const listeners = new Set<() => void>();
let activeBridge: DeveloperTabBridge | null = null;
export const getDeveloperTabState = () => state;
export const subscribeDeveloperTabs = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(stateUpdate: DeveloperTabState) {
  state = stateUpdate;
  for (const listener of listeners) listener();
}
export function selectDeveloperAppTab(id: string) {
  publish({ ...state, selectedId: id });
}
export function sendToDeveloperAppTab(
  text: string,
  conversationId: string | null,
): Promise<void> {
  if (!activeBridge)
    return Promise.reject(new Error("The app-tab connection is not ready."));
  const target =
    state.peers.find((p) => p.id === state.selectedId) ??
    (state.peers.length === 1 ? state.peers[0] : undefined);
  if (!target)
    return Promise.reject(
      new Error("Open a normal app tab for this agent, then select it above."),
    );
  if (!conversationId)
    return Promise.reject(
      new Error("Select a conversation before sending to the app tab."),
    );
  return activeBridge.send(target.id, text, conversationId);
}
export function stopDeveloperAppTurn() {
  activeBridge?.stop();
}

interface Channel {
  postMessage(data: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}
interface Host {
  id: string;
  developer: boolean;
  snapshot(): Omit<DeveloperAppPeer, "id">;
  messageSnapshot(conversationId: string): ConversationMessage[] | undefined;
  send(text: string, conversationId: string, requestId: string): Promise<void>;
  stop(): void;
  messages(
    conversationId: string,
    changed: ConversationMessage[],
    removed: string[],
  ): void;
  settled(conversationId: string): void;
}
interface Pending {
  id: string;
  target: string;
  conversationId: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  accepted: boolean;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export class DeveloperTabBridge {
  private peers = new Map<string, DeveloperAppPeer & { seen: number }>();
  private pending: Pending | null = null;
  private running: {
    id: string;
    source: string;
    conversationId: string;
  } | null = null;
  private completed = new Set<string>();
  private previousMessages = new Map<string, ConversationMessage>();
  private heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private channel: Channel,
    private host: Host,
  ) {
    channel.addEventListener("message", this.receive);
    if (host.developer) {
      activeBridge = this;
      publish(EMPTY);
    }
    this.tick();
    this.heartbeat = setInterval(() => this.tick(), 2000);
  }
  private post(message: Record<string, unknown>) {
    if (!this.closed)
      this.channel.postMessage({ ...message, source: this.host.id });
  }
  private announce() {
    if (!this.host.developer)
      this.post({ kind: "peer", ...this.host.snapshot() });
  }
  private tick() {
    this.announce();
    if (this.host.developer) {
      this.post({ kind: "probe" });
      for (const [id, peer] of this.peers)
        if (Date.now() - peer.seen > 8000) this.peers.delete(id);
      this.updatePeers();
      if (this.pending?.accepted && !this.peers.has(this.pending.target))
        this.fail(
          "The app tab disconnected. The turn may still be running; check it before retrying.",
        );
    }
  }
  private updatePeers() {
    if (this.host.developer)
      publish({
        peers: [...this.peers.values()].map(({ seen: _seen, ...peer }) => peer),
        selectedId: state.selectedId,
      });
  }
  private fail(message: string) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error(message));
    this.pending = null;
  }
  send(target: string, text: string, conversationId: string): Promise<void> {
    if (this.pending)
      return Promise.reject(
        new Error("Wait for the current app-tab turn to finish."),
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            "The app tab did not acknowledge the prompt. Check that tab before retrying; this prompt was not automatically resent.",
          ),
        3000,
      );
      this.pending = {
        id,
        target,
        conversationId,
        resolve,
        reject,
        timer,
        accepted: false,
      };
      this.post({ kind: "send", target, id, text, conversationId });
    });
  }
  stop() {
    if (this.pending)
      this.post({
        kind: "stop",
        target: this.pending.target,
        id: this.pending.id,
      });
  }
  /** Diff actual renderer rows, including optimistic-to-durable ID replacement. */
  stream() {
    if (!this.running) return;
    const messages = this.host.messageSnapshot(this.running.conversationId);
    if (!messages) return;
    const next = new Map(messages.map((message) => [message.id, message]));
    const changed = messages.filter(
      (message) => this.previousMessages.get(message.id) !== message,
    );
    const removed = [...this.previousMessages.keys()].filter(
      (id) => !next.has(id),
    );
    this.previousMessages = next;
    if (changed.length || removed.length)
      this.post({
        kind: "messages",
        target: this.running.source,
        id: this.running.id,
        changed,
        removed,
      });
  }
  private receive = (event: MessageEvent<unknown>) => {
    const m = record(event.data);
    if (!m || typeof m.source !== "string" || m.source === this.host.id) return;
    if (m.kind === "probe") {
      this.announce();
      return;
    }
    if (
      m.kind === "peer" &&
      this.host.developer &&
      typeof m.path === "string" &&
      m.path.startsWith("/") &&
      !m.path.startsWith("//") &&
      (m.conversationId === null || typeof m.conversationId === "string")
    ) {
      this.peers.set(m.source, {
        id: m.source,
        path: m.path,
        conversationId: m.conversationId,
        seen: Date.now(),
      });
      this.updatePeers();
      return;
    }
    if (m.kind === "gone" && this.host.developer) {
      this.peers.delete(m.source);
      this.updatePeers();
      if (this.pending?.target === m.source)
        this.fail(
          "The app tab closed. Check the recorded turn before retrying.",
        );
      return;
    }
    if (m.target !== this.host.id || typeof m.id !== "string") return;
    if (this.host.developer) {
      const pending = this.pending;
      if (!pending || pending.id !== m.id || pending.target !== m.source)
        return;
      if (m.kind === "accepted") {
        pending.accepted = true;
        clearTimeout(pending.timer);
      }
      if (
        m.kind === "messages" &&
        Array.isArray(m.changed) &&
        m.changed.every(isConversationMessage) &&
        Array.isArray(m.removed) &&
        m.removed.every((id) => typeof id === "string")
      )
        this.host.messages(pending.conversationId, m.changed, m.removed);
      if (m.kind === "done" && typeof m.error === "string") {
        clearTimeout(pending.timer);
        this.pending = null;
        this.host.settled(pending.conversationId);
        if (m.error) pending.reject(new Error(m.error));
        else pending.resolve();
      }
      return;
    }
    if (
      m.kind === "stop" &&
      this.running?.id === m.id &&
      this.running.source === m.source
    ) {
      this.host.stop();
      return;
    }
    if (
      m.kind !== "send" ||
      typeof m.text !== "string" ||
      typeof m.conversationId !== "string" ||
      this.completed.has(m.id) ||
      this.running?.id === m.id
    )
      return;
    const { id, source, text, conversationId } = m as {
      id: string;
      source: string;
      text: string;
      conversationId: string;
    };
    if (this.running) {
      this.post({
        kind: "done",
        target: source,
        id,
        error: "The app tab is already handling another developer turn.",
      });
      return;
    }
    this.running = { id, source, conversationId };
    // Retain the pre-send baseline for synchronous ephemeral retirement, but
    // do not replay unchanged history over the developer tab's refreshed rows.
    this.previousMessages = new Map(
      (this.host.messageSnapshot(conversationId) ?? []).map((message) => [
        message.id,
        message,
      ]),
    );
    this.post({ kind: "accepted", target: source, id });
    void this.host
      .send(text, conversationId, id)
      .then(
        () => {
          this.stream();
          this.post({ kind: "done", target: source, id, error: "" });
        },
        (error: unknown) => {
          // error-policy:J4 relay the canonical sender failure; never retry a possibly effectful turn.
          this.stream();
          this.post({
            kind: "done",
            target: source,
            id,
            error:
              error instanceof Error
                ? error.message
                : "The app tab could not complete the turn.",
          });
        },
      )
      .finally(() => {
        this.completed.add(id);
        this.running = null;
        this.previousMessages.clear();
      });
  };
  close() {
    this.post({ kind: "gone" });
    this.closed = true;
    clearInterval(this.heartbeat);
    this.channel.removeEventListener("message", this.receive);
    this.channel.close();
    this.fail(
      "The selected agent or app-tab connection changed. Check the recorded turn before retrying.",
    );
    if (activeBridge === this) {
      activeBridge = null;
      publish(EMPTY);
    }
  }
}
