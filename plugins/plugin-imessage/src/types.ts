/**
 * Type definitions for the iMessage plugin.
 */

import { type Service, truncateWellFormed } from "@elizaos/core";

/** Maximum message length for iMessage */
export const MAX_IMESSAGE_MESSAGE_LENGTH = 4000;

/** Default poll interval in ms */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** iMessage service name constant */
export const IMESSAGE_SERVICE_NAME = "imessage";

/**
 * Event types emitted by the iMessage plugin
 */
export const IMessageEventTypes = {
  MESSAGE_RECEIVED: "IMESSAGE_MESSAGE_RECEIVED",
  MESSAGE_SENT: "IMESSAGE_MESSAGE_SENT",
  REACTION_RECEIVED: "IMESSAGE_REACTION_RECEIVED",
  SYSTEM_EVENT: "IMESSAGE_SYSTEM_EVENT",
  CONNECTION_READY: "IMESSAGE_CONNECTION_READY",
  ERROR: "IMESSAGE_ERROR",
} as const;

export type IMessageEventType = (typeof IMessageEventTypes)[keyof typeof IMessageEventTypes];

/**
 * iMessage chat types
 */
export type IMessageChatType = "direct" | "group";

/**
 * Configuration settings for the iMessage plugin
 */
export interface IMessageSettings {
  /** Delivery bridge used by the connector. */
  transport: "native" | "blooio";
  /** Path to iMessage database */
  dbPath?: string;
  /** Polling interval in ms */
  pollIntervalMs: number;
  /** Heartbeat health-check interval in ms */
  heartbeatIntervalMs: number;
  /** DM policy */
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  /** Group policy */
  groupPolicy: "open" | "allowlist" | "disabled";
  /** Handles/phone numbers for allowlist */
  allowFrom: string[];
  /** Enable/disable the plugin */
  enabled: boolean;
  /** Blooio API credential, required by the Blooio transport. */
  blooioApiKey?: string;
  /** Secret used to authenticate Blooio webhook deliveries. */
  blooioWebhookSecret?: string;
  /** Blooio sender phone number. */
  blooioFromNumber?: string;
  /** Provider channel allowed to deliver into this agent. */
  blooioChannelId?: string;
}

/**
 * iMessage contact
 */
export interface IMessageContact {
  /** Handle (phone number or email) */
  handle: string;
  /** Display name */
  displayName?: string;
  /** Is this a phone number? */
  isPhoneNumber: boolean;
}

/**
 * iMessage chat
 */
export interface IMessageChat {
  /** Chat ID */
  chatId: string;
  /** Chat type */
  chatType: IMessageChatType;
  /** Display name */
  displayName?: string;
  /** Participants */
  participants: IMessageContact[];
}

/**
 * iMessage message
 */
export interface IMessageMessage {
  /** Message ID (ROWID) */
  id: string;
  /** Message text */
  text: string;
  /** Sender handle */
  handle: string;
  /** Chat ID */
  chatId: string;
  /** Timestamp */
  timestamp: number;
  /** Is from me */
  isFromMe: boolean;
  /** Has attachments */
  hasAttachments: boolean;
  /** Attachment paths */
  attachmentPaths?: string[];
}

export interface IMessageListMessagesOptions {
  /** Return only messages from this chat identifier. */
  chatId?: string;
  /** Maximum number of rows to return. */
  limit?: number;
}

/**
 * Options for sending a message
 */
export interface IMessageSendOptions {
  /** Connector account ID. iMessage currently supports only the local default account. */
  accountId?: string;
  /** Media URL or path to attach */
  mediaUrl?: string;
  /** Max bytes for media */
  maxBytes?: number;
}

/**
 * Result from sending a message
 */
export interface IMessageSendResult {
  success: boolean;
  /** Last observed provider receipt, never a locally generated identifier. */
  messageId?: string;
  /** Ordered provider receipts, including accepted chunks before a later failure. */
  messageIds?: string[];
  chatId?: string;
  error?: string;
}

export interface IMessagePermissionAction {
  type: "full_disk_access";
  label: string;
  url: string;
  instructions: string[];
}

export interface IMessageServiceStatus {
  transport: "native" | "blooio";
  available: boolean;
  connected: boolean;
  chatDbAvailable: boolean;
  sendOnly: boolean;
  chatDbPath: string;
  reason: string | null;
  permissionAction: IMessagePermissionAction | null;
  webhookPath: string | null;
  channelId: string | null;
}

/**
 * Service interface for iMessage
 */
export interface IIMessageService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get structured readiness for UI/API callers */
  getStatus(): IMessageServiceStatus;

  /** Check if running on macOS */
  isMacOS(): boolean;

  /** Send a message */
  sendMessage(to: string, text: string, options?: IMessageSendOptions): Promise<IMessageSendResult>;

  /** Get recent messages */
  getRecentMessages(limit?: number): Promise<IMessageMessage[]>;

  /** List newest messages, optionally filtered to one chat. */
  getMessages(options?: IMessageListMessagesOptions): Promise<IMessageMessage[]>;

  /** Get chats */
  getChats(): Promise<IMessageChat[]>;

  /** Authenticate and dispatch one Blooio webhook delivery. */
  handleBlooioWebhook(
    rawBody: string,
    signature: string | undefined
  ): Promise<"accepted" | "ignored" | "unauthorized">;
}

/**
 * iMessage plugin errors
 */
export class IMessagePluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "IMessagePluginError";
  }
}

export class IMessageConfigurationError extends IMessagePluginError {
  constructor(message: string, setting?: string) {
    super(message, "CONFIGURATION_ERROR", setting ? { setting } : undefined);
    this.name = "IMessageConfigurationError";
  }
}

export class IMessageNotSupportedError extends IMessagePluginError {
  constructor(message: string = "iMessage is only supported on macOS") {
    super(message, "NOT_SUPPORTED");
    this.name = "IMessageNotSupportedError";
  }
}

// Utility functions

/**
 * Check if a string looks like a phone number
 */
export function isPhoneNumber(input: string): boolean {
  // Remove common formatting
  const cleaned = input.replace(/[\s\-().]/g, "");
  // Check if it's a phone number pattern
  return /^\+?\d{10,15}$/.test(cleaned);
}

/**
 * Check if a string looks like an email
 */
export function isEmail(input: string): boolean {
  const at = input.indexOf("@");
  if (at <= 0 || at !== input.lastIndexOf("@")) return false;
  const dot = input.indexOf(".", at + 2);
  if (dot < 0 || dot === input.length - 1) return false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "@") continue;
    if (character?.trim() === "") return false;
  }
  return true;
}

/**
 * Check if a string is a valid iMessage target (phone or email)
 */
export function isValidIMessageTarget(target: string): boolean {
  const trimmed = target.trim();
  return isPhoneNumber(trimmed) || isEmail(trimmed) || trimmed.startsWith("chat_id:");
}

/**
 * Normalize an iMessage target
 */
export function normalizeIMessageTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  // Handle chat_id: prefix
  if (trimmed.startsWith("chat_id:")) {
    return trimmed;
  }

  // Handle imessage: prefix
  if (trimmed.toLowerCase().startsWith("imessage:")) {
    return trimmed.slice(9).trim();
  }

  // Return as-is for phone numbers and emails
  return trimmed;
}

/**
 * Format a phone number for iMessage
 */
export function formatPhoneNumber(phone: string): string {
  // Remove formatting
  let cleaned = phone.replace(/[\s\-().]/g, "");

  // Add + prefix if missing for international
  if (cleaned.length > 10 && !cleaned.startsWith("+")) {
    cleaned = `+${cleaned}`;
  }

  return cleaned;
}

/**
 * Split text for iMessage
 */
// truncateWellFormed(text, 1) returns "" when text opens with a surrogate
// pair (backing the one-unit cut off to 0): an astral scalar needs both
// code units to stay well-formed, so no head chunk can honor a 1-unit
// bound without either splitting the pair or producing nothing. Widening
// by exactly one unit in that single case keeps the caller making forward
// progress instead of looping forever on an empty chunk; every other
// bound is unaffected since truncateWellFormed only ever backs off by one
// unit, which stays non-empty for any limit >= 2.
function takeAtLeastOneUnit(text: string, limit: number): string {
  const chunk = truncateWellFormed(text, limit);
  return chunk.length > 0 ? chunk : truncateWellFormed(text, limit + 1);
}

export function splitMessageForIMessage(
  text: string,
  maxLength: number = MAX_IMESSAGE_MESSAGE_LENGTH
): string[] {
  if (!Number.isFinite(maxLength) || maxLength < 1) {
    throw new Error(
      `splitMessageForIMessage: maxLength must be a positive finite number, got ${maxLength}`
    );
  }
  const limit = Math.floor(maxLength);

  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = limit;

    // Try newline first
    const newlineIdx = remaining.lastIndexOf("\n", limit);
    if (newlineIdx > limit / 2) {
      breakPoint = newlineIdx + 1;
    } else {
      // Try space
      const spaceIdx = remaining.lastIndexOf(" ", limit);
      if (spaceIdx > limit / 2) {
        breakPoint = spaceIdx + 1;
      }
    }

    // truncateWellFormed backs the cut off by one unit instead of splitting
    // a surrogate pair (emoji) when no newline/space break point was found.
    const head = takeAtLeastOneUnit(remaining, breakPoint);
    chunks.push(head.trimEnd());
    remaining = remaining.slice(head.length).trimStart();
  }

  return chunks;
}
