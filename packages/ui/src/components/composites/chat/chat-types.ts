/**
 * Shared prop and data shapes for the chat composites: the `ChatVariant` skin,
 * the localizable `ChatLabelSet`, message/attachment/conversation records, and
 * voice-speaker types. The single source these sibling components import their
 * types from so their contracts stay in sync.
 */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import type {
  ChatFailureKind,
  ChatTerminalFailure,
  ChatTurnStatus,
  ConversationSecretRequest,
  MessageAttachment,
} from "../../../api/client-types-chat";
import type { NativeToolCallEvent } from "../../../api/client-types-cloud";

export type ChatVariant = "default" | "game-modal";

export interface ChatLabelSet {
  actions?: string;
  agentStarting?: string;
  agentVoiceOff?: string;
  agentVoiceOn?: string;
  attachImage?: string;
  cancel?: string;
  clearSearch?: string;
  chatIconLabel?: string;
  chats?: string;
  closePanel?: string;
  copied?: string;
  copiedAria?: string;
  copy?: string;
  delete?: string;
  deleteConfirm?: string;
  /** Eyebrow label on a proactive suggestion bubble (#8792). */
  suggestion?: string;
  /** Dismiss control on a proactive suggestion bubble (#8792). */
  dismiss?: string;
  /** Accept ("Do it") control on a proactive suggestion bubble (#8792). */
  acceptSuggestion?: string;
  deleteNo?: string;
  deleteYes?: string;
  edit?: string;
  expandChatsPanel?: string;
  inputPlaceholder?: string;
  inputPlaceholderNarrow?: string;
  listening?: string;
  micTitleIdleEnhanced?: string;
  micTitleIdleStandard?: string;
  newChat?: string;
  none?: string;
  noMatchingChats?: string;
  play?: string;
  releaseToSend?: string;
  rename?: string;
  /** Reply control on a message row — sets the composer to reply to it. */
  reply?: string;
  responseInterrupted?: string;
  saveAndResend?: string;
  searchChats?: string;
  saving?: string;
  send?: string;
  sendMessageTo?: string;
  startConversation?: string;
  stopGeneration?: string;
  stopListening?: string;
  stopSpeaking?: string;
  toBeginChatting?: string;
  voiceInput?: string;
}

export interface ChatAttachmentItem {
  alt: string;
  id: string;
  name: string;
  src: string;
  /** Attachment kind — drives the preview tile (image thumbnail vs file chip). */
  kind?: "image" | "audio" | "video" | "document";
}

export interface ChatMessageReaction {
  emoji: string;
  count: number;
  users?: string[];
}

/**
 * Voice speaker attribution metadata attached to a chat message. Populated
 * when the user message was captured via voice and R2's speaker-id pipeline
 * tagged the turn with an identified speaker.
 */
export interface ChatVoiceSpeaker {
  /** Stable entity id for the speaker. */
  entityId?: string;
  /** Human-friendly display name shown in the bubble header. */
  name?: string;
  /** Connector username/handle (fallback when `name` is missing). */
  userName?: string;
  /** True when this speaker has the OWNER role on the device. */
  isOwner?: boolean;
}

export interface ChatMessageData {
  avatarUrl?: string;
  /** Stable UI row identity across optimistic-to-durable id reconciliation. */
  clientRenderId?: string;
  from?: string;
  fromUserName?: string;
  id: string;
  interrupted?: boolean;
  reactions?: ChatMessageReaction[];
  replyToMessageId?: string;
  replyToSenderName?: string;
  replyToSenderUserName?: string;
  role: string;
  source?: string;
  text: string;
  /** Message creation time as epoch milliseconds, when the transport supplies it. */
  timestamp?: number;
  /** Voice speaker attribution when this message arrived via voice (R10 §4.1). */
  voiceSpeaker?: ChatVoiceSpeaker;
  /**
   * Server failure tag for a failed assistant turn. The glass (overlay) row
   * reads the recoverable kinds to offer its Retry pill; the panel surfaces
   * render failure gates in their body renderer instead.
   */
  failureKind?: ChatFailureKind;
  /** Authoritative typed failure details, including transient retry policy. */
  terminalFailure?: ChatTerminalFailure;
  /** Server confirms durable evidence supports regenerating only this reply. */
  replyRecoveryAvailable?: boolean;
  /** Media attached to this turn — read by body renderers and the in-flight
   * (empty assistant) detection; the row itself renders no attachment chrome. */
  attachments?: MessageAttachment[];
  /** Agent reasoning for this turn — read by body renderers (ThinkingBlock).
   * Transport-only on the row; the row renders no reasoning chrome itself. */
  reasoning?: string;
  /** Inline tool-call rows accumulated from the SSE `tool` events (#13535) —
   * read by body renderers (ToolCallEventLog). Transport-only on the row. */
  toolEvents?: NativeToolCallEvent[];
  /** Pending secret / OAuth request — read by body renderers (SensitiveRequestBlock). */
  secretRequest?: ConversationSecretRequest;
  /** Validated personal-workspace setup receipt rendered by the chat body. */
  capabilityHandoff?: CapabilityHandoffRequest;
}

/**
 * Volatile per-row values ChatMessage forwards to `renderContent` so the body
 * closure can stay referentially stable (identity changes in `renderContent`
 * re-render EVERY row; these fields are compared per-row by the memo instead).
 */
export interface ChatMessageRenderContext {
  /** Live phase status for the one in-flight (empty assistant) turn. */
  turnStatus?: ChatTurnStatus | null;
  /** Hide reasoning while this turn is still streaming. */
  suppressReasoning?: boolean;
}

export interface ChatMessageLabels extends ChatLabelSet {}

export interface ChatConversationSummary {
  avatarUrl?: string;
  id: string;
  title: string;
  updatedAtLabel?: string;
  /**
   * Optional connector source tag (e.g. "imessage", "telegram",
   * "discord", "whatsapp"). When set, the conversation item renders
   * a brand-colored channel pill next to the title so cross-channel
   * threads in a combined sidebar are visually distinct from the
   * agent's own dashboard conversations. Unknown sources fall back
   * to a neutral accent pill; dashboard conversations leave this
   * unset and get no pill at all.
   */
  source?: string;
}

export interface ChatConversationLabels extends ChatLabelSet {}
