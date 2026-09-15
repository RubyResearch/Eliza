/**
 * ConversationMessagesContext — isolated context for the active conversation's
 * message list.
 *
 * conversationMessages gets a new array reference on every streamed token while
 * the agent is responding. Keeping it in the giant AppContext value would
 * cascade those per-token updates to every useApp() subscriber (~135 of them:
 * sidebars, settings panels, the companion overlay, etc.). This dedicated
 * context lets only the chat surfaces (ChatView and the shell controller that
 * drives ChatOverlay) re-render as tokens arrive.
 *
 * The context object + hook live here (not in the sibling AppContext.tsx) so the
 * Provider file stays React Fast Refresh-compatible.
 */

import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useContext,
} from "react";
import type { ConversationMessage } from "../api";

export interface ConversationMessagesValue {
  conversationMessages: ConversationMessage[];
  /**
   * Remove a single message from the live transcript by id (#8792). Used to
   * dismiss a proactive suggestion locally without a server round-trip.
   */
  removeConversationMessage: (messageId: string) => void;
  /**
   * Mutate the live transcript directly (supports the functional updater form).
   * Used by the in-chat first-run conductor to seed synthetic onboarding
   * assistant turns into the SAME transcript the floating chat renders. Stable
   * identity.
   */
  setConversationMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  /** Synchronous rows only when this conversation owns the visible content. */
  getConversationMessagesSnapshot?: (
    conversationId: string,
  ) => ConversationMessage[] | undefined;
  /** Apply a same-authority stream using the canonical history overlay registry. */
  applyConversationMessageStream?: (
    conversationId: string,
    changed: ConversationMessage[],
    removed: string[],
  ) => void;
  /**
   * Prepend an older page in front of the transcript for infinite upward
   * scroll (#13532). Dedupes by id and caps the retained count; stable identity.
   */
  prependConversationMessages?: (older: ConversationMessage[]) => void;
}

export interface UseConversationMessagesValue
  extends ConversationMessagesValue {
  prependConversationMessages: (older: ConversationMessage[]) => void;
}

const noopPrependConversationMessages = () => {};

export const ConversationMessagesCtx = createContext<ConversationMessagesValue>(
  {
    conversationMessages: [],
    removeConversationMessage: () => {},
    setConversationMessages: () => {},
    prependConversationMessages: noopPrependConversationMessages,
  },
);

export function useConversationMessages(): UseConversationMessagesValue {
  const value = useContext(ConversationMessagesCtx);
  return {
    ...value,
    prependConversationMessages:
      value.prependConversationMessages ?? noopPrependConversationMessages,
  };
}
