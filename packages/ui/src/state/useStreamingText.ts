/**
 * Streaming-text primitive for the chat reducer.
 *
 * The chat pipeline only ever does eight things to an in-flight assistant
 * turn while a stream is alive:
 *
 *   - append a token (delta)        → mode: "append"
 *   - replace text from a snapshot  → mode: "replace"
 *   - apply final reconciled text   → mode: "complete"
 *   - bind a durable domain id      → mode: "rekey"
 *   - merge an inline tool-call step → mode: "tool"
 *   - stamp a server failureKind    → mode: "fail"
 *   - mark the turn as interrupted  → mode: "interrupt"
 *   - drop an empty assistant turn  → mode: "drop"
 *
 * This primitive is the single map pass for all of them, so `useChatSend.ts` and
 * `useChatCallbacks.ts` share one equality check instead of each hand-rolling
 * `setMessages(prev => prev.map(...))`. The map pass:
 *
 *   - matches the target message by id,
 *   - returns the previous array unchanged when the modification produces
 *     no observable delta (referential equality preserved → no re-render),
 *   - supports the same updater-fn semantics as React's `setState`.
 *
 * It deliberately does nothing structural (no inserts, no reorders) — those
 * stay as direct `setConversationMessages` calls.
 */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import type { Dispatch, SetStateAction } from "react";
import type {
  AccountConnectRequest,
  ChatFailureKind,
  ChatTerminalFailure,
  ChatToolCallEvent,
  ConversationMessage,
} from "../api";
import { mergeChatToolEvent } from "../components/tool-events/chat-tool-events";
import { mergeStreamingText } from "./parsers";

export type StreamingTextSetter = Dispatch<
  SetStateAction<ConversationMessage[]>
>;

/**
 * One streaming-text mutation against a single in-flight assistant turn.
 *
 * `messageId` always identifies the assistant turn being modified. All other
 * fields are mode-specific.
 */
export type StreamingTextModification =
  | {
      messageId: string;
      mode: "append";
      /** Raw delta token from the SSE stream. */
      token: string;
      /** The delta is action-callback text the final reply may replace —
       *  stamped on the message so voice output holds it (double-speak fix). */
      provisional?: boolean;
    }
  | {
      messageId: string;
      mode: "replace";
      /** Cumulative snapshot text from the SSE stream. */
      fullText: string;
      /** The snapshot is action-callback text the final reply may replace —
       *  stamped on the message so voice output holds it (double-speak fix). */
      provisional?: boolean;
    }
  | {
      messageId: string;
      mode: "complete";
      /** Final reconciled assistant text from the server. */
      fullText: string;
      /** The transport settled, but generation ended before a complete reply. */
      interrupted?: boolean;
      /** Optional server-flagged failure class to stamp alongside the text. */
      failureKind?: ChatFailureKind;
      /** Authoritative terminal failure details from the runtime. */
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
      /**
       * Optional structured "connect another account" request to stamp on the
       * completed turn so the renderer can swap in the AccountConnectBlock.
       */
      accountConnect?: AccountConnectRequest;
      /** Validated personal-workspace setup receipt for this completed turn. */
      capabilityHandoff?: CapabilityHandoffRequest;
      /** Optional agent reasoning/thought to stamp on the completed turn. */
      reasoning?: string;
      /** The server intentionally did not persist this assistant turn. */
      assistantEphemeral?: boolean;
      /** Persisted server id replacing the optimistic temp-resp-* stream id. */
      persistedMessageId?: string;
      /** Server-confirmed user turn that owns this reply, including ephemeral failures. */
      replyToMessageId?: string;
    }
  | {
      messageId: string;
      mode: "rekey";
      /** Durable server id replacing an optimistic client id. */
      persistedMessageId: string;
    }
  | {
      messageId: string;
      mode: "tool";
      /** One inline tool-call lifecycle step (call → result/error). Merged onto
       *  the turn's `toolEvents` by `callId`; text is left untouched. */
      event: ChatToolCallEvent;
    }
  | {
      messageId: string;
      mode: "fail";
      /** Server-flagged failure class. Text is left untouched. */
      failureKind: ChatFailureKind;
      /** Authoritative terminal failure details from the runtime. */
      terminalFailure?: ChatTerminalFailure;
      replyRecoveryAvailable?: boolean;
    }
  | {
      messageId: string;
      mode: "interrupt";
    }
  | {
      messageId: string;
      mode: "drop";
    };

/**
 * Stamp or clear the `provisional` marker (action-callback text the final
 * reply may replace — held back from voice output). The latest frame is
 * authoritative: a non-provisional frame clears the marker so the reply can
 * be spoken the moment it lands.
 */
function withProvisional(
  message: ConversationMessage,
  provisional: boolean,
): ConversationMessage {
  if (provisional) {
    message.provisional = true;
    return message;
  }
  if (message.provisional !== undefined) delete message.provisional;
  return message;
}

/**
 * Compute the patched message for a single modification, or return `null`
 * if the modification produces no observable change.
 */
function computeNextMessage(
  message: ConversationMessage,
  mod: StreamingTextModification,
): ConversationMessage | null {
  switch (mod.mode) {
    case "append": {
      const nextText = mergeStreamingText(message.text, mod.token);
      if (
        nextText === message.text &&
        !mod.provisional === !message.provisional
      )
        return null;
      return withProvisional(
        { ...message, text: nextText },
        mod.provisional === true,
      );
    }
    case "replace": {
      if (
        mod.fullText === message.text &&
        !mod.provisional === !message.provisional
      )
        return null;
      return withProvisional(
        { ...message, text: mod.fullText },
        mod.provisional === true,
      );
    }
    case "complete": {
      const sameText = message.text === mod.fullText;
      const sameInterruption =
        (message.interrupted === true) === (mod.interrupted === true);
      const sameFailure = message.failureKind === mod.failureKind;
      const sameTerminalFailure =
        message.terminalFailure === mod.terminalFailure;
      const sameAccountConnect = message.accountConnect === mod.accountConnect;
      const sameCapabilityHandoff =
        message.capabilityHandoff === mod.capabilityHandoff;
      const sameReasoning =
        mod.reasoning === undefined || message.reasoning === mod.reasoning;
      const sameAssistantEphemeral =
        message.assistantEphemeral === mod.assistantEphemeral;
      const sameId =
        mod.persistedMessageId === undefined ||
        message.id === mod.persistedMessageId;
      const sameReplyTo =
        mod.replyToMessageId === undefined ||
        message.replyToMessageId === mod.replyToMessageId;
      if (
        sameText &&
        sameInterruption &&
        sameFailure &&
        sameTerminalFailure &&
        message.replyRecoveryAvailable === mod.replyRecoveryAvailable &&
        sameAccountConnect &&
        sameCapabilityHandoff &&
        sameReasoning &&
        sameAssistantEphemeral &&
        sameId &&
        sameReplyTo &&
        message.provisional === undefined
      ) {
        return null;
      }
      const next: ConversationMessage = withProvisional(
        {
          ...message,
          ...(mod.persistedMessageId ? { id: mod.persistedMessageId } : {}),
          ...(mod.replyToMessageId
            ? { replyToMessageId: mod.replyToMessageId }
            : {}),
          text: mod.fullText,
        },
        // Terminal text is no longer provisional; interruption remains a
        // separate status that prevents treating a partial as a complete reply.
        false,
      );
      if (mod.interrupted) {
        next.interrupted = true;
      } else if (message.interrupted !== undefined) {
        delete next.interrupted;
      }
      if (mod.failureKind) {
        next.failureKind = mod.failureKind;
      } else if (message.failureKind !== undefined) {
        delete next.failureKind;
      }
      if (mod.terminalFailure) {
        next.terminalFailure = mod.terminalFailure;
      } else if (message.terminalFailure !== undefined) {
        delete next.terminalFailure;
      }
      if (mod.replyRecoveryAvailable === true) {
        next.replyRecoveryAvailable = true;
      } else {
        delete next.replyRecoveryAvailable;
      }
      if (mod.accountConnect) {
        next.accountConnect = mod.accountConnect;
      } else if (message.accountConnect !== undefined) {
        delete next.accountConnect;
      }
      if (mod.capabilityHandoff) {
        next.capabilityHandoff = mod.capabilityHandoff;
      } else if (message.capabilityHandoff !== undefined) {
        delete next.capabilityHandoff;
      }
      if (mod.reasoning) {
        next.reasoning = mod.reasoning;
      }
      if (mod.assistantEphemeral) {
        next.assistantEphemeral = true;
      } else if (message.assistantEphemeral !== undefined) {
        delete next.assistantEphemeral;
      }
      return next;
    }
    case "rekey": {
      if (message.id === mod.persistedMessageId) return null;
      return { ...message, id: mod.persistedMessageId };
    }
    case "tool": {
      const nextEvents = mergeChatToolEvent(
        message.toolEvents ?? [],
        mod.event,
      );
      if (nextEvents === message.toolEvents) return null;
      return { ...message, toolEvents: nextEvents };
    }
    case "fail": {
      if (
        message.failureKind === mod.failureKind &&
        message.terminalFailure === mod.terminalFailure &&
        message.replyRecoveryAvailable === mod.replyRecoveryAvailable
      )
        return null;
      return {
        ...message,
        failureKind: mod.failureKind,
        replyRecoveryAvailable: mod.replyRecoveryAvailable,
        ...(mod.terminalFailure
          ? { terminalFailure: mod.terminalFailure }
          : {}),
      };
    }
    case "interrupt": {
      if (message.interrupted === true) return null;
      return { ...message, interrupted: true };
    }
    case "drop":
      // "drop" is a structural removal handled by the caller below — we
      // only get here if the message exists, in which case the array
      // changes by definition.
      return message;
  }
}

/**
 * Apply one streaming-text modification to the chat-message reducer.
 *
 * Returns referentially-equal `prev` when the modification is a no-op
 * (target id missing, text already matches, failureKind already set, etc.).
 */
export function applyStreamingTextModification(
  setMessages: StreamingTextSetter,
  mod: StreamingTextModification,
): void {
  setMessages((prev: ConversationMessage[]) => {
    if (mod.mode === "drop") {
      const filtered = prev.filter((message) => message.id !== mod.messageId);
      return filtered.length === prev.length ? prev : filtered;
    }

    let changed = false;
    let next = prev.map((message) => {
      if (message.id !== mod.messageId) return message;
      const patched = computeNextMessage(message, mod);
      if (patched === null) return message;
      changed = true;
      return patched;
    });
    // Id-swap dedupe: when terminal reconciliation rebinds a temp bubble to the
    // persisted server id, a proactive-message WS echo carrying that same
    // persisted id may have ALREADY appended its own bubble (action-callback
    // turns persist + broadcast mid-turn, before the SSE `done` arrives). Keep
    // only the FIRST occurrence — the swapped streamed bubble at the thread
    // position the user watched (echoes append after it) — and drop the copy.
    if (
      (mod.mode === "complete" || mod.mode === "rekey") &&
      mod.persistedMessageId !== mod.messageId
    ) {
      let seen = false;
      const deduped = next.filter((message) => {
        if (message.id !== mod.persistedMessageId) return true;
        if (seen) return false;
        seen = true;
        return true;
      });
      if (deduped.length !== next.length) {
        next = deduped;
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}
