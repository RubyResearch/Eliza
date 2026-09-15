/**
 * Per-account inbound and outbound message handling for a Telegram bot: ingests
 * text, media, and document attachments from Telegraf update contexts, routes
 * them through the runtime, and dispatches agent replies back to Telegram.
 *
 * Inbound media is transcribed/described and normalized to core `Media`;
 * attachments persist a token-free `telegram-file:<file_id>` capability
 * reference, never the `getFileLink` URL (which embeds the bot token) — bytes
 * are resolved transiently at fetch/enrichment time inside this module.
 * Outbound replies are converted to MarkdownV2 (`utils.ts`), split at Telegram's
 * 4096-char limit, rendered with inline keyboards (`interactions.ts`), and
 * role-gated for embedded-app launch buttons. Owned by `TelegramService`, which
 * registers this as the connector's send path.
 */
import fs from "node:fs";
import {
  buildInteractionUrlResolver,
  ChannelType,
  type Content,
  type ContentType,
  createUniqueUuid,
  decodeCallback,
  ElizaError,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  logger,
  type Media,
  type Memory,
  type MessagePayload,
  ModelType,
  type ResolvedAttachmentBytes,
  resolveAttachmentBytes,
  type SendHandlerOutcome,
  type SendHandlerReceipt,
  ServiceType,
  toWellFormedUnicode,
  truncateWellFormed,
  type UUID,
} from "@elizaos/core";
import type {
  Chat,
  Document,
  InlineKeyboardButton,
  Message,
  ReactionType,
  Update,
} from "@telegraf/types";
import type { Context, NarrowedContext, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { resolveTelegramSenderAuth } from "./command-registration";
import {
  resolveTelegramRuntimeEntityId,
  telegramIdentityMetadata,
} from "./identity";
import { renderTelegramInteractions } from "./interactions";
import {
  type TelegramContent,
  TelegramEventTypes,
  type TelegramMessageSentPayload,
  type TelegramReactionReceivedPayload,
} from "./types";
import {
  cleanText,
  convertMarkdownToTelegram,
  convertToTelegramButtons,
} from "./utils";

/**
 * Interface for structured document processing results.
 */
interface DocumentProcessingResult {
  title: string;
  fullText: string;
  formattedDescription: string;
  fileName: string;
  mimeType: string | undefined;
  fileSize: number | undefined;
  error?: string;
}

/**
 * Enum representing different types of media.
 * @enum { string }
 * @readonly
 */
export enum MediaType {
  PHOTO = "photo",
  VIDEO = "video",
  DOCUMENT = "document",
  AUDIO = "audio",
  ANIMATION = "animation",
}

/**
 * Map a Telegram file's MIME type to the coarse core ContentType. Returns the
 * literal string values (not the `ContentType` enum object) so this stays a
 * pure, dependency-free mapping — `ContentType` is imported as a type only.
 */
function contentTypeForMime(mime?: string): ContentType {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Scheme prefix for the token-free capability reference persisted on inbound
 * media attachments. Telegram `getFileLink` URLs embed the bot token
 * (`https://api.telegram.org/file/bot<TOKEN>/<path>`), so persisting them
 * would plant the operator's full-control credential in the message store for
 * any texter to read back. Memories carry only `telegram-file:<file_id>`; the
 * token is introduced transiently, in memory only, at fetch time inside
 * {@link MessageManager.fetchTelegramFileBytes}.
 */
export const TELEGRAM_FILE_REF_PREFIX = "telegram-file:";

/** Build the stored capability reference for a Telegram file id. */
export function telegramFileRefUrl(fileId: string): string {
  return `${TELEGRAM_FILE_REF_PREFIX}${fileId}`;
}

/** Extract the file id from a stored capability reference, else null. */
export function telegramFileIdFromRef(url: string | undefined): string | null {
  if (!url?.startsWith(TELEGRAM_FILE_REF_PREFIX)) return null;
  const fileId = url.slice(TELEGRAM_FILE_REF_PREFIX.length);
  return fileId.length > 0 ? fileId : null;
}

/**
 * `resolveAttachmentBytes` for a token-bearing Bot API file URL. Core's
 * `MediaFetchError` messages embed the fetched URL, which for Telegram is the
 * `getFileLink` URL carrying the bot token — rethrow with only the failure
 * code so a failed download can never write the credential to a log sink.
 */
function sanitizedTelegramFileError(error: unknown): ElizaError {
  const fetchCode =
    error instanceof Error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "unknown";
  const cause = new Error(`Telegram media fetch failed (${fetchCode})`);
  cause.name = error instanceof Error ? error.name : "MediaFetchError";
  return new ElizaError("Telegram file download failed", {
    code: "TELEGRAM_FILE_DOWNLOAD_FAILED",
    cause,
    context: { fetchCode },
  });
}

async function resolveTelegramFileBytes(
  url: string,
): Promise<ResolvedAttachmentBytes> {
  try {
    return await resolveAttachmentBytes(url);
  } catch (error) {
    // error-policy:J2 Preserve a sanitized transport classification without
    // retaining the token-bearing URL in the message, cause, or context.
    throw sanitizedTelegramFileError(error);
  }
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length
const MAX_MEDIA_CAPTION_LENGTH = 1024;
const INTERACTION_ONLY_FALLBACK_TEXT = "Choose an option:";
const ACTION_PROGRESS_SOURCE = "action_progress";
const COMPUTER_USE_APPROVAL_CALLBACK_RE =
  /^cua:([^:]+):(approve|deny)(?::u([^:]+))?$/;

type PdfTextService = {
  convertPdfToText(pdfBuffer: Buffer): Promise<string>;
};

type TelegramMessageEditor = (
  chatId: number | string,
  messageId: number,
  text: string,
  messageThreadId?: number,
) => Promise<void>;

type CompactProgressCallbackOptions = {
  baseCallback: HandlerCallback;
  editMessage: TelegramMessageEditor;
  chatId: number | string;
  threadId?: number;
};

type ComputerUseApprovalCallback = {
  approvalId: string;
  approved: boolean;
  ownerId?: string;
};

type ComputerUseApprovalResolver = {
  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): unknown | Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCompactProgressContent(
  content: Content,
): content is Content & { text: string } {
  if (!content.text || content.source !== ACTION_PROGRESS_SOURCE) {
    return false;
  }
  const metadata = isRecord(content.metadata) ? content.metadata : {};
  return metadata.compactProgress === true;
}

function telegramMessageIdFromMemory(memory: Memory): number | null {
  const metadata = isRecord(memory.metadata) ? memory.metadata : {};
  const telegram = isRecord(metadata.telegram) ? metadata.telegram : undefined;
  const rawMessageId =
    telegram?.messageId ??
    metadata.messageIdFull ??
    metadata.messageId ??
    undefined;
  const numeric =
    typeof rawMessageId === "string" || typeof rawMessageId === "number"
      ? Number(rawMessageId)
      : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function isComputerUseApprovalResolver(
  service: unknown,
): service is ComputerUseApprovalResolver {
  return isRecord(service) && typeof service.resolveApproval === "function";
}

export function parseComputerUseApprovalCallback(
  value: string,
): ComputerUseApprovalCallback | null {
  const match = value.match(COMPUTER_USE_APPROVAL_CALLBACK_RE);
  if (!match) return null;
  const parsed: ComputerUseApprovalCallback = {
    approvalId: match[1],
    approved: match[2] === "approve",
  };
  if (match[3]) {
    parsed.ownerId = match[3];
  }
  return parsed;
}

export function createTelegramCompactProgressCallback({
  baseCallback,
  editMessage,
  chatId,
  threadId,
}: CompactProgressCallbackOptions): HandlerCallback {
  let statusMessageId: number | null = null;

  return async (content, actionName) => {
    if (!isCompactProgressContent(content)) {
      return baseCallback(content, actionName);
    }

    const text = content.text;
    if (statusMessageId !== null) {
      try {
        await editMessage(chatId, statusMessageId, text, threadId);
        return [];
      } catch (error) {
        logger.warn(
          {
            src: "plugin:telegram",
            chatId,
            messageId: statusMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to edit compact progress message; sending a new update",
        );
      }
    }

    const memories = await baseCallback(content, actionName);
    for (const memory of memories) {
      const messageId = telegramMessageIdFromMemory(memory);
      if (messageId !== null) {
        statusMessageId = messageId;
        break;
      }
    }
    return memories;
  };
}

function isPdfTextService(service: unknown): service is PdfTextService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { convertPdfToText?: unknown }).convertPdfToText ===
      "function"
  );
}

type TelegramMediaSender = (
  chatId: number | string,
  media: string | { source: fs.ReadStream },
  extra?: { caption?: string },
) => Promise<unknown>;

const getChannelType = (chat: Chat): ChannelType => {
  const chatType = chat.type;

  // Use a switch statement for clarity and exhaustive checks
  switch (chatType) {
    case "private":
      return ChannelType.DM;
    case "group":
    case "supergroup":
    case "channel":
      return ChannelType.GROUP;
    default:
      throw new Error(`Unrecognized Telegram chat type: ${String(chatType)}`);
  }
};

/** Label on the embedded-app (Telegram Mini App) launch button. */
const EMBED_LAUNCH_BUTTON_TEXT = "Open Eliza App";

/**
 * Resolve the embedded-app `/embed` launch URL for the role-gated Mini App
 * button (#9947). Reads the explicit `ELIZA_EMBED_URL` if set, otherwise
 * derives `<web base>/embed` from `ELIZA_APP_URL` / `ELIZA_CLOUD_URL`. Returns
 * `undefined` when nothing is configured or the resolved URL is not absolute
 * `https` — Telegram rejects `web_app` buttons that are not https, so the
 * button is simply not emitted rather than sent with an invalid URL.
 */
function resolveEmbedLaunchUrl(runtime: IAgentRuntime): string | undefined {
  const direct = runtime.getSetting("ELIZA_EMBED_URL");
  if (typeof direct === "string" && direct.trim().length > 0) {
    return toHttpsUrl(direct.trim(), "telegram");
  }
  const base =
    runtime.getSetting("ELIZA_APP_URL") ||
    runtime.getSetting("ELIZA_CLOUD_URL");
  if (typeof base === "string" && base.trim().length > 0) {
    return toHttpsUrl(`${base.trim().replace(/\/+$/, "")}/embed`, "telegram");
  }
  return undefined;
}

/** Return the URL only when it parses as absolute `https`, else `undefined`. */
function toHttpsUrl(url: string, platform: "telegram"): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/embed";
  }
  parsed.searchParams.set("platform", platform);
  return parsed.toString();
}

/** Build the Telegram `web_app` inline-keyboard button for the `/embed` route. */
function buildEmbedLaunchButton(url: string): InlineKeyboardButton {
  return { text: EMBED_LAUNCH_BUTTON_TEXT, web_app: { url } };
}

/** Carries observed provider acceptance without turning subsequent failure into permission to resend. */
class TelegramOutboundEvidenceError extends ElizaError {
  constructor(
    readonly phase: "transport" | "persistence",
    readonly acceptedMessages: readonly Message.TextMessage[],
    readonly persistedMemories: readonly Memory[],
    cause: unknown,
    accountId: string,
    chatId: string,
  ) {
    super("Telegram accepted messages before outbound processing failed", {
      code:
        phase === "transport"
          ? "TELEGRAM_PARTIAL_DELIVERY"
          : "TELEGRAM_OUTBOUND_PERSIST_FAILED",
      cause,
      context: {
        accountId,
        chatId,
        providerMessageIds: acceptedMessages.map((message) =>
          String(message.message_id),
        ),
      },
    });
  }
}

function telegramMemoryId(memory: Memory): UUID {
  if (!memory.id)
    throw new ElizaError("Persisted Telegram memory has no identifier", {
      code: "TELEGRAM_MEMORY_ID_MISSING",
    });
  return memory.id;
}

function telegramReceipt(
  messages: readonly Message.TextMessage[],
  memories: readonly Memory[],
): SendHandlerReceipt {
  const [first, ...rest] = messages;
  if (!first)
    throw new ElizaError("Telegram delivery has no accepted provider message", {
      code: "TELEGRAM_RECEIPT_MISSING",
    });
  return {
    providerMessageIds: [
      String(first.message_id),
      ...rest.map((message) => String(message.message_id)),
    ],
    acceptedAt: messages.reduce(
      (latest, message) => Math.max(latest, message.date * 1000),
      first.date * 1000,
    ),
    persistence: {
      status: "persisted",
      memoryIds: memories.map(telegramMemoryId),
    },
  };
}

export class MessageManager {
  public bot: Telegraf<Context>;
  protected runtime: IAgentRuntime;
  protected accountId: string;

  /**
   * Constructor for creating a new instance of a BotAgent.
   *
   * @param {Telegraf<Context>} bot - The Telegraf instance used for interacting with the bot platform.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  constructor(
    bot: Telegraf<Context>,
    runtime: IAgentRuntime,
    accountId = "default",
  ) {
    this.bot = bot;
    this.runtime = runtime;
    this.accountId = accountId;
  }

  private scopedTelegramKey(key: string): string {
    return this.accountId === "default" ? key : `${this.accountId}:${key}`;
  }

  private telegramMessageMemoryKey(
    chatId: number | string,
    messageId: number | string,
  ): string {
    return `telegram:${this.accountId}:message:${chatId}:${messageId}`;
  }

  private telegramUpdateDedupeKey(
    chatId: number | string,
    messageId: number | string,
  ): string {
    return `telegram:processed:${this.accountId}:${chatId}:${messageId}`;
  }

  private async getTelegramMessageDeliveryState(
    chatId: number | string,
    messageId: number | string,
  ): Promise<"delivery_started" | "processed" | undefined> {
    const marker = await this.runtime.getCache<{
      processedAt: number;
      accountId: string;
      chatId: string;
      messageId: string;
      state?: "delivery_started" | "processed";
    }>(this.telegramUpdateDedupeKey(chatId, messageId));
    if (!marker) return undefined;
    // Markers written before delivery-state tracking landed represent turns
    // that completed successfully.
    return marker.state ?? "processed";
  }

  private async markTelegramMessageDeliveryState(
    chatId: number | string,
    messageId: number | string,
    state: "delivery_started" | "processed",
  ): Promise<void> {
    await this.runtime.setCache(
      this.telegramUpdateDedupeKey(chatId, messageId),
      {
        processedAt: Date.now(),
        accountId: this.accountId,
        chatId: String(chatId),
        messageId: String(messageId),
        state,
      },
    );
  }

  /**
   * Build the embedded-app (Mini App) launch keyboard row for the current
   * sender (#9947). Returns a single `web_app` button only when (a) an https
   * `/embed` URL is configured and (b) `resolveTelegramSenderAuth` resolves the
   * sender to an elevated role (OWNER or ADMIN). A non-elevated sender — or an
   * unconfigured / non-https embed URL — yields `[]`, so no launch button is
   * ever surfaced to an unauthorized user. The result is wired into the
   * existing `keyboardRows` path; it is not a parallel keyboard mechanism.
   */
  protected async buildEmbedLaunchRow(
    ctx: Context,
  ): Promise<InlineKeyboardButton[]> {
    const url = resolveEmbedLaunchUrl(this.runtime);
    if (!url) return [];
    const sender = await resolveTelegramSenderAuth(
      ctx,
      this.runtime,
      this.accountId,
    );
    if (!sender.isAuthorized && !sender.isElevated) return [];
    return [buildEmbedLaunchButton(url)];
  }

  /**
   * Fetch a Telegram file's bytes. This is the single point where the
   * token-bearing `getFileLink` URL exists — transiently, in process memory —
   * before the download goes through core's SSRF-guarded, size-capped fetcher.
   * The URL is never persisted and never handed to a model handler.
   */
  private async fetchTelegramFileBytes(
    fileId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    let fileLink: URL;
    try {
      fileLink = await this.bot.telegram.getFileLink(fileId);
    } catch (error) {
      // error-policy:J2 Apply the same credential-safe boundary to Bot API
      // lookup failures, whose client error details are not trusted as safe.
      throw sanitizedTelegramFileError(error);
    }
    return resolveTelegramFileBytes(fileLink.toString());
  }

  /**
   * Process an image from a Telegram message to extract the image description.
   * The bytes are fetched first and inlined as a data URL so the vision model
   * handler never receives the token-bearing Bot API file URL.
   *
   * @param {Message} message - The Telegram message object containing the image.
   * @returns {Promise<{ description: string } | null>} The description of the processed image or null if no image found.
   */
  async processImage(
    message: Message,
  ): Promise<{ description: string } | null> {
    try {
      let imageFileId: string | null = null;

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          messageId: message.message_id,
        },
        "Processing image from message",
      );

      if ("photo" in message && message.photo.length > 0) {
        imageFileId = message.photo[message.photo.length - 1].file_id;
      } else if (
        "document" in message &&
        message.document.mime_type?.startsWith("image/") &&
        !message.document.mime_type.startsWith("application/pdf")
      ) {
        imageFileId = message.document.file_id;
      }

      if (imageFileId) {
        const { buffer, contentType } =
          await this.fetchTelegramFileBytes(imageFileId);
        const imageDataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
        const { title, description } = await this.runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          imageDataUrl,
        );
        return { description: `[Image: ${title}\n${description}]` };
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing image",
      );
    }

    return null;
  }

  /**
   * Process a document from a Telegram message to extract the document URL and description.
   * Handles PDFs and other document types by converting them to text when possible.
   *
   * @param {Message} message - The Telegram message object containing the document.
   * @returns {Promise<{ description: string } | null>} The description of the processed document or null if no document found.
   */
  async processDocument(
    message: Message,
  ): Promise<DocumentProcessingResult | null> {
    try {
      if (!("document" in message) || !message.document) {
        return null;
      }

      const document = message.document;
      const fileLink = await this.bot.telegram.getFileLink(document.file_id);
      const documentUrl = fileLink.toString();

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          mimeType: document.mime_type,
          fileSize: document.file_size,
        },
        "Processing document",
      );

      // Centralized document processing based on MIME type
      const documentProcessor = this.getDocumentProcessor(document.mime_type);
      if (documentProcessor) {
        return await documentProcessor(document, documentUrl);
      }

      // Generic fallback for unsupported types
      return {
        title: `Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[Document: ${document.file_name || "Unknown Document"}\nType: ${document.mime_type || "unknown"}\nSize: ${document.file_size || 0} bytes]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Error processing document",
      );
      return null;
    }
  }

  /**
   * Get the appropriate document processor based on MIME type.
   */
  private getDocumentProcessor(
    mimeType?: string,
  ):
    | ((document: Document, url: string) => Promise<DocumentProcessingResult>)
    | null {
    if (!mimeType) {
      return null;
    }

    const processors = {
      "application/pdf": this.processPdfDocument.bind(this),
      "text/": this.processTextDocument.bind(this), // covers text/plain, text/csv, text/markdown, etc.
      "application/json": this.processTextDocument.bind(this),
    };

    for (const [pattern, processor] of Object.entries(processors)) {
      if (mimeType.startsWith(pattern)) {
        return processor;
      }
    }

    return null;
  }

  /**
   * Process PDF documents by converting them to text.
   */
  private async processPdfDocument(
    document: Document,
    documentUrl: string,
  ): Promise<DocumentProcessingResult> {
    try {
      const pdfServiceCandidate = this.runtime.getService(ServiceType.PDF);
      const pdfService = isPdfTextService(pdfServiceCandidate)
        ? pdfServiceCandidate
        : null;
      if (!pdfService) {
        logger.warn(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "PDF service not available, using fallback",
        );
        return {
          title: `PDF Document: ${document.file_name || "Unknown Document"}`,
          fullText: "",
          formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nUnable to extract text content]`,
          fileName: document.file_name || "Unknown Document",
          mimeType: document.mime_type,
          fileSize: document.file_size,
        };
      }

      // SSRF-guarded + byte-capped connector fetch (repo media invariant) —
      // the file URL comes from the (possibly self-hosted) Bot API, never
      // fetch it raw and unbounded.
      const { buffer: pdfBuffer } = await resolveTelegramFileBytes(documentUrl);
      const text = await pdfService.convertPdfToText(pdfBuffer);

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          charactersExtracted: text.length,
        },
        "PDF processed successfully",
      );
      return {
        title: document.file_name || "Unknown Document",
        fullText: text,
        formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Error processing PDF document",
      );
      return {
        title: `PDF Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nError: Unable to extract text content]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Process text documents by fetching their content.
   */
  private async processTextDocument(
    document: Document,
    documentUrl: string,
  ): Promise<DocumentProcessingResult> {
    try {
      const { buffer: textBuffer } =
        await resolveTelegramFileBytes(documentUrl);
      const text = textBuffer.toString("utf8");

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          charactersExtracted: text.length,
        },
        "Text document processed successfully",
      );
      return {
        title: document.file_name || "Unknown Document",
        fullText: text,
        formattedDescription: `[Text Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Error processing text document",
      );
      return {
        title: `Text Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[Text Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nError: Unable to read content]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Processes the message content, documents, and images to generate
   * processed content and media attachments.
   *
   * @param {Message} message The message to process
   * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
   */
  async processMessage(
    message: Message,
  ): Promise<{ processedContent: string; attachments: Media[] }> {
    let processedContent = "";
    const attachments: Media[] = [];

    // Get message text
    if ("text" in message && message.text) {
      processedContent = message.text;
    } else if ("caption" in message && message.caption) {
      processedContent = message.caption as string;
    }

    // Process documents
    if ("document" in message && message.document) {
      const document = message.document;
      const documentInfo = await this.processDocument(message);

      if (documentInfo) {
        // Use structured data directly instead of regex parsing
        const title = documentInfo.title;
        const fullText = documentInfo.fullText;

        // Add document content to processedContent so agent can access it
        if (fullText) {
          const documentContent = `\n\n--- DOCUMENT CONTENT ---\nTitle: ${title}\n\nFull Content:\n${fullText}\n--- END DOCUMENT ---\n\n`;
          processedContent += documentContent;
        }

        attachments.push({
          id: document.file_id,
          // Bare capability reference only — the token-bearing Bot API URL is
          // resolved transiently at fetch time, never persisted.
          url: telegramFileRefUrl(document.file_id),
          title,
          source: document.mime_type?.startsWith("application/pdf")
            ? "PDF"
            : "Document",
          contentType: contentTypeForMime(document.mime_type),
          description: documentInfo.formattedDescription,
          text: fullText,
        });
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            fileName: documentInfo.fileName,
          },
          "Document processed successfully",
        );
      } else {
        // Add a basic attachment even if documentInfo is null
        attachments.push({
          id: document.file_id,
          url: "",
          title: `Document: ${document.file_name || "Unknown Document"}`,
          source: "Document",
          description: `Document: ${document.file_name || "Unknown Document"}`,
          text: `Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nType: ${document.mime_type || "unknown"}`,
        });
      }
    }

    // Process images
    if ("photo" in message && message.photo.length > 0) {
      const imageInfo = await this.processImage(message);
      if (imageInfo) {
        const photo = message.photo[message.photo.length - 1];
        attachments.push({
          id: photo.file_id,
          // Bare capability reference only — the token-bearing Bot API URL is
          // resolved transiently at fetch time, never persisted.
          url: telegramFileRefUrl(photo.file_id),
          title: "Image Attachment",
          source: "Image",
          contentType: "image",
          description: imageInfo.description,
          text: imageInfo.description,
        });
      }
    }

    // Voice / audio / video / animation / sticker attachments. Setting
    // contentType lets processAttachments transcribe audio/video and lets the
    // attachment round-trip safely back out to any connector. The stored URL
    // is a `telegram-file:` capability reference; bytes are fetched with the
    // bot token at enrichment time in handleMessage.
    const pushFileAttachment = (
      fileId: string,
      contentType: ContentType,
      title: string,
      source: string,
    ): void => {
      attachments.push({
        id: fileId,
        url: telegramFileRefUrl(fileId),
        title,
        source,
        contentType,
      });
    };

    if ("voice" in message && message.voice) {
      pushFileAttachment(
        message.voice.file_id,
        "audio",
        "Voice Message",
        "Voice",
      );
    }
    if ("audio" in message && message.audio) {
      pushFileAttachment(
        message.audio.file_id,
        "audio",
        message.audio.title || message.audio.file_name || "Audio",
        "Audio",
      );
    }
    if ("video" in message && message.video) {
      pushFileAttachment(message.video.file_id, "video", "Video", "Video");
    }
    if ("video_note" in message && message.video_note) {
      pushFileAttachment(
        message.video_note.file_id,
        "video",
        "Video Note",
        "Video",
      );
    }
    if ("animation" in message && message.animation) {
      pushFileAttachment(
        message.animation.file_id,
        "video",
        "Animation",
        "Animation",
      );
    }
    if ("sticker" in message && message.sticker) {
      pushFileAttachment(
        message.sticker.file_id,
        "image",
        "Sticker",
        "Sticker",
      );
    }

    logger.debug(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        hasContent: !!processedContent,
        attachmentsCount: attachments.length,
      },
      "Message processed",
    );

    return { processedContent, attachments };
  }

  /**
   * Enrich `telegram-file:` reference attachments just before a message enters
   * the reply path. Core's deferred `processAttachments` enrichment fetches
   * `attachment.url` itself, and these references are deliberately not servable
   * URLs — persisting the token-bearing Bot API URL would leak the bot token
   * into the message store. Bytes are therefore resolved here, through
   * {@link fetchTelegramFileBytes}, at exactly the point core's enrichment
   * would have run, using the same model contracts (TRANSCRIPTION for
   * audio/video, IMAGE_DESCRIPTION for undescribed images). A failure leaves
   * the attachment un-enriched so the runtime records its own explicit
   * transient state instead of a fabricated result.
   */
  private async enrichFileRefAttachments(
    attachments: Media[] | undefined,
  ): Promise<void> {
    if (!attachments?.length) return;
    for (const attachment of attachments) {
      const fileId = telegramFileIdFromRef(attachment.url);
      if (!fileId) continue;
      try {
        if (
          (attachment.contentType === "audio" ||
            attachment.contentType === "video") &&
          !attachment.text
        ) {
          const { buffer } = await this.fetchTelegramFileBytes(fileId);
          const transcript = await this.runtime.useModel(
            ModelType.TRANSCRIPTION,
            buffer,
          );
          if (typeof transcript === "string" && transcript.trim().length > 0) {
            attachment.text = transcript.trim();
            attachment.description = `Transcript: ${transcript.trim()}`;
          }
        } else if (
          attachment.contentType === "image" &&
          !attachment.description
        ) {
          const { buffer, contentType } =
            await this.fetchTelegramFileBytes(fileId);
          const result = (await this.runtime.useModel(
            ModelType.IMAGE_DESCRIPTION,
            `data:${contentType};base64,${buffer.toString("base64")}`,
          )) as { title?: string; description?: string } | undefined;
          if (result?.description) {
            attachment.description = `[Image: ${result.title ?? attachment.title ?? "Image"}\n${result.description}]`;
            attachment.text = attachment.description;
          }
        }
      } catch (error) {
        // error-policy:J4 enrichment is best-effort at the connector boundary:
        // the attachment stays available un-enriched and core records an
        // explicit transient failure marker downstream.
        logger.warn(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId: this.accountId,
            contentType: attachment.contentType,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to enrich Telegram file attachment; continuing un-enriched",
        );
      }
    }
  }

  /**
   * Issue a Telegram send with bounded resilience so a transient error doesn't
   * silently drop the agent's reply. On a 429 it honors the server-supplied
   * `retry_after` (capped) and retries; on a MarkdownV2 400 (parse/length) it
   * retries once via `plainTextFallback` so the user gets unformatted content
   * instead of nothing. Other errors (e.g. 403 blocked) propagate unchanged.
   * The inbound polling path is already resilient in telegraf; this covers the
   * outbound path it does not.
   */
  private async sendWithRetry<T>(
    send: () => Promise<T>,
    plainTextFallback?: () => Promise<T>,
  ): Promise<T> {
    const MAX_RATE_LIMIT_RETRIES = 2;
    const MAX_RETRY_AFTER_SECONDS = 30;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        const response = (
          error as {
            response?: {
              error_code?: number;
              description?: string;
              parameters?: { retry_after?: number };
            };
          }
        ).response;
        const code = response?.error_code;
        if (code === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = Math.min(
            response?.parameters?.retry_after ?? 1,
            MAX_RETRY_AFTER_SECONDS,
          );
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              retryAfter,
            },
            "Telegram rate-limited (429); retrying after retry_after",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000),
          );
          continue;
        }
        if (
          code === 400 &&
          plainTextFallback &&
          /parse|entit|too long/i.test(response?.description ?? "")
        ) {
          logger.warn(
            { src: "plugin:telegram", agentId: this.runtime.agentId },
            "Telegram rejected formatted message (400); retrying as plain text",
          );
          return await plainTextFallback();
        }
        throw error;
      }
    }
  }

  /**
   * Sends a message in chunks, handling attachments and splitting the message if necessary
   *
   * @param {Context} ctx - The context object representing the current state of the bot
   * @param {TelegramContent} content - The content of the message to be sent
   * @param {number} [replyToMessageId] - The ID of the message to reply to, if any
   * @returns {Promise<Message.TextMessage[]>} - An array of TextMessage objects representing the messages sent
   */
  async sendMessageInChunks(
    ctx: Context,
    content: TelegramContent,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<Message.TextMessage[]> {
    if (content.attachments && content.attachments.length > 0) {
      await Promise.all(
        content.attachments.map(async (attachment: Media) => {
          const typeMap: { [key: string]: MediaType } = {
            "image/gif": MediaType.ANIMATION,
            image: MediaType.PHOTO,
            doc: MediaType.DOCUMENT,
            video: MediaType.VIDEO,
            audio: MediaType.AUDIO,
          };

          let mediaType: MediaType | undefined;

          for (const prefix in typeMap) {
            if (attachment.contentType?.startsWith(prefix)) {
              mediaType = typeMap[prefix];
              break;
            }
          }

          if (!mediaType) {
            // Degrade unknown/absent content types to a document upload instead
            // of throwing — a throw inside Promise.all aborts the whole reply
            // and silently drops the agent's text.
            logger.warn(
              {
                src: "plugin:telegram",
                agentId: this.runtime.agentId,
                contentType: attachment.contentType,
              },
              "Unknown Telegram attachment content type; sending as document",
            );
            mediaType = MediaType.DOCUMENT;
          }

          await this.sendMedia(
            ctx,
            attachment.url,
            mediaType,
            attachment.description,
            messageThreadId,
          );
        }),
      );
      // Fall through to the text path below so an attachment reply never drops
      // the agent's accompanying prose (sent as a follow-up message).
    }

    {
      // Project any interactive blocks (choices, task cards, …) the agent
      // embedded in the text onto native inline keyboards, and send the prose
      // with the markers stripped. Plain replies pass through unchanged.
      const rawAppUrl =
        this.runtime.getSetting("ELIZA_APP_URL") ||
        this.runtime.getSetting("ELIZA_CLOUD_URL");
      const appBaseUrl = typeof rawAppUrl === "string" ? rawAppUrl : undefined;
      const rendered = renderTelegramInteractions(
        content,
        buildInteractionUrlResolver(appBaseUrl),
      );
      const sentMessages: Message.TextMessage[] = [];

      const telegramButtons = convertToTelegramButtons(content.buttons ?? []);
      const hasKeyboardRows =
        rendered.keyboardRows.length > 0 || telegramButtons.length > 0;
      const textToSend =
        rendered.text.trim().length > 0
          ? rendered.text
          : hasKeyboardRows
            ? INTERACTION_ONLY_FALLBACK_TEXT
            : "";
      // Nothing textual to send (e.g. an attachments-only reply that already
      // dispatched its media above) — don't post an empty trailing message.
      if (textToSend.trim().length === 0 && !hasKeyboardRows) {
        return sentMessages;
      }

      const chunks = this.splitMessage(textToSend);

      if (!ctx.chat) {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "sendMessageInChunks: ctx.chat is undefined",
        );
        return [];
      }
      // The typing indicator is cosmetic and best-effort — a failure here must
      // never abort the actual reply on the critical path below.
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
      } catch (error) {
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "sendChatAction (typing) failed; continuing",
        );
      }

      // Role-gated embedded-app launch row: resolved once (it performs a role
      // lookup) and attached to the final chunk only, alongside any other
      // interaction controls.
      const embedLaunchRow = await this.buildEmbedLaunchRow(ctx);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = convertMarkdownToTelegram(chunks[i]);
        if (!ctx.chat) {
          logger.error(
            { src: "plugin:telegram", agentId: this.runtime.agentId },
            "sendMessageInChunks loop: ctx.chat is undefined",
          );
          continue;
        }
        // Interaction controls go on the final chunk only; explicit
        // `content.buttons` keep their existing per-chunk behavior.
        const isLast = i === chunks.length - 1;
        const keyboardRows: InlineKeyboardButton[][] = [];
        if (isLast && rendered.keyboardRows.length > 0) {
          keyboardRows.push(...rendered.keyboardRows);
        }
        if (telegramButtons.length > 0) keyboardRows.push(telegramButtons);
        if (isLast && embedLaunchRow.length > 0) {
          keyboardRows.push(embedLaunchRow);
        }
        const replyMarkup =
          keyboardRows.length > 0
            ? Markup.inlineKeyboard(keyboardRows).reply_markup
            : undefined;

        const chatId = ctx.chat.id;
        const sendOptions = {
          reply_parameters:
            i === 0 && replyToMessageId
              ? { message_id: replyToMessageId }
              : undefined,
          ...(messageThreadId !== undefined
            ? { message_thread_id: messageThreadId }
            : {}),
          reply_markup: replyMarkup,
        };
        try {
          const sentMessage = (await this.sendWithRetry(
            () =>
              ctx.telegram.sendMessage(chatId, chunk, {
                ...sendOptions,
                parse_mode: "MarkdownV2",
              }),
            // Fallback: Telegram rejected the MarkdownV2 entities. Send the
            // ORIGINAL chunk (chunks[i]), not the MarkdownV2-escaped `chunk` —
            // otherwise the user sees literal backslash escapes ("Sure\!"). Mirror
            // the editMessage fallback, which sends cleanText(text).
            () =>
              ctx.telegram.sendMessage(
                chatId,
                cleanText(chunks[i]),
                sendOptions,
              ),
          )) as Message.TextMessage;

          sentMessages.push(sentMessage);
        } catch (cause) {
          // error-policy:J2 retain accepted chunks when a later provider operation fails.
          if (sentMessages.length)
            throw new TelegramOutboundEvidenceError(
              "transport",
              sentMessages,
              [],
              cause,
              this.accountId,
              String(chatId),
            );
          throw cause;
        }
      }

      return sentMessages;
    }
  }

  private async persistSentMessageMemories(args: {
    sentMessages: Message.TextMessage[];
    content: TelegramContent;
    roomId: UUID;
    channelType: ChannelType;
    chatType: string;
    threadId?: string;
    inReplyTo: UUID;
  }): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const sentMessage of args.sentMessages) {
      const responseMemory: Memory = {
        id: createUniqueUuid(
          this.runtime,
          this.telegramMessageMemoryKey(
            sentMessage.chat.id,
            sentMessage.message_id,
          ),
        ),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: args.roomId,
        content: {
          ...args.content,
          source: "telegram",
          text: sentMessage.text,
          inReplyTo: args.inReplyTo,
          channelType: args.channelType,
          metadata: { accountId: this.accountId },
        },
        metadata: {
          type: "message",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          // Trusted scope stamp at ingestion: a connector message belongs to
          // its room. Fail-closed canonical recall withholds unstamped records
          // instead of widening them.
          scope: "room",
          timestamp: sentMessage.date * 1000,
          fromBot: true,
          fromId: this.runtime.agentId,
          sourceId: this.runtime.agentId,
          chatType: args.chatType,
          messageIdFull: sentMessage.message_id.toString(),
          telegram: {
            chatId: sentMessage.chat.id,
            messageId: sentMessage.message_id.toString(),
            threadId: args.threadId,
          },
        } satisfies Memory["metadata"],
        createdAt: sentMessage.date * 1000,
      };

      await this.runtime.createMemory(responseMemory, "messages");
      memories.push(responseMemory);
    }

    return memories;
  }

  /**
   * Sends media to a chat using the Telegram API.
   *
   * @param {Context} ctx - The context object containing information about the current chat.
   * @param {string} mediaPath - The path to the media to be sent, either a URL or a local file path.
   * @param {MediaType} type - The type of media being sent (PHOTO, VIDEO, DOCUMENT, AUDIO, or ANIMATION).
   * @param {string} [caption] - Optional caption for the media being sent.
   * @param {number} [messageThreadId] - Forum topic identifier for the media send.
   *
   * @returns {Promise<void>} A Promise that resolves when the media is successfully sent.
   */
  async sendMedia(
    ctx: Context,
    mediaPath: string,
    type: MediaType,
    caption?: string,
    messageThreadId?: number,
  ): Promise<void> {
    try {
      const isUrl = /^(http|https):\/\//.test(mediaPath);
      // Look up the raw sender lazily and bind only the one we need. Building
      // the full map up front and `.bind`-ing every entry would crash with
      // "Cannot read properties of undefined" if the Telegram client is missing
      // any single sender, aborting an unrelated media send.
      const rawSenders: Record<MediaType, TelegramMediaSender | undefined> = {
        [MediaType.PHOTO]: ctx.telegram.sendPhoto,
        [MediaType.VIDEO]: ctx.telegram.sendVideo,
        [MediaType.DOCUMENT]: ctx.telegram.sendDocument,
        [MediaType.AUDIO]: ctx.telegram.sendAudio,
        [MediaType.ANIMATION]: ctx.telegram.sendAnimation,
      };

      const rawSend = rawSenders[type];
      if (typeof rawSend !== "function") {
        throw new Error(`Unsupported media type: ${type}`);
      }
      const sendFunction = rawSend.bind(ctx.telegram);

      if (!ctx.chat) {
        throw new Error("sendMedia: ctx.chat is undefined");
      }
      const chatId = ctx.chat.id;
      const captionNeedsFollowUp =
        typeof caption === "string" &&
        caption.length > MAX_MEDIA_CAPTION_LENGTH;
      const sendOptions = {
        caption: captionNeedsFollowUp ? undefined : caption,
        ...(messageThreadId !== undefined
          ? { message_thread_id: messageThreadId }
          : {}),
      };

      const fileRefId = telegramFileIdFromRef(mediaPath);
      if (fileRefId) {
        // A stored inbound capability reference names a Telegram file_id; the
        // Bot API re-sends those by id directly, so the round-trip never needs
        // the token-bearing file URL.
        await sendFunction(ctx.chat.id, fileRefId, sendOptions);
      } else if (isUrl) {
        // Handle HTTP URLs
        await sendFunction(ctx.chat.id, mediaPath, sendOptions);
      } else {
        // Handle local file paths
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`File not found at path: ${mediaPath}`);
        }

        const fileStream = fs.createReadStream(mediaPath);

        try {
          if (!ctx.chat) {
            throw new Error("sendMedia (file): ctx.chat is undefined");
          }
          await sendFunction(ctx.chat.id, { source: fileStream }, sendOptions);
        } finally {
          fileStream.destroy();
        }
      }

      if (captionNeedsFollowUp) {
        // Telegram's media-caption field is limited to 1024 UTF-16 units. Send
        // the media first, then preserve the complete caption as ordinary text
        // messages instead of reporting success after silently clipping it.
        for (const chunk of this.splitMessage(caption)) {
          await this.sendWithRetry(() =>
            ctx.telegram.sendMessage(chatId, chunk, {
              message_thread_id: messageThreadId,
            }),
          );
        }
      }

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          mediaType: type,
          mediaPath,
        },
        "Media sent successfully",
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          mediaType: type,
          mediaPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to send media",
      );
      throw error;
    }
  }

  /**
   * Splits a given text into an array of strings based on the maximum message length.
   *
   * @param {string} text - The text to split into chunks.
   * @returns {string[]} An array of strings with each element representing a chunk of the original text.
   */
  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) {
      return chunks;
    }

    let remaining = toWellFormedUnicode(text);
    while (remaining.length > 0) {
      // This is lossless transport chunking: every returned chunk is sent and
      // concatenating them reconstructs the complete well-formed input. When
      // the remainder does not fit, prefer cutting right before the last
      // newline inside the window so paragraphs stay intact; the newline
      // itself is carried into the next chunk rather than dropped.
      let chunk: string;
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunk = remaining;
      } else {
        const newlineIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
        chunk =
          newlineIndex > 0
            ? remaining.slice(0, newlineIndex)
            : truncateWellFormed(remaining, MAX_MESSAGE_LENGTH);
      }
      if (chunk.length === 0) {
        throw new Error("Unable to split Telegram message without data loss");
      }
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length);
    }
    return chunks;
  }

  /**
   * Handle incoming messages from Telegram and process them accordingly.
   * @param {Context} ctx - The context object containing information about the message.
   * @param {object} [options] - Handling options.
   * @param {boolean} [options.forceReply] - When true, always route the message
   *   through the agent and force a reply, bypassing the TELEGRAM_AUTO_REPLY gate.
   *   Used for explicit slash-command invocations where the user intent to get a
   *   response is unambiguous.
   * @param {UUID} [options.entityId] - Actor already resolved for this turn
   *   (slash-command auth). When set, identity is not looked up again.
   * @returns {Promise<void>}
   */
  public async handleMessage(
    ctx: Context,
    options?: { forceReply?: boolean; entityId?: UUID },
  ): Promise<void> {
    if (!ctx.message || !ctx.from) {
      return;
    }

    const message = ctx.message as Message.TextMessage;

    try {
      const telegramUserId = ctx.from.id.toString();
      const entityId =
        options?.entityId ??
        (await resolveTelegramRuntimeEntityId(
          this.runtime,
          this.accountId,
          telegramUserId,
        ));

      const threadId =
        "is_topic_message" in message && message.is_topic_message
          ? message.message_thread_id?.toString()
          : undefined;

      if (!ctx.chat) {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "handleMessage: ctx.chat is undefined",
        );
        return;
      }
      const telegramRoomid = threadId
        ? `${ctx.chat.id}-${threadId}`
        : ctx.chat.id.toString();
      const telegramChatId = ctx.chat.id.toString();
      const scopedRoomKey = this.scopedTelegramKey(telegramRoomid);
      const scopedChatKey = this.scopedTelegramKey(telegramChatId);
      const roomId = createUniqueUuid(this.runtime, scopedRoomKey) as UUID;
      const worldId = createUniqueUuid(this.runtime, scopedChatKey) as UUID;
      const telegramMessageId = message.message_id.toString();
      const messageId = createUniqueUuid(
        this.runtime,
        this.telegramMessageMemoryKey(telegramChatId, telegramMessageId),
      );

      const deliveryState = await this.getTelegramMessageDeliveryState(
        telegramChatId,
        telegramMessageId,
      );
      if (deliveryState) {
        if (deliveryState === "delivery_started") {
          const error = new Error(
            `Telegram delivery outcome is uncertain for ${this.accountId}/${telegramChatId}/${telegramMessageId}; refusing duplicate egress`,
          );
          this.runtime.reportError("telegram:delivery-uncertain", error, {
            accountId: this.accountId,
            chatId: telegramChatId,
            messageId: telegramMessageId,
          });
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              accountId: this.accountId,
              chatId: telegramChatId,
              messageId: telegramMessageId,
            },
            "Refusing to replay a Telegram turn after delivery started",
          );
        }
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            accountId: this.accountId,
            chatId: telegramChatId,
            messageId: telegramMessageId,
          },
          "Skipping duplicate Telegram message update",
        );
        return;
      }

      // Process message content and attachments
      const { processedContent, attachments } =
        await this.processMessage(message);

      // Clean processedContent and attachments to avoid NULL characters
      const cleanedContent = cleanText(processedContent);
      const cleanedAttachments = attachments.map((att) => ({
        ...att,
        text: cleanText(att.text),
        description: cleanText(att.description),
        title: cleanText(att.title),
      }));

      if (!cleanedContent && cleanedAttachments.length === 0) {
        return;
      }

      // Get chat type and determine channel type
      const chat = message.chat as Chat;
      const channelType = getChannelType(chat);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        roomName:
          ("title" in chat && typeof chat.title === "string" && chat.title) ||
          ("first_name" in chat &&
            typeof chat.first_name === "string" &&
            chat.first_name) ||
          ("username" in chat &&
            typeof chat.username === "string" &&
            chat.username) ||
          telegramRoomid,
        userName: ctx.from.username,
        name: ctx.from.first_name,
        userId: telegramUserId as UUID,
        source: "telegram",
        channelId: telegramRoomid,
        type: channelType,
        worldId,
        worldName: telegramRoomid,
      });

      // Create the memory object
      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: cleanedContent || " ",
          attachments: cleanedAttachments,
          source: "telegram",
          metadata: { accountId: this.accountId },
          channelType,
          inReplyTo:
            "reply_to_message" in message && message.reply_to_message
              ? createUniqueUuid(
                  this.runtime,
                  this.telegramMessageMemoryKey(
                    telegramChatId,
                    message.reply_to_message.message_id,
                  ),
                )
              : undefined,
        },
        metadata: {
          type: "message",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          // Trusted scope stamp at ingestion: a connector message belongs to
          // its room. Fail-closed canonical recall withholds unstamped records
          // instead of widening them.
          scope: "room",
          timestamp: message.date * 1000,
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          fromId: telegramUserId,
          sourceId: entityId,
          chatType: chat.type,
          messageIdFull: telegramMessageId,
          sender: {
            id: telegramUserId,
            name: ctx.from.first_name,
            username: ctx.from.username,
          },
          telegram: {
            ...telegramIdentityMetadata(
              telegramUserId,
              ctx.from.first_name,
              ctx.from.username,
              this.accountId,
            ),
            chatId: telegramChatId,
            messageId: telegramMessageId,
            threadId,
          },
          telegramUserId,
          telegramChatId,
        } satisfies Memory["metadata"],
        createdAt: message.date * 1000,
      };

      const threadIdNum =
        threadId && Number.isFinite(Number(threadId))
          ? Number(threadId)
          : undefined;

      // Create callback for handling responses
      const baseCallback: HandlerCallback = async (
        content: Content,
        _actionName?: string,
      ) => {
        try {
          // If response is from reasoning do not send it.
          if (!content.text) {
            return [];
          }

          // Persist the no-replay barrier before touching Telegram. If the
          // process dies after this point, a redelivered update fails visibly
          // instead of risking a duplicate message whose first send may have
          // reached Telegram without returning an acknowledgement.
          await this.markTelegramMessageDeliveryState(
            telegramChatId,
            telegramMessageId,
            "delivery_started",
          );

          let sentMessages: boolean | Message.TextMessage[] = false;
          // channelType target === 'telegram'
          if (content.channelType === "DM") {
            // Route through sendMessageInChunks so DM replies get the same
            // markdown conversion + inline interactions as group replies. Target
            // ctx.from.id (the user's private chat) via a ctx shim, since a DM
            // response to a group message must not go to ctx.chat.id.
            sentMessages = ctx.from
              ? await this.sendMessageInChunks(
                  {
                    chat: { id: ctx.from.id },
                    telegram: this.bot.telegram,
                  } as Context,
                  content,
                )
              : [];
          } else {
            sentMessages = await this.sendMessageInChunks(
              ctx,
              content,
              message.message_id,
              threadIdNum,
            );
          }

          if (!Array.isArray(sentMessages)) {
            return [];
          }

          return this.persistSentMessageMemories({
            sentMessages,
            content,
            roomId,
            channelType,
            chatType: chat.type,
            threadId,
            inReplyTo: messageId,
          });
        } catch (cause) {
          // error-policy:J2 Preserve transport or persistence failure context
          // before it returns through the runtime callback boundary.
          const error =
            cause instanceof ElizaError
              ? cause
              : new ElizaError("Telegram reply delivery failed", {
                  code: "TELEGRAM_REPLY_DELIVERY_FAILED",
                  cause,
                  context: {
                    accountId: this.accountId,
                    chatId: telegramChatId,
                    messageId: telegramMessageId,
                  },
                });
          this.runtime.reportError("telegram:delivery", error, {
            accountId: this.accountId,
            chatId: telegramChatId,
            messageId: telegramMessageId,
          });
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error in message callback",
          );
          throw error;
        }
      };
      const callback = createTelegramCompactProgressCallback({
        baseCallback,
        editMessage: this.editMessage.bind(this),
        chatId: chat.id,
        threadId: threadIdNum,
      });

      // Inbound messages are always persisted to memory above. The agent only
      // auto-generates a reply when TELEGRAM_AUTO_REPLY is explicitly enabled —
      // default-off prevents the runtime from speaking on the user's behalf.
      // A forced reply (explicit slash-command invocation) always routes to the
      // agent regardless of the auto-reply gate, since the user explicitly asked
      // for a response by typing a command.
      const telegramAutoReplyRaw = this.runtime.getSetting(
        "TELEGRAM_AUTO_REPLY",
      );
      const telegramAutoReply =
        !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
        (telegramAutoReplyRaw === true || telegramAutoReplyRaw === "true");
      const shouldReply = options?.forceReply === true || telegramAutoReply;

      if (!shouldReply) {
        try {
          await this.runtime.createMemory(memory, "messages");
          await this.markTelegramMessageDeliveryState(
            telegramChatId,
            telegramMessageId,
            "processed",
          );
        } catch (cause) {
          // error-policy:J2 Inbound persistence is the operation in passive
          // mode; retain the cause and fail the handler instead of acknowledging
          // a success-shaped turn that was never stored.
          const persistError = new ElizaError(
            "Telegram inbound memory persistence failed",
            {
              code: "TELEGRAM_INBOUND_MEMORY_PERSISTENCE_FAILED",
              cause,
              context: {
                accountId: this.accountId,
                chatId: telegramChatId,
                messageId: telegramMessageId,
              },
            },
          );
          this.runtime.reportError(
            "telegram:inbound-persistence",
            persistError,
          );
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error:
                persistError instanceof Error
                  ? persistError.message
                  : String(persistError),
            },
            "Failed to persist inbound memory while auto-reply is disabled",
          );
          throw persistError;
        }
        logger.debug(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "Auto-reply disabled (TELEGRAM_AUTO_REPLY=false); message ingested without response",
        );
      } else if (this.runtime.messageService) {
        // The stored attachment URLs are token-free `telegram-file:` capability
        // references, which core's deferred enrichment cannot fetch — resolve
        // bytes and enrich here, at the same point of the turn core's
        // processAttachments would have fetched the old token-bearing URLs.
        await this.enrichFileRefAttachments(cleanedAttachments);
        await this.runtime.messageService.handleMessage(
          this.runtime,
          memory,
          callback,
        );
        await this.markTelegramMessageDeliveryState(
          telegramChatId,
          telegramMessageId,
          "processed",
        );
      } else {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "Message service is not available",
        );
        throw new Error(
          "Message service is not initialized. Ensure the message service is properly configured.",
        );
      }
    } catch (cause) {
      // error-policy:J2 Add the inbound connector coordinates before the
      // failure returns to the Telegraf event boundary.
      const error =
        cause instanceof ElizaError
          ? cause
          : new ElizaError("Telegram inbound message handling failed", {
              code: "TELEGRAM_INBOUND_MESSAGE_FAILED",
              cause,
              context: {
                accountId: this.accountId,
                chatId: ctx.chat?.id,
                messageId: ctx.message.message_id,
              },
            });
      this.runtime.reportError("telegram:message", error);
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          chatId: ctx.chat?.id,
          messageId: ctx.message.message_id,
          from: ctx.from.username || ctx.from.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling Telegram message",
      );
      throw error;
    }
  }

  /**
   * Handle an inline-keyboard button tap whose payload was produced by the
   * shared interaction codec (a choice or followup answer). The chosen value is
   * replayed as an ordinary user turn — mirroring the dashboard's "send the
   * chosen value as a message" behavior — so downstream routing (choice scopes,
   * orchestrator turns) is identical across surfaces. Foreign callbacks are
   * acknowledged and ignored.
   */
  public async handleCallbackQuery(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>,
  ): Promise<void> {
    const query = ctx.callbackQuery;
    const data =
      query && "data" in query && typeof query.data === "string"
        ? query.data
        : undefined;
    const decoded = decodeCallback(data);

    if (!decoded || !ctx.from || !query?.message) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // best-effort: a stale callback may already have expired
      }
      return;
    }

    const sourceMessage = query.message;
    const chat = sourceMessage.chat as Chat;
    const telegramUserId = ctx.from.id.toString();
    let entityId: UUID;
    try {
      entityId = await resolveTelegramRuntimeEntityId(
        this.runtime,
        this.accountId,
        telegramUserId,
      );
    } catch (error) {
      // error-policy:J4 identity store failure is a user-visible unavailable
      // state: fail closed, acknowledge so Telegram clears the spinner, then
      // report. Do not throw before answerCbQuery — the service catch only logs.
      try {
        await ctx.answerCbQuery("Could not verify your identity. Try again.", {
          show_alert: true,
        });
      } catch {
        // error-policy:J6 best-effort: a stale callback may already have expired
      }
      this.runtime.reportError("telegram:callback-identity", error, {
        accountId: this.accountId,
        telegramUserId,
      });
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          accountId: this.accountId,
          telegramUserId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Telegram callback identity lookup failed",
      );
      return;
    }

    const threadId =
      "is_topic_message" in sourceMessage && sourceMessage.is_topic_message
        ? sourceMessage.message_thread_id?.toString()
        : undefined;
    const threadIdNum =
      threadId && Number.isFinite(Number(threadId))
        ? Number(threadId)
        : undefined;
    const telegramChatId = chat.id.toString();
    const telegramRoomid = threadId
      ? `${telegramChatId}-${threadId}`
      : telegramChatId;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(telegramRoomid),
    ) as UUID;
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(telegramChatId),
    ) as UUID;
    // Derive the turn id from the unique callback-query id so it never collides
    // with the bot message the buttons were attached to.
    const callbackKey = `cbq-${query.id}`;
    const messageId = createUniqueUuid(
      this.runtime,
      this.telegramMessageMemoryKey(telegramChatId, callbackKey),
    );
    const channelType = getChannelType(chat);
    const computerUseApproval = parseComputerUseApprovalCallback(decoded.value);
    if (computerUseApproval) {
      await this.resolveComputerUseApprovalCallback(
        ctx,
        chat,
        sourceMessage.message_id,
        threadIdNum,
        entityId,
        roomId,
        channelType,
        computerUseApproval,
      );
      return;
    }

    // Always acknowledge so Telegram clears the button's loading spinner.
    try {
      await ctx.answerCbQuery();
    } catch {
      // best-effort: a stale callback may already have expired
    }

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      roomName: telegramRoomid,
      userName: ctx.from.username,
      name: ctx.from.first_name,
      userId: telegramUserId as UUID,
      source: "telegram",
      channelId: telegramRoomid,
      type: channelType,
      worldId,
      worldName: telegramRoomid,
    });

    const nowMs = Date.now();
    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: decoded.value,
        source: "telegram",
        metadata: { accountId: this.accountId },
        channelType,
      },
      metadata: {
        type: "message",
        source: "telegram",
        accountId: this.accountId,
        provider: "telegram",
        timestamp: nowMs,
        entityName: ctx.from.first_name,
        entityUserName: ctx.from.username,
        fromBot: false,
        fromId: telegramUserId,
        sourceId: entityId,
        chatType: chat.type,
        messageIdFull: callbackKey,
        sender: {
          id: telegramUserId,
          name: ctx.from.first_name,
          username: ctx.from.username,
        },
        telegram: {
          ...telegramIdentityMetadata(
            telegramUserId,
            ctx.from.first_name,
            ctx.from.username,
          ),
          chatId: telegramChatId,
          messageId: callbackKey,
          threadId,
        },
        telegramUserId,
        telegramChatId,
      } satisfies Memory["metadata"],
      createdAt: nowMs,
    };

    const baseCallback: HandlerCallback = async (content: Content) => {
      const sentMessages = await this.sendMessageInChunks(
        ctx,
        content,
        sourceMessage.message_id,
        threadIdNum,
      );
      return this.persistSentMessageMemories({
        sentMessages,
        content,
        roomId,
        channelType,
        chatType: chat.type,
        threadId,
        inReplyTo: messageId,
      });
    };
    const callback = createTelegramCompactProgressCallback({
      baseCallback,
      editMessage: this.editMessage.bind(this),
      chatId: chat.id,
      threadId: threadIdNum,
    });

    if (this.runtime.messageService) {
      await this.runtime.messageService.handleMessage(
        this.runtime,
        memory,
        callback,
      );
    }
  }

  private async persistComputerUseApprovalDecisionMemory(args: {
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>;
    chat: Chat;
    roomId: UUID;
    entityId: UUID;
    channelType: ChannelType;
    callback: ComputerUseApprovalCallback;
    statusText: string;
  }): Promise<void> {
    const queryId = args.ctx.callbackQuery.id;
    const actorTelegramUserId = args.ctx.from.id.toString();
    const nowMs = Date.now();
    const memory: Memory = {
      id: createUniqueUuid(
        this.runtime,
        this.telegramMessageMemoryKey(args.chat.id, `cua-${queryId}`),
      ),
      entityId: args.entityId,
      agentId: this.runtime.agentId,
      roomId: args.roomId,
      content: {
        text: args.statusText,
        source: "telegram",
        channelType: args.channelType,
        metadata: {
          accountId: this.accountId,
          computeruse: {
            approvalId: args.callback.approvalId,
            approved: args.callback.approved,
            ownerId: args.callback.ownerId,
          },
        },
      },
      metadata: {
        type: "custom",
        eventType: "computeruse_approval",
        source: "telegram",
        accountId: this.accountId,
        provider: "telegram",
        timestamp: nowMs,
        entityName: args.ctx.from.first_name,
        entityUserName: args.ctx.from.username,
        fromBot: false,
        fromId: actorTelegramUserId,
        sourceId: args.entityId,
        chatType: args.chat.type,
        messageIdFull: `cua-${queryId}`,
        sender: {
          id: actorTelegramUserId,
          name: args.ctx.from.first_name,
          username: args.ctx.from.username,
        },
        telegram: {
          ...telegramIdentityMetadata(
            actorTelegramUserId,
            args.ctx.from.first_name,
            args.ctx.from.username,
          ),
          chatId: args.chat.id.toString(),
          messageId: `cua-${queryId}`,
        },
        telegramUserId: actorTelegramUserId,
        telegramChatId: args.chat.id.toString(),
        computeruse: {
          approvalId: args.callback.approvalId,
          approved: args.callback.approved,
          ownerId: args.callback.ownerId,
        },
      } satisfies Memory["metadata"],
      createdAt: nowMs,
    };

    try {
      await this.runtime.createMemory(memory, "messages");
    } catch (error) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          approvalId: args.callback.approvalId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist computer-use approval decision memory",
      );
    }
  }

  private async resolveComputerUseApprovalCallback(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>,
    chat: Chat,
    messageId: number,
    threadId: number | undefined,
    entityId: UUID,
    roomId: UUID,
    channelType: ChannelType,
    callback: ComputerUseApprovalCallback,
  ): Promise<void> {
    const service = this.runtime.getService("computeruse");
    const actorTelegramUserId = ctx.from?.id.toString();
    if (
      callback.ownerId &&
      actorTelegramUserId &&
      callback.ownerId !== actorTelegramUserId
    ) {
      try {
        await ctx.answerCbQuery(
          "Only the requester can resolve this approval.",
          {
            show_alert: true,
          },
        );
      } catch {
        // best-effort: a stale callback may already have expired
      }
      return;
    }

    let statusText: string;

    if (!isComputerUseApprovalResolver(service)) {
      statusText = "Computer-use approval service is unavailable.";
    } else {
      const resolution = await Promise.resolve(
        service.resolveApproval(
          callback.approvalId,
          callback.approved,
          "Resolved from Telegram inline button",
        ),
      );
      if (resolution) {
        statusText = `Computer-use approval ${callback.approved ? "approved" : "denied"} (${callback.approvalId}).`;
      } else {
        statusText = `Computer-use approval ${callback.approvalId} is no longer pending.`;
      }
    }

    try {
      await ctx.answerCbQuery(
        callback.approved ? "Approval accepted." : "Approval denied.",
      );
    } catch {
      // best-effort: a stale callback may already have expired
    }

    await this.persistComputerUseApprovalDecisionMemory({
      ctx,
      chat,
      roomId,
      entityId,
      channelType,
      callback,
      statusText,
    });

    try {
      await this.editMessage(chat.id, messageId, statusText, threadId);
    } catch (error) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          approvalId: callback.approvalId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to edit computer-use approval prompt; sending a status reply",
      );
      await this.sendMessageInChunks(
        ctx.chat ? ctx : ({ chat, telegram: this.bot.telegram } as Context),
        { text: statusText },
        messageId,
        threadId,
      );
    }
  }

  /**
   * Handles the reaction event triggered by a user reacting to a message.
   * @param {NarrowedContext<Context<Update>, Update.MessageReactionUpdate>} ctx The context of the message reaction update
   * @returns {Promise<void>} A Promise that resolves when the reaction handling is complete
   */
  public async handleReaction(
    ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>,
  ): Promise<void> {
    // Ensure we have the necessary data
    if (!ctx.update.message_reaction || !ctx.from) {
      return;
    }

    const reaction = ctx.update.message_reaction;
    const reactedToMessageId = reaction.message_id;

    const syntheticReactionMessage = {
      message_id: reactedToMessageId,
      chat: reaction.chat,
      from: ctx.from,
      date: Math.floor(Date.now() / 1000),
    } as Message;

    const firstReaction = reaction.new_reaction[0];
    if (!firstReaction) {
      return;
    }
    // Emoji reactions carry the glyph on `.emoji`; non-emoji reactions
    // (custom_emoji / paid) are identified by `.type`.
    const reactionLabel =
      firstReaction.type === "emoji" ? firstReaction.emoji : firstReaction.type;

    try {
      const entityId = await resolveTelegramRuntimeEntityId(
        this.runtime,
        this.accountId,
        ctx.from.id.toString(),
      );
      const roomId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(ctx.chat.id.toString()),
      );

      const reactionId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(
          `reaction:${reaction.chat.id}:${reaction.message_id}:${ctx.from.id}:${Date.now()}`,
        ),
      );

      // Create reaction memory
      const memory: Memory = {
        id: reactionId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          channelType: getChannelType(reaction.chat as Chat),
          text: `Reacted with: ${reactionLabel}`,
          source: "telegram",
          inReplyTo: createUniqueUuid(
            this.runtime,
            this.telegramMessageMemoryKey(
              reaction.chat.id,
              reaction.message_id,
            ),
          ),
          metadata: { accountId: this.accountId },
        },
        metadata: {
          type: "custom",
          eventType: "reaction",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          fromId: ctx.from.id.toString(),
          sourceId: entityId,
          sender: {
            id: ctx.from.id.toString(),
            name: ctx.from.first_name,
            username: ctx.from.username,
          },
          telegram: {
            ...telegramIdentityMetadata(
              ctx.from.id.toString(),
              ctx.from.first_name,
              ctx.from.username,
            ),
            chatId: reaction.chat.id.toString(),
            messageId: reaction.message_id.toString(),
          },
          telegramUserId: ctx.from.id.toString(),
          telegramChatId: reaction.chat.id.toString(),
        } satisfies Memory["metadata"],
        createdAt: Date.now(),
      };

      // Create callback for handling reaction responses
      const callback: HandlerCallback = async (content: Content) => {
        try {
          const sentMessages = await this.sendMessageInChunks(
            ctx,
            { ...content, text: content.text ?? "" } as TelegramContent,
            reaction.message_id,
          );
          return sentMessages.map(
            (sentMessage): Memory => ({
              id: createUniqueUuid(
                this.runtime,
                this.telegramMessageMemoryKey(
                  sentMessage.chat.id,
                  sentMessage.message_id,
                ),
              ),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              roomId,
              content: {
                ...content,
                text: sentMessage.text,
                inReplyTo: reactionId,
                metadata: { accountId: this.accountId },
              },
              metadata: {
                type: "message",
                source: "telegram",
                accountId: this.accountId,
                provider: "telegram",
              } satisfies Memory["metadata"],
              createdAt: sentMessage.date * 1000,
            }),
          );
        } catch (error) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error in reaction callback",
          );
          // error-policy:J2 A failed reaction reply is not an empty successful
          // turn; the inbound message callback already rethrows this way.
          throw error instanceof ElizaError
            ? error
            : new ElizaError("Telegram reaction reply failed", {
                code: "TELEGRAM_REACTION_REPLY_FAILED",
                cause: error,
                context: { accountId: this.accountId, roomId },
              });
        }
      };

      // Let the bootstrap plugin handle the reaction
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "telegram",
        accountId: this.accountId,
        metadata: { accountId: this.accountId },
        ctx,
        originalMessage: syntheticReactionMessage,
        reactionString: reactionLabel,
        originalReaction: firstReaction as ReactionType,
      } as TelegramReactionReceivedPayload);

      // Also emit the platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "telegram",
        accountId: this.accountId,
        metadata: { accountId: this.accountId },
        ctx,
        originalMessage: syntheticReactionMessage,
        reactionString: reactionLabel,
        originalReaction: firstReaction as ReactionType,
      } as TelegramReactionReceivedPayload);
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling reaction",
      );
    }
  }

  /**
   * Edits the text of a previously-sent Telegram message in place. Converts
   * markdown to MarkdownV2 and, on a MarkdownV2 rejection, retries as plain
   * text — mirroring {@link sendMessageInChunks}'s fallback. Used by the
   * connector `edit_message` capability so the orchestrator's compact progress
   * mode can rewrite one line across heartbeats instead of flooding the chat.
   */
  public async editMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    messageThreadId?: number,
  ): Promise<void> {
    const formatted = convertMarkdownToTelegram(text);
    await this.sendWithRetry(
      () =>
        this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          formatted,
          { parse_mode: "MarkdownV2" },
        ),
      // Fallback: Telegram rejected the MarkdownV2 — edit with the raw text so
      // the user sees the content unformatted rather than a stale message.
      () =>
        this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          cleanText(text),
        ),
    );
    logger.info(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        chatId,
        messageId,
        messageThreadId,
      },
      "Message edited",
    );
  }

  /**
   * Sets a single emoji reaction on a Telegram message, or clears the bot's
   * reactions when `emoji` is undefined. Used by the connector `react_message`
   * capability.
   */
  public async addReaction(
    chatId: number | string,
    messageId: number,
    emoji?: string,
  ): Promise<void> {
    await this.bot.telegram.setMessageReaction(
      chatId,
      messageId,
      // Telegram only accepts a fixed set of reaction emoji (the `TelegramEmoji`
      // union); the connector passes an arbitrary string, so cast and let
      // Telegram reject an unsupported emoji at the API boundary.
      emoji ? [{ type: "emoji", emoji } as ReactionType] : [],
    );
    logger.info(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        chatId,
        messageId,
        emoji: emoji ?? "(cleared)",
      },
      "Message reaction set",
    );
  }

  /**
   * Sends a message to a Telegram chat and emits appropriate events
   * @param {number | string} chatId - The Telegram chat ID to send the message to
   * @param {Content} content - The content to send
   * @param {number} [replyToMessageId] - Optional message ID to reply to
   * @returns {Promise<Message.TextMessage[]>} The sent messages. An empty
   *   array means there was nothing to send (attachments-only or blank text),
   *   not that Telegram rejected the send.
   * @throws {ElizaError} `TELEGRAM_OUTBOUND_SEND_FAILED` when the Bot API
   *   rejects the send; `TELEGRAM_OUTBOUND_PERSIST_FAILED` when Telegram
   *   accepted the send but local memory/event evidence could not be written.
   */
  public async sendMessage(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<Message.TextMessage[]> {
    return (
      await this.sendMessageWithEvidence(
        chatId,
        content,
        replyToMessageId,
        messageThreadId,
      )
    ).messages;
  }

  /** Returns complete text delivery evidence; legacy media dispatch remains unconfirmed. */
  public async sendMessageWithReceipt(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<SendHandlerOutcome | undefined> {
    if (content.attachments?.length) {
      await this.sendMessage(
        chatId,
        content,
        replyToMessageId,
        messageThreadId,
      );
      return undefined;
    }
    try {
      const result = await this.sendMessageWithEvidence(
        chatId,
        content,
        replyToMessageId,
        messageThreadId,
      );
      if (!result.messages.length)
        return {
          kind: "not_delivered",
          code: "TELEGRAM_EMPTY_MESSAGE",
          message: "No text or interaction was supplied.",
        };
      return {
        kind: "delivered",
        receipt: telegramReceipt(result.messages, result.memories),
        memories: result.memories,
      };
    } catch (error) {
      // error-policy:J1 translate known provider acceptance into a structural outcome, preserving uncertainty otherwise.
      if (!(error instanceof TelegramOutboundEvidenceError)) throw error;
      const receipt = telegramReceipt(
        error.acceptedMessages,
        error.persistedMemories,
      );
      if (error.phase === "transport")
        return {
          kind: "partially_delivered",
          receipt: {
            ...receipt,
            persistence: {
              status: "not_attempted",
              reason: "A later chunk failed before local persistence began.",
            },
          },
          memories: error.persistedMemories,
          code: error.code,
          message: error.message,
        };
      const failures = error.acceptedMessages
        .slice(error.persistedMemories.length)
        .map((message) => ({
          providerMessageId: String(message.message_id),
          stage: "memory" as const,
          code: error.code,
          message: error.message,
        }));
      if (!failures.length)
        failures.push({
          providerMessageId:
            receipt.providerMessageIds[receipt.providerMessageIds.length - 1],
          stage: "memory",
          code: error.code,
          message: error.message,
        });
      return {
        kind: "delivered",
        receipt: {
          ...receipt,
          persistence: error.persistedMemories.length
            ? {
                status: "partial",
                memoryIds: error.persistedMemories.map(telegramMemoryId),
                failures,
              }
            : { status: "failed", failures },
        },
        memories: error.persistedMemories,
      };
    }
  }

  private async sendMessageWithEvidence(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<{ messages: Message.TextMessage[]; memories: Memory[] }> {
    let sentMessages: Message.TextMessage[];
    try {
      // Create a context-like object for sending
      const ctx = {
        chat: { id: chatId },
        telegram: this.bot.telegram,
      };

      sentMessages = await this.sendMessageInChunks(
        ctx as Context,
        content,
        replyToMessageId,
        messageThreadId,
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending message to Telegram",
      );
      // error-policy:J2 Transport failure must not collapse to the same empty
      // array `sendMessageInChunks` returns when there is nothing to send.
      // `TelegramService.handleSendMessage` only rethrows if we throw here;
      // returning [] made a 403/400 look like a successful no-op send.
      throw error instanceof ElizaError
        ? error
        : new ElizaError("Telegram outbound send failed", {
            code: "TELEGRAM_OUTBOUND_SEND_FAILED",
            cause: error,
            context: {
              accountId: this.accountId,
              chatId: String(chatId),
            },
          });
    }

    if (!sentMessages.length) {
      return { messages: [], memories: [] };
    }

    const memories: Memory[] = [];
    try {
      // Create group ID
      const roomKey = messageThreadId
        ? `${chatId.toString()}-${messageThreadId}`
        : chatId.toString();
      const roomId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(roomKey),
      );

      // Create memories for the sent messages
      const contentMetadata =
        content.metadata &&
        typeof content.metadata === "object" &&
        !Array.isArray(content.metadata)
          ? content.metadata
          : {};
      for (const sentMessage of sentMessages) {
        const memory: Memory = {
          id: createUniqueUuid(
            this.runtime,
            this.telegramMessageMemoryKey(
              sentMessage.chat.id,
              sentMessage.message_id,
            ),
          ),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...content,
            text: sentMessage.text,
            source: "telegram",
            metadata: { ...contentMetadata, accountId: this.accountId },
            channelType: getChannelType({
              id:
                typeof chatId === "string"
                  ? Number.parseInt(chatId, 10)
                  : chatId,
              type: "private", // Default to private, will be overridden if in context
            } as Chat),
            ...(messageThreadId
              ? {
                  metadata: {
                    ...contentMetadata,
                    accountId: this.accountId,
                    threadId: messageThreadId,
                  },
                }
              : {}),
          },
          metadata: {
            type: "message",
            source: "telegram",
            accountId: this.accountId,
            provider: "telegram",
            fromBot: true,
            fromId: this.runtime.agentId,
            sourceId: this.runtime.agentId,
            messageIdFull: sentMessage.message_id.toString(),
            telegram: {
              chatId: sentMessage.chat.id.toString(),
              messageId: sentMessage.message_id.toString(),
              threadId: messageThreadId?.toString(),
            },
          } satisfies Memory["metadata"],
          createdAt: sentMessage.date * 1000,
        };

        await this.runtime.createMemory(memory, "messages");
        memories.push(memory);
      }

      // Emit both generic and platform-specific message sent events
      if (memories.length > 0) {
        const firstMemory = memories[0];
        this.runtime.emitEvent(EventType.MESSAGE_SENT, {
          runtime: this.runtime,
          message: firstMemory,
          source: "telegram",
          accountId: this.accountId,
          metadata: { accountId: this.accountId },
        } as MessagePayload & {
          accountId: string;
          metadata: { accountId: string };
        });

        // Also emit platform-specific event
        const telegramMessageSentPayload = {
          runtime: this.runtime,
          source: "telegram",
          accountId: this.accountId,
          metadata: { accountId: this.accountId },
          originalMessages: sentMessages,
          chatId,
          message: firstMemory,
        } as TelegramMessageSentPayload & {
          accountId: string;
          metadata: { accountId: string };
        };
        this.runtime.emitEvent(
          TelegramEventTypes.MESSAGE_SENT as string,
          telegramMessageSentPayload,
        );
      }

      return { messages: sentMessages, memories };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error persisting a Telegram message that the Bot API already accepted",
      );
      // error-policy:J2 Local persist/event failure after Telegram accepted the
      // send. Returning [] would look like "nothing sent" and invite a retry
      // that duplicates the visible message; rethrow with the provider ids in
      // context so the connector boundary can fail without claiming silence.
      throw new TelegramOutboundEvidenceError(
        "persistence",
        sentMessages,
        memories,
        error,
        this.accountId,
        String(chatId),
      );
    }
  }
}
