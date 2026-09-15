/** Connects local developer chat to the normal app's canonical sender and live transcript, scoped to the same API authority. */
import { logger } from "@elizaos/logger";
import { useEffect, useRef } from "react";
import { client } from "../api";
import { useActiveAgentAuthority } from "../hooks/useActiveAgentAuthority";
import { isDeveloperWorkspaceRoute, pathForTab } from "../navigation";
import { dispatchConversationResync } from "./AppContext.hooks";
import { useAppSelectorShallow } from "./app-store";
import { useChatComposer } from "./ChatComposerContext.hooks";
import { useConversationMessages } from "./ConversationMessagesContext.hooks";
import { DeveloperTabBridge } from "./developer-tab-bridge";
import { deriveAgentReady } from "./types";

export function useDeveloperTabHost(): void {
  const authority = useActiveAgentAuthority();
  const state = useAppSelectorShallow((s) => ({
    tab: s.tab,
    conversationId: s.activeConversationId,
    send: s.sendChatText,
    stop: s.handleChatStop,
    select: s.handleSelectConversation,
    authRequired: s.authRequired,
    status: s.agentStatus,
  }));
  const { chatSending } = useChatComposer();
  const {
    conversationMessages,
    getConversationMessagesSnapshot,
    applyConversationMessageStream,
  } = useConversationMessages();
  const live = useRef({ state, chatSending });
  live.current = { state, chatSending };
  const bridge = useRef<DeveloperTabBridge | null>(null);
  useEffect(() => {
    if (
      !import.meta.env.DEV ||
      !getConversationMessagesSnapshot ||
      !applyConversationMessageStream ||
      typeof BroadcastChannel === "undefined" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)
    )
      return;
    let disposed = false;
    // Never publish credentials. Different backend/profile/token authorities
    // get different channel names, including when a login changes in one tab.
    const scope = JSON.stringify([
      authority.split("\u0000")[0],
      client.getBaseUrl() || window.location.origin,
      client.apiToken,
    ]);
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(scope))
      .then((digest) => {
        if (disposed) return;
        const channelName = `eliza-dev-app-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        bridge.current = new DeveloperTabBridge(
          new BroadcastChannel(channelName),
          {
            id: client.clientId,
            developer: isDeveloperWorkspaceRoute(),
            snapshot: () => ({
              path: pathForTab(live.current.state.tab),
              conversationId: live.current.state.conversationId,
            }),
            messageSnapshot: getConversationMessagesSnapshot,
            send: async (text, conversationId, requestId) => {
              if (
                live.current.chatSending ||
                live.current.state.authRequired ||
                !deriveAgentReady(live.current.state.status)
              )
                throw new Error("The app tab is busy or needs sign-in.");
              await live.current.state.select(conversationId);
              await live.current.state.send(text, {
                conversationId,
                clientMessageId: requestId,
              });
            },
            stop: () => live.current.state.stop(),
            messages: applyConversationMessageStream,
            settled: (conversationId) =>
              dispatchConversationResync({ conversationId }),
          },
        );
      })
      .catch((error: unknown) => {
        // error-policy:J4 the dev connection remains unavailable; ordinary app chat still works.
        logger.warn(
          "[developer-tab] Could not connect app tabs",
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => {
      disposed = true;
      bridge.current?.close();
      bridge.current = null;
    };
  }, [
    authority,
    getConversationMessagesSnapshot,
    applyConversationMessageStream,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered transcript changes trigger a fresh owner-checked snapshot, never relay a possibly stale render array.
  useEffect(() => {
    bridge.current?.stream();
  }, [conversationMessages]);
}

/** Isolate streamed-message subscriptions so tokens never rerender the App root. */
export function DeveloperTabHost() {
  useDeveloperTabHost();
  return null;
}
