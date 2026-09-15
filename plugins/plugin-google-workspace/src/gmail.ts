/**
 * `GoogleGmailClient` — all Gmail operations behind the workspace service: raw
 * message search/get/send, plus the enriched triage layer (unread/importance
 * scoring, reply-needed detection, unresponded-thread scanning), label/state
 * mutation, subscription-header extraction, and sender-filter/unsubscribe
 * helpers. Maps Gmail API payloads into the plugin's `GoogleGmail*` DTOs. Each
 * method acquires a scoped googleapis client from `GoogleApiClientFactory`.
 * MIME `parts` trees are bounded in `gmail-mime-parts.ts` so a hostile nest
 * cannot RangeError ingest.
 */

import { Buffer } from "node:buffer";
import { ElizaError, stripHtmlRawTextElements } from "@elizaos/core";
import type { gmail_v1 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import {
  extractGmailMimeBody,
  snapshotGmailMimePart,
  walkGmailMimeParts,
} from "./gmail-mime-parts.js";
import type {
  GoogleAccountRef,
  GoogleEmailAddress,
  GoogleGmailBulkOperation,
  GoogleGmailDraftResult,
  GoogleGmailFilterCreateResult,
  GoogleGmailHistoryChange,
  GoogleGmailHistoryMessageRef,
  GoogleGmailHistoryPage,
  GoogleGmailMessageDetail,
  GoogleGmailMessageSummary,
  GoogleGmailMutationReceipt,
  GoogleGmailSearchPage,
  GoogleGmailSendResult,
  GoogleGmailSubscriptionMessageHeaders,
  GoogleGmailUnrespondedThread,
  GoogleMessageSummary,
  GoogleParsedMailto,
  GoogleSendEmailInput,
} from "./types.js";

const MESSAGE_METADATA_HEADERS = ["Subject", "From", "To", "Date"];
const GMAIL_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Reply-To",
  "Message-Id",
  "References",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;
const SUBSCRIPTION_SCAN_QUERY_DEFAULT =
  "(category:promotions OR category:updates OR list:* OR unsubscribe) newer_than:180d";
const GMAIL_LIST_PAGE_SIZE = 500;
const GMAIL_METADATA_CONCURRENCY = 25;

interface GmailPaginationState {
  seenPageTokens: Set<string>;
}

function createGmailPaginationState(): GmailPaginationState {
  return { seenPageTokens: new Set<string>() };
}

// Both searchGmailMessages and getGmailSubscriptionHeaders loop `while
// (results.length < limit)`, but a page with zero mapped messages (e.g. every
// message.id was blank, or the API returned an empty page with a distinct
// nextPageToken) never grows that count. Without this guard, an API or proxy
// that keeps minting novel page tokens on empty pages loops forever.
function nextGmailPageToken(
  value: string | null | undefined,
  state: GmailPaginationState,
  resource: string
): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  // Google page tokens are opaque. Whitespace-only values are terminal, but
  // a non-empty token must be replayed byte-for-byte rather than normalized.
  const token = value;
  if (state.seenPageTokens.has(token)) {
    throw new ElizaError(`Gmail repeated a ${resource} page token.`, {
      code: "GOOGLE_GMAIL_PAGINATION_LOOP",
      context: { resource },
      severity: "fatal",
    });
  }
  state.seenPageTokens.add(token);
  return token;
}

export class GoogleGmailClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async getGmailHistoryId(params: GoogleAccountRef): Promise<string> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getHistoryId");
    const response = await gmail.users.getProfile({ userId: "me" });
    const historyId = response.data.historyId?.trim();
    if (!historyId) {
      throw new ElizaError("Gmail profile did not include a history cursor.", {
        code: "GOOGLE_GMAIL_HISTORY_CURSOR_MISSING",
        severity: "fatal",
      });
    }
    return historyId;
  }

  async listGmailHistoryPage(
    params: GoogleAccountRef & {
      startHistoryId: string;
      pageToken?: string;
      maxResults?: number;
    }
  ): Promise<GoogleGmailHistoryPage> {
    const startHistoryId = params.startHistoryId.trim();
    if (!startHistoryId) {
      throw new ElizaError("Gmail incremental sync requires a history cursor.", {
        code: "GOOGLE_GMAIL_HISTORY_CURSOR_REQUIRED",
        severity: "fatal",
      });
    }
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.listHistory");
    try {
      const response = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        pageToken: params.pageToken,
        maxResults: normalizedLimit(params.maxResults, 500, 500),
      });
      const historyId = response.data.historyId?.trim() || startHistoryId;
      return {
        changes: (response.data.history ?? []).map(mapGmailHistoryChange),
        nextPageToken: response.data.nextPageToken?.trim() || null,
        historyId,
      };
    } catch (error) {
      // error-policy:J2 A 404 from history.list means Google expired the
      // cursor; rethrow as the typed resync signal with the cause preserved.
      if (googleErrorStatus(error) === 404) {
        throw new GoogleGmailHistoryExpiredError(startHistoryId, error);
      }
      throw error;
    }
  }

  async searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.searchMessages");
    const limit = explicitPositiveLimit(params.limit, "limit");
    const results: GoogleMessageSummary[] = [];
    const pagination = createGmailPaginationState();
    let pageToken: string | undefined;

    while (limit === undefined || results.length < limit) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: params.query,
        maxResults:
          limit === undefined
            ? GMAIL_LIST_PAGE_SIZE
            : Math.min(GMAIL_LIST_PAGE_SIZE, limit - results.length),
        pageToken,
      });
      const page = await mapWithConcurrency(
        (response.data.messages ?? []).filter((message) => message.id),
        GMAIL_METADATA_CONCURRENCY,
        (message) =>
          this.getMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId: message.id as string,
            includeBody: false,
          })
      );
      results.push(...page);
      if (limit !== undefined && results.length >= limit) {
        break;
      }
      pageToken = nextGmailPageToken(response.data.nextPageToken, pagination, "message search");
      if (!pageToken) {
        break;
      }
    }
    return results;
  }

  async getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getMessage");
    return this.getMessageWithClient(gmail, params);
  }

  async sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.send"], "gmail.sendEmail");
    const raw = encodeMessage(params);
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: params.threadId,
      },
    });

    return {
      id: response.data.id ?? "",
      threadId: response.data.threadId ?? undefined,
    };
  }

  async listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]> {
    return this.searchGmailMessages({
      accountId: params.accountId,
      selfEmail: params.selfEmail,
      maxResults: params.maxResults,
      query: "in:inbox",
    });
  }

  async searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.searchGmailMessages"
    );
    const maxResults = explicitPositiveLimit(params.maxResults, "maxResults");
    const messages: GoogleGmailMessageSummary[] = [];
    const pagination = createGmailPaginationState();
    let pageToken: string | undefined;

    while (maxResults === undefined || messages.length < maxResults) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: params.query,
        includeSpamTrash: params.includeSpamTrash === true,
        maxResults:
          maxResults === undefined
            ? GMAIL_LIST_PAGE_SIZE
            : Math.min(GMAIL_LIST_PAGE_SIZE, maxResults - messages.length),
        pageToken,
      });
      const pageMessages = await mapWithConcurrency(
        response.data.messages ?? [],
        GMAIL_METADATA_CONCURRENCY,
        async (messageRef) => {
          const messageId = messageRef.id?.trim();
          if (!messageId) {
            return null;
          }
          return this.getRichMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId,
            selfEmail: params.selfEmail,
          });
        }
      );
      for (const message of pageMessages) {
        if (message) {
          messages.push(message);
        }
      }
      if (maxResults !== undefined && messages.length >= maxResults) {
        break;
      }
      pageToken = nextGmailPageToken(response.data.nextPageToken, pagination, "message search");
      if (!pageToken) {
        break;
      }
    }

    return sortGmailMessages(messages);
  }

  /**
   * Fetches exactly one provider page of a search so callers that must cover a
   * whole time range can walk pages until the provider stops returning a
   * token. Unlike searchGmailMessages there is no caller-side ceiling: the
   * returned page is complete for that token and the token is the only
   * continuation state.
   */
  async searchGmailMessagesPage(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      pageToken?: string | null;
      pageSize?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailSearchPage> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.searchGmailMessagesPage"
    );
    const response = await gmail.users.messages.list({
      userId: "me",
      q: params.query,
      includeSpamTrash: params.includeSpamTrash === true,
      maxResults: normalizedLimit(params.pageSize, GMAIL_LIST_PAGE_SIZE, GMAIL_LIST_PAGE_SIZE),
      pageToken: params.pageToken ?? undefined,
    });
    const pageMessages = await mapWithConcurrency(
      response.data.messages ?? [],
      GMAIL_METADATA_CONCURRENCY,
      async (messageRef) => {
        const messageId = messageRef.id?.trim();
        if (!messageId) {
          return null;
        }
        return this.getRichMessageWithClient(gmail, {
          accountId: params.accountId,
          messageId,
          selfEmail: params.selfEmail,
        });
      }
    );
    const messages: GoogleGmailMessageSummary[] = [];
    for (const message of pageMessages) {
      if (message) {
        messages.push(message);
      }
    }
    return {
      messages: sortGmailMessages(messages),
      nextPageToken: response.data.nextPageToken?.trim() || null,
    };
  }

  async getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getGmailMessage");
    return this.getRichMessageWithClient(gmail, params);
  }

  async getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.getGmailMessageDetail"
    );
    const response = await gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: "full",
    });
    const message = mapRichMessage(response.data, params.selfEmail ?? null);
    if (!message) {
      return null;
    }
    return {
      message,
      bodyText: extractGoogleGmailBody(response.data.payload).trim() || message.snippet,
    };
  }

  async getGmailThread(
    params: GoogleAccountRef & { threadId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getGmailThread");
    const response = await gmail.users.threads.get({
      userId: "me",
      id: params.threadId,
      format: "metadata",
      metadataHeaders: [...GMAIL_METADATA_HEADERS],
    });
    return (response.data.messages ?? [])
      .map((message) => mapRichMessage(message, params.selfEmail ?? null))
      .filter((message): message is GoogleGmailMessageSummary => message !== null)
      .sort((left, right) => {
        const leftTime = Number.isFinite(Date.parse(left.receivedAt))
          ? Date.parse(left.receivedAt)
          : 0;
        const rightTime = Number.isFinite(Date.parse(right.receivedAt))
          ? Date.parse(right.receivedAt)
          : 0;
        return leftTime - rightTime;
      });
  }

  async listGmailUnrespondedThreads(
    params: GoogleAccountRef & {
      selfEmail?: string | null;
      olderThanDays?: number;
      maxResults?: number;
      now?: Date;
    }
  ): Promise<GoogleGmailUnrespondedThread[]> {
    const olderThanDays = normalizedLimit(params.olderThanDays, 3, 3650);
    const maxResults = explicitPositiveLimit(params.maxResults, "maxResults");
    const selfEmail = params.selfEmail?.trim().toLowerCase() || null;
    const sentCandidates = await this.searchGmailMessages({
      accountId: params.accountId,
      selfEmail,
      query: `in:sent older_than:${olderThanDays}d`,
    });
    const seenThreads = new Set<string>();
    const threads: GoogleGmailUnrespondedThread[] = [];
    const now = params.now ?? new Date();

    for (const sentMessage of sentCandidates) {
      if (seenThreads.has(sentMessage.threadId)) {
        continue;
      }
      seenThreads.add(sentMessage.threadId);
      const threadMessages = await this.getGmailThread({
        accountId: params.accountId,
        selfEmail,
        threadId: sentMessage.threadId,
      });
      const humanMessages = threadMessages.filter((message) => !isAutomatedMessage(message));
      const lastOutbound = [...humanMessages]
        .reverse()
        .find((message) => isMessageFromSelf(message, selfEmail));
      if (!lastOutbound) {
        continue;
      }
      const lastOutboundAtMs = Date.parse(lastOutbound.receivedAt);
      if (!Number.isFinite(lastOutboundAtMs)) {
        continue;
      }
      const hasLaterInbound = humanMessages.some(
        (message) =>
          !isMessageFromSelf(message, selfEmail) &&
          Date.parse(message.receivedAt) > lastOutboundAtMs
      );
      if (hasLaterInbound) {
        continue;
      }
      const ageMs = now.getTime() - lastOutboundAtMs;
      if (ageMs < olderThanDays * 24 * 60 * 60 * 1000) {
        continue;
      }
      const lastInbound = [...humanMessages]
        .reverse()
        .find((message) => !isMessageFromSelf(message, selfEmail));
      threads.push({
        threadId: lastOutbound.threadId,
        externalMessageId: lastOutbound.externalId,
        subject: lastOutbound.subject,
        to: lastOutbound.to,
        cc: lastOutbound.cc,
        lastOutboundAt: lastOutbound.receivedAt,
        lastInboundAt: lastInbound?.receivedAt ?? null,
        daysWaiting: Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000))),
        snippet: lastOutbound.snippet,
        labels: lastOutbound.labels,
        htmlLink: lastOutbound.htmlLink,
      });
    }

    const sorted = threads.sort(compareUnrespondedThreads);
    return maxResults === undefined ? sorted : sorted.slice(0, maxResults);
  }

  async modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<GoogleGmailMutationReceipt> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.manage"], "gmail.modifyMessages");
    const ids = [
      ...new Set(params.messageIds.map((messageId) => messageId.trim()).filter(Boolean)),
    ];
    if (ids.length === 0) {
      throw new Error("Gmail operation requires message ids");
    }
    const labelIds = requireLabelIdsForOperation(params.operation, params.labelIds);

    if (params.operation === "trash") {
      const outcomes = await Promise.allSettled(
        ids.map((id) => gmail.users.messages.trash({ userId: "me", id }))
      );
      const succeededMessageIds: string[] = [];
      const failures: GoogleGmailMutationReceipt["failures"] = [];
      for (const [index, outcome] of outcomes.entries()) {
        const messageId = ids[index] as string;
        if (outcome.status === "fulfilled") {
          succeededMessageIds.push(messageId);
          continue;
        }
        const code = googleErrorStatus(outcome.reason) ?? null;
        failures.push({
          messageId,
          code,
          retryable: code === null || code === 408 || code === 429 || code >= 500,
        });
      }
      return {
        operation: params.operation,
        requestedMessageIds: ids,
        succeededMessageIds,
        failures,
      };
    }
    if (params.operation === "delete") {
      await gmail.users.messages.batchDelete({
        userId: "me",
        requestBody: { ids },
      });
      return {
        operation: params.operation,
        requestedMessageIds: ids,
        succeededMessageIds: ids,
        failures: [],
      };
    }

    const labelPatch = labelsForOperation(params.operation, labelIds);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        addLabelIds: labelPatch.addLabelIds,
        removeLabelIds: labelPatch.removeLabelIds,
      },
    });
    return {
      operation: params.operation,
      requestedMessageIds: ids,
      succeededMessageIds: ids,
      failures: [],
    };
  }

  async sendGmailReply(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailSendResult> {
    const raw = encodeRawGmailMessage([
      `To: ${sanitizeMailHeaderValue(params.to.join(", "))}`,
      ...(params.cc && params.cc.length > 0
        ? [`Cc: ${sanitizeMailHeaderValue(params.cc.join(", "))}`]
        : []),
      `Subject: ${encodeMailSubject(normalizeReplySubject(params.subject))}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      ...(params.inReplyTo ? [`In-Reply-To: ${sanitizeMailHeaderValue(params.inReplyTo)}`] : []),
      ...(params.references ? [`References: ${sanitizeMailHeaderValue(params.references)}`] : []),
      "",
      params.bodyText.replace(/\r?\n/g, "\r\n"),
    ]);
    return this.sendRawGmailMessage(params, raw, "gmail.sendGmailReply");
  }

  async sendGmailMessage(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<GoogleGmailSendResult> {
    const raw = encodeRawGmailMessage([
      `To: ${sanitizeMailHeaderValue(params.to.join(", "))}`,
      ...(params.cc && params.cc.length > 0
        ? [`Cc: ${sanitizeMailHeaderValue(params.cc.join(", "))}`]
        : []),
      ...(params.bcc && params.bcc.length > 0
        ? [`Bcc: ${sanitizeMailHeaderValue(params.bcc.join(", "))}`]
        : []),
      `Subject: ${encodeMailSubject(params.subject.trim() || "(no subject)")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      params.bodyText.replace(/\r?\n/g, "\r\n"),
    ]);
    return this.sendRawGmailMessage(params, raw, "gmail.sendGmailMessage");
  }

  async createGmailDraft(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
      threadId?: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailDraftResult> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.compose"], "gmail.createDraft");
    const raw = encodeRawGmailMessage([
      `To: ${sanitizeMailHeaderValue(params.to.join(", "))}`,
      ...(params.cc?.length ? [`Cc: ${sanitizeMailHeaderValue(params.cc.join(", "))}`] : []),
      ...(params.bcc?.length ? [`Bcc: ${sanitizeMailHeaderValue(params.bcc.join(", "))}`] : []),
      `Subject: ${encodeMailSubject(params.subject.trim() || "(no subject)")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      ...(params.inReplyTo ? [`In-Reply-To: ${sanitizeMailHeaderValue(params.inReplyTo)}`] : []),
      ...(params.references ? [`References: ${sanitizeMailHeaderValue(params.references)}`] : []),
      "",
      params.bodyText.replace(/\r?\n/g, "\r\n"),
    ]);
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: params.threadId } },
    });
    const draftId = response.data.id?.trim();
    if (!draftId) {
      throw new ElizaError("Gmail draft creation returned no provider draft id.", {
        code: "GOOGLE_GMAIL_DRAFT_RECEIPT_MISSING",
        severity: "fatal",
      });
    }
    return {
      draftId,
      messageId: response.data.message?.id ?? null,
      threadId: response.data.message?.threadId ?? null,
      labelIds: response.data.message?.labelIds ?? [],
    };
  }

  async getGmailSubscriptionHeaders(
    params: GoogleAccountRef & { query?: string; maxMessages?: number }
  ): Promise<GoogleGmailSubscriptionMessageHeaders[]> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.getSubscriptionHeaders"
    );
    const query = params.query?.trim() || SUBSCRIPTION_SCAN_QUERY_DEFAULT;
    const maxMessages = explicitPositiveLimit(params.maxMessages, "maxMessages");
    const results: GoogleGmailSubscriptionMessageHeaders[] = [];
    const pagination = createGmailPaginationState();
    let pageToken: string | undefined;

    while (maxMessages === undefined || results.length < maxMessages) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        includeSpamTrash: false,
        maxResults: maxMessages === undefined ? 100 : Math.min(100, maxMessages - results.length),
        pageToken,
      });
      const batch = await mapWithConcurrency(
        response.data.messages ?? [],
        GMAIL_METADATA_CONCURRENCY,
        async (messageRef) => {
          const messageId = messageRef.id?.trim();
          if (!messageId) {
            return null;
          }
          const rich = await this.getRichMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId,
          });
          return rich ? mapSubscriptionHeaders(rich) : null;
        }
      );
      for (const headers of batch) {
        if (headers) {
          results.push(headers);
        }
      }
      if (maxMessages !== undefined && results.length >= maxMessages) {
        break;
      }
      pageToken = nextGmailPageToken(
        response.data.nextPageToken,
        pagination,
        "subscription header scan"
      );
      if (!pageToken) {
        break;
      }
    }

    return results;
  }

  async createGmailFilterForSender(
    params: GoogleAccountRef & { fromAddress: string; trash?: boolean }
  ): Promise<GoogleGmailFilterCreateResult> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.manage"],
      "gmail.createFilterForSender"
    );
    const response = await gmail.users.settings.filters.create({
      userId: "me",
      requestBody: {
        criteria: { from: params.fromAddress },
        action: params.trash
          ? { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] }
          : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] },
      },
    });
    return {
      filterId: response.data.id ?? null,
      trashed: true,
    };
  }

  async trashGmailThread(params: GoogleAccountRef & { threadId: string }): Promise<void> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.manage"], "gmail.trashThread");
    await gmail.users.threads.trash({
      userId: "me",
      id: params.threadId,
    });
  }

  async modifyGmailMessageLabels(
    params: GoogleAccountRef & {
      messageId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    }
  ): Promise<void> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.manage"],
      "gmail.modifyMessageLabels"
    );
    await gmail.users.messages.modify({
      userId: "me",
      id: params.messageId,
      requestBody: {
        addLabelIds: params.addLabelIds ?? [],
        removeLabelIds: params.removeLabelIds ?? [],
      },
    });
  }

  async sendMailtoUnsubscribeEmail(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<void> {
    await this.sendGmailMessage({
      accountId: params.accountId,
      to: [params.mailto.recipient],
      subject: params.mailto.subject ?? "unsubscribe",
      bodyText: params.mailto.body ?? "unsubscribe",
    });
  }

  private async getMessageWithClient(
    gmail: gmail_v1.Gmail,
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    const response = await gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: params.includeBody ? "full" : "metadata",
      metadataHeaders: MESSAGE_METADATA_HEADERS,
    });

    return mapMessage(response.data, Boolean(params.includeBody));
  }

  private async getRichMessageWithClient(
    gmail: gmail_v1.Gmail,
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: params.messageId,
        format: "metadata",
        metadataHeaders: [...GMAIL_METADATA_HEADERS],
      });
      return mapRichMessage(response.data, params.selfEmail ?? null);
    } catch (error) {
      if (googleErrorStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  private async sendRawGmailMessage(
    params: GoogleAccountRef,
    raw: string,
    reason: string
  ): Promise<GoogleGmailSendResult> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.send"], reason);
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return {
      messageId: response.data.id ?? null,
      threadId: response.data.threadId ?? null,
      labelIds: response.data.labelIds ?? [],
    };
  }
}

export class GoogleGmailHistoryExpiredError extends ElizaError {
  constructor(startHistoryId: string, cause: unknown) {
    super("Gmail history cursor expired; a bounded full resync is required.", {
      code: "GOOGLE_GMAIL_HISTORY_CURSOR_EXPIRED",
      context: { startHistoryId },
      cause,
      severity: "ephemeral",
    });
  }
}

function mapGmailHistoryMessageRef(
  message: gmail_v1.Schema$Message | null | undefined
): GoogleGmailHistoryMessageRef | null {
  const messageId = message?.id?.trim();
  if (!messageId) return null;
  return {
    messageId,
    threadId: message?.threadId?.trim() || null,
    labelIds: message?.labelIds ?? [],
  };
}

function mapGmailHistoryChange(history: gmail_v1.Schema$History): GoogleGmailHistoryChange {
  const historyId = history.id?.trim();
  if (!historyId) {
    throw new ElizaError("Gmail history response contained an entry without an id.", {
      code: "GOOGLE_GMAIL_HISTORY_ENTRY_INVALID",
      severity: "fatal",
    });
  }
  const refs = (values: Array<{ message?: gmail_v1.Schema$Message }> | null | undefined) =>
    (values ?? [])
      .map((value) => mapGmailHistoryMessageRef(value.message))
      .filter((value): value is GoogleGmailHistoryMessageRef => value !== null);
  const labelChanges = (
    values:
      | Array<{ message?: gmail_v1.Schema$Message; labelIds?: string[] | null }>
      | null
      | undefined
  ) =>
    (values ?? [])
      .map((value) => {
        const message = mapGmailHistoryMessageRef(value.message);
        return message ? { ...message, changedLabelIds: value.labelIds ?? [] } : null;
      })
      .filter(
        (value): value is GoogleGmailHistoryMessageRef & { changedLabelIds: string[] } =>
          value !== null
      );
  return {
    historyId,
    messagesAdded: refs(history.messagesAdded),
    messagesDeleted: refs(history.messagesDeleted),
    labelsAdded: labelChanges(history.labelsAdded),
    labelsRemoved: labelChanges(history.labelsRemoved),
  };
}

function mapMessage(message: gmail_v1.Schema$Message, includeBody: boolean): GoogleMessageSummary {
  const headers = message.payload?.headers ?? [];
  const dateHeader = headerValue(headers, "Date");
  const body = includeBody ? collectMessageBody(message.payload) : {};
  const headerMap = Object.fromEntries(
    headers
      .map((header) => [header.name?.trim() ?? "", header.value?.trim() ?? ""] as const)
      .filter(([name, value]) => name.length > 0 && value.length > 0)
  );

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? undefined,
    subject: headerValue(headers, "Subject"),
    from: parseEmailAddresses(headerValue(headers, "From"))[0],
    replyTo: parseEmailAddresses(headerValue(headers, "Reply-To"))[0],
    to: parseEmailAddresses(headerValue(headers, "To")),
    cc: parseEmailAddresses(headerValue(headers, "Cc")),
    snippet: message.snippet ?? undefined,
    receivedAt: dateHeader ? new Date(dateHeader).toISOString() : undefined,
    labelIds: message.labelIds ?? undefined,
    headers: headerMap,
    ...body,
  };
}

function mapRichMessage(
  message: gmail_v1.Schema$Message,
  selfEmail: string | null
): GoogleGmailMessageSummary | null {
  const externalId = message.id?.trim();
  const threadId = message.threadId?.trim();
  if (!externalId || !threadId) {
    return null;
  }
  const headers = message.payload?.headers ?? [];
  const subject = decodeHtmlEntities(headerValue(headers, "Subject") || "") || "(no subject)";
  const fromMailbox = parseEmailAddresses(headerValue(headers, "From"))[0] ?? null;
  const replyTo = headerValue(headers, "Reply-To");
  const replyToMailbox = parseEmailAddresses(replyTo)[0] ?? null;
  const to = parseEmailAddresses(headerValue(headers, "To")).map(formatAddressValue);
  const cc = parseEmailAddresses(headerValue(headers, "Cc")).map(formatAddressValue);
  const labels = (message.labelIds ?? []).map((label) => label.trim()).filter(Boolean);
  const receivedAt = internalDateToIso(message.internalDate);
  const precedence = headerValue(headers, "Precedence");
  const listId = headerValue(headers, "List-Id");
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  const triage = classifyReplyNeed({
    labels,
    fromEmail: fromMailbox?.email,
    to,
    cc,
    selfEmail,
    precedence,
    listId,
    autoSubmitted,
  });

  return {
    externalId,
    threadId,
    subject,
    from: fromMailbox?.name || fromMailbox?.email || "Unknown sender",
    fromEmail: fromMailbox?.email ? fromMailbox.email.toLowerCase() : null,
    replyTo: replyToMailbox?.email ?? replyToMailbox?.name ?? null,
    to,
    cc,
    snippet: normalizeSnippet(message.snippet),
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isImportant: triage.isImportant,
    likelyReplyNeeded: triage.likelyReplyNeeded,
    triageScore: triage.triageScore,
    triageReason: triage.triageReason,
    labels,
    htmlLink: deriveHtmlLink(threadId, selfEmail),
    metadata: {
      historyId: message.historyId?.trim() || null,
      sizeEstimate: typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
      dateHeader: headerValue(headers, "Date") || null,
      messageIdHeader: headerValue(headers, "Message-Id") || null,
      referencesHeader: headerValue(headers, "References") || null,
      listUnsubscribe: headerValue(headers, "List-Unsubscribe") || null,
      listUnsubscribePost: headerValue(headers, "List-Unsubscribe-Post") || null,
      listId: listId || null,
      precedence: precedence || null,
      autoSubmitted: autoSubmitted || null,
    },
  };
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string
): string | undefined {
  return (
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
  );
}

function parseEmailAddresses(value: string | undefined): GoogleEmailAddress[] {
  if (!value) {
    return [];
  }

  const addresses: GoogleEmailAddress[] = [];
  for (const token of splitAddressList(value)) {
    const mailbox = parseMailbox(token);
    if (mailbox) {
      addresses.push(mailbox);
    }
  }
  return addresses;
}

const MAX_ADDRESS_HEADER_LENGTH = 512 * 1024;
const MAX_ADDRESSES_PER_HEADER = 2_048;

// RFC 5322 address lists separate mailboxes with commas, but a comma is only a
// separator in the base list state. Inside a quoted string, an RFC comment, or
// an angle-addr route it is ordinary text, and a quoted-pair (`\x`) escapes the
// next character inside quoted strings and comments. A naive `value.split(",")`
// — or a scanner that toggles quote state on an escaped quote — cuts the common
// corporate "Last, First" mailbox in half and manufactures a phantom `"Smith`
// recipient. This bounded scanner tracks quoted strings, nested comments,
// quoted-pairs, and angle addresses, splits only in the base state, and fails
// closed when a context is left unterminated, a group is malformed, or the
// header exceeds explicit size/address-count limits, so malformed input can
// never inflate the recipient count or allocate an unbounded DTO.
function splitAddressList(value: string): string[] {
  // UTF-8 bytes, not UTF-16 code units, are the resource boundary. The cheap
  // length test prevents allocating an encoding buffer for obviously oversized
  // ASCII input; byteLength then closes the multibyte bypass.
  if (
    value.length > MAX_ADDRESS_HEADER_LENGTH ||
    Buffer.byteLength(value, "utf8") > MAX_ADDRESS_HEADER_LENGTH
  ) {
    return [];
  }

  // RFC 5322 2.2.3 folds long header lines as CRLF followed by WSP; the
  // continuation is part of the same logical value, not a structural break.
  // Unfold before scanning so a fold between a display name and its angle-addr
  // (or inside a quoted string) cannot split the mailbox: `parseMailbox`'s
  // address regex does not cross line breaks, so an unfolded fold silently
  // dropped the whole mailbox. Only CRLF/LF directly followed by space or tab
  // is a fold; a bare line break elsewhere stays malformed and fails closed
  // below.
  value = value.replace(/\r?\n(?=[ \t])/g, "");

  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let commentDepth = 0;
  let inAngle = false;
  let inDomainLiteral = false;
  let escaped = false;
  let inGroup = false;
  let needsGroupSeparator = false;

  const pushCurrent = (): boolean => {
    const token = current.trim();
    current = "";
    if (!token) {
      return true;
    }
    if (tokens.length >= MAX_ADDRESSES_PER_HEADER) {
      return false;
    }
    tokens.push(token);
    return true;
  };

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if ((inQuote || commentDepth > 0 || inDomainLiteral) && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (char === '"') {
        inQuote = false;
      }
      current += char;
      continue;
    }
    if (commentDepth > 0) {
      if (char === "(") {
        commentDepth += 1;
      } else if (char === ")") {
        commentDepth -= 1;
      }
      current += char;
      continue;
    }
    if (inDomainLiteral) {
      if (char === "]") {
        inDomainLiteral = false;
      }
      current += char;
      continue;
    }
    if (needsGroupSeparator) {
      if (/\s/.test(char)) {
        current += char;
        continue;
      }
      if (char === "(") {
        commentDepth += 1;
        current += char;
        continue;
      }
      if (char === ",") {
        current = "";
        needsGroupSeparator = false;
        continue;
      }
      return [];
    }
    if (char === '"') {
      inQuote = true;
      current += char;
      continue;
    }
    if (char === "(") {
      commentDepth += 1;
      current += char;
      continue;
    }
    if (char === "[") {
      inDomainLiteral = true;
      current += char;
      continue;
    }
    if (char === "<") {
      if (inAngle) {
        return [];
      }
      inAngle = true;
      current += char;
      continue;
    }
    if (char === ">") {
      if (!inAngle) {
        return [];
      }
      inAngle = false;
      current += char;
      continue;
    }
    if (char === ":" && !inAngle) {
      if (inGroup || !isPlausibleGroupLabel(current)) {
        return [];
      }
      inGroup = true;
      current = "";
      continue;
    }
    if (char === ";" && !inAngle) {
      if (!inGroup || !pushCurrent()) {
        return [];
      }
      inGroup = false;
      needsGroupSeparator = true;
      continue;
    }
    if (char === "," && !inAngle) {
      if (!pushCurrent()) {
        return [];
      }
      continue;
    }
    current += char;
  }

  if (inQuote || commentDepth > 0 || inAngle || inDomainLiteral || escaped || inGroup) {
    return [];
  }
  if (needsGroupSeparator) {
    return tokens;
  }
  return pushCurrent() ? tokens : [];
}

function isPlausibleGroupLabel(value: string): boolean {
  const label = stripMailboxComments(value).trim();
  if (!label) {
    return false;
  }
  let inQuote = false;
  let escaped = false;
  let hasContent = false;
  for (const char of label) {
    if (escaped) {
      escaped = false;
      hasContent = true;
      continue;
    }
    if (inQuote && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /[()<>@,;:\\[\]]/.test(char)) {
      return false;
    }
    if (!/\s/.test(char)) {
      hasContent = true;
    }
  }
  return hasContent && !inQuote && !escaped;
}

// Remove RFC 5322 comments (`(...)`, nestable, with quoted-pair escapes) from a
// mailbox token without disturbing text inside a quoted string. Comments are
// structural whitespace and never part of the display name or addr-spec, so a
// comma-bearing comment like `(Team, West)` must not survive into the parsed
// address.
function stripMailboxComments(value: string): string {
  let result = "";
  let inQuote = false;
  let commentDepth = 0;
  let inDomainLiteral = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      if (commentDepth === 0) {
        result += char;
      }
      escaped = false;
      continue;
    }
    if ((inQuote || commentDepth > 0 || inDomainLiteral) && char === "\\") {
      if (commentDepth === 0) {
        result += char;
      }
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (char === '"') {
        inQuote = false;
      }
      result += char;
      continue;
    }
    if (commentDepth > 0) {
      if (char === "(") {
        commentDepth += 1;
      } else if (char === ")") {
        commentDepth -= 1;
      }
      continue;
    }
    if (inDomainLiteral) {
      result += char;
      if (char === "]") {
        inDomainLiteral = false;
      }
      continue;
    }
    if (char === '"') {
      inQuote = true;
      result += char;
      continue;
    }
    if (char === "(") {
      commentDepth += 1;
      continue;
    }
    if (char === "[") {
      inDomainLiteral = true;
      result += char;
      continue;
    }
    result += char;
  }
  return result;
}

// A conservative addr-spec check so an arbitrary fragment (a truncated `"Smith`,
// a bare display name) is never presented as an email. Requires a single `@`
// with a non-empty dot-atom or quoted local part and a dot-atom or
// bracketed-literal domain, and no structural characters that only belong to
// display names, groups, or comments.
function isPlausibleEmailAddress(value: string): boolean {
  if (!value) {
    return false;
  }
  const at = findAddressSeparator(value);
  if (at <= 0 || at === value.length - 1) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!isPlausibleLocalPart(local)) {
    return false;
  }
  if (isBracketedDomainLiteral(domain)) {
    return true;
  }
  if (/[\s",()<>[\]\\@:;]/.test(domain)) {
    return false;
  }
  return !domain.startsWith(".") && !domain.endsWith(".") && !domain.includes("..");
}

function findAddressSeparator(value: string): number {
  let separator = -1;
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuote && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (char === "@" && !inQuote) {
      if (separator !== -1) {
        return -1;
      }
      separator = index;
    }
  }
  return inQuote || escaped ? -1 : separator;
}

function isPlausibleLocalPart(value: string): boolean {
  if (value.startsWith('"') || value.endsWith('"')) {
    if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
      return false;
    }
    let escaped = false;
    for (let index = 1; index < value.length - 1; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"' || char === "\r" || char === "\n") {
        return false;
      }
    }
    return !escaped;
  }
  if (/[\s",()<>[\]\\@:;]/.test(value)) {
    return false;
  }
  return !value.startsWith(".") && !value.endsWith(".") && !value.includes("..");
}

function isBracketedDomainLiteral(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return false;
  }
  let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      return false;
    }
    if (char === "]") {
      return false;
    }
  }
  return !escaped;
}

// Unquote and unescape an RFC 5322 quoted-string display name, preserving any
// commas or quotes that the quoted-pair rules protected.
function unquoteDisplayName(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return name.replace(/^"|"$/g, "").trim();
}

function collectMessageBody(
  part: gmail_v1.Schema$MessagePart | undefined
): Pick<GoogleMessageSummary, "bodyHtml" | "bodyText"> {
  if (!part) {
    return {};
  }

  const body: Pick<GoogleMessageSummary, "bodyHtml" | "bodyText"> = {};
  collectMessagePart(part, body);
  return body;
}

function collectMessagePart(
  part: gmail_v1.Schema$MessagePart,
  body: Pick<GoogleMessageSummary, "bodyHtml" | "bodyText">
): void {
  walkGmailMimeParts(part, (node) => {
    const data = node.body?.data ? decodeBase64Url(node.body.data) : undefined;

    if (data && node.mimeType === "text/plain" && !body.bodyText) {
      body.bodyText = data;
    }
    if (data && node.mimeType === "text/html" && !body.bodyHtml) {
      body.bodyHtml = data;
    }
  });
}

function encodeMessage(input: GoogleSendEmailInput): string {
  const headers = [
    `To: ${sanitizeMailHeaderValue(formatEmailAddresses(input.to))}`,
    input.cc?.length ? `Cc: ${sanitizeMailHeaderValue(formatEmailAddresses(input.cc))}` : undefined,
    input.bcc?.length
      ? `Bcc: ${sanitizeMailHeaderValue(formatEmailAddresses(input.bcc))}`
      : undefined,
    `Subject: ${encodeMailSubject(input.subject)}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const contentType = input.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  const body = input.html ?? input.text ?? "";
  const message = [...headers, `Content-Type: ${contentType}`, "", body].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

function formatEmailAddresses(addresses: readonly GoogleEmailAddress[]): string {
  return addresses
    .map((address) => (address.name ? `"${address.name}" <${address.email}>` : address.email))
    .join(", ");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function normalizedLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}

function explicitPositiveLimit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new ElizaError(`Gmail ${field} must be a positive integer.`, {
      code: "GOOGLE_GMAIL_LIMIT_INVALID",
      context: { field, value },
    });
  }
  return value;
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export function compareUnrespondedThreads(
  a: GoogleGmailUnrespondedThread,
  b: GoogleGmailUnrespondedThread
): number {
  const rightWaiting =
    typeof b.daysWaiting === "number" && Number.isFinite(b.daysWaiting) ? b.daysWaiting : 0;
  const leftWaiting =
    typeof a.daysWaiting === "number" && Number.isFinite(a.daysWaiting) ? a.daysWaiting : 0;
  return rightWaiting - leftWaiting || a.threadId.localeCompare(b.threadId);
}

export function sortGmailMessages(
  messages: GoogleGmailMessageSummary[]
): GoogleGmailMessageSummary[] {
  return [...messages].sort((left, right) => {
    if (left.isImportant !== right.isImportant) {
      return right.isImportant ? 1 : -1;
    }
    if (left.likelyReplyNeeded !== right.likelyReplyNeeded) {
      return right.likelyReplyNeeded ? 1 : -1;
    }
    if (left.isUnread !== right.isUnread) {
      return right.isUnread ? 1 : -1;
    }
    const rightTime =
      typeof right.receivedAt === "string" && Number.isFinite(Date.parse(right.receivedAt))
        ? Date.parse(right.receivedAt)
        : 0;
    const leftTime =
      typeof left.receivedAt === "string" && Number.isFinite(Date.parse(left.receivedAt))
        ? Date.parse(left.receivedAt)
        : 0;
    return rightTime - leftTime || left.externalId.localeCompare(right.externalId);
  });
}

// Parse a single RFC 5322 mailbox token into a validated address. An angle-addr
// (`Display Name <local@domain>`) yields the name and the bracketed addr-spec;
// a bare token is accepted only when it is itself a plausible addr-spec. RFC
// comments are stripped and quoted display names unquoted. A token with no
// plausible email resolves to `null` so callers never present an arbitrary
// fragment as an email address.
function parseMailbox(value: string): GoogleEmailAddress | null {
  const withoutComments = stripMailboxComments(value).trim();
  if (!withoutComments) {
    return null;
  }
  const match = withoutComments.match(/^(.*?)<([^<>]+)>\s*$/);
  if (match) {
    const name = unquoteDisplayName((match[1] ?? "").trim());
    const email = (match[2] ?? "").trim();
    if (!isPlausibleEmailAddress(email)) {
      return null;
    }
    return name ? { email, name } : { email };
  }
  if (isPlausibleEmailAddress(withoutComments)) {
    return { email: withoutComments };
  }
  return null;
}

function formatAddressValue(address: GoogleEmailAddress): string {
  return address.email || address.name || "";
}

function normalizeSnippet(value: string | null | undefined): string {
  return decodeHtmlEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function internalDateToIso(value: string | null | undefined): string {
  const ms = value ? Number(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function deriveHtmlLink(threadId: string, accountEmail: string | null): string {
  const accountSegment =
    accountEmail && accountEmail.trim().length > 0
      ? encodeURIComponent(accountEmail.trim().toLowerCase())
      : "0";
  return `https://mail.google.com/mail/u/${accountSegment}/#all/${encodeURIComponent(threadId)}`;
}

function classifyReplyNeed(args: {
  labels: string[];
  fromEmail: string | null | undefined;
  to: string[];
  cc: string[];
  selfEmail: string | null;
  precedence: string | undefined;
  listId: string | undefined;
  autoSubmitted: string | undefined;
}): {
  likelyReplyNeeded: boolean;
  isImportant: boolean;
  triageScore: number;
  triageReason: string;
} {
  const labels = new Set(args.labels.map((label) => label.trim().toUpperCase()));
  const isUnread = labels.has("UNREAD");
  const explicitlyImportant = labels.has("IMPORTANT");
  const selfEmail = args.selfEmail?.trim().toLowerCase() || null;
  const fromEmail = args.fromEmail?.trim().toLowerCase() || null;
  const directRecipients = [...args.to, ...args.cc].map((entry) => entry.trim().toLowerCase());
  const directlyAddressed = selfEmail ? directRecipients.includes(selfEmail) : false;
  const fromSelf = Boolean(selfEmail && fromEmail && selfEmail === fromEmail);
  const precedence = args.precedence?.trim().toLowerCase();
  const autoSubmitted = args.autoSubmitted?.trim().toLowerCase();
  const automated =
    Boolean(args.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted !== undefined && autoSubmitted !== "no");
  const likelyReplyNeeded = !automated && !fromSelf && isUnread && directlyAddressed;
  const isImportant = explicitlyImportant || likelyReplyNeeded;
  const triageSignals = [
    explicitlyImportant ? "gmail-important-label" : null,
    likelyReplyNeeded ? "direct-unread-reply-needed" : null,
    isUnread ? "unread" : null,
    automated ? "automated-header" : null,
    fromSelf ? "sent-by-self" : null,
  ].filter((signal): signal is string => Boolean(signal));

  return {
    likelyReplyNeeded,
    isImportant,
    triageScore: isImportant ? 2 : isUnread ? 1 : 0,
    triageReason: triageSignals.join(", ") || "recent inbox message",
  };
}

function isMessageFromSelf(message: GoogleGmailMessageSummary, selfEmail: string | null): boolean {
  const labels = new Set(message.labels.map((label) => label.toUpperCase()));
  if (labels.has("SENT")) {
    return true;
  }
  const fromEmail = message.fromEmail?.trim().toLowerCase() || null;
  return Boolean(selfEmail && fromEmail && fromEmail === selfEmail);
}

function isAutomatedMessage(message: GoogleGmailMessageSummary): boolean {
  const precedence =
    typeof message.metadata.precedence === "string"
      ? message.metadata.precedence.trim().toLowerCase()
      : "";
  const autoSubmitted =
    typeof message.metadata.autoSubmitted === "string"
      ? message.metadata.autoSubmitted.trim().toLowerCase()
      : "";
  return (
    Boolean(message.metadata.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted.length > 0 && autoSubmitted !== "no")
  );
}

function requireLabelIdsForOperation(
  operation: GoogleGmailBulkOperation,
  labelIds: readonly string[] | undefined
): string[] {
  const labels = (labelIds ?? []).map((labelId) => labelId.trim()).filter(Boolean);
  if ((operation === "apply_label" || operation === "remove_label") && labels.length === 0) {
    throw new Error(`${operation} requires at least one labelId`);
  }
  return labels;
}

function labelsForOperation(
  operation: GoogleGmailBulkOperation,
  labelIds: string[]
): { addLabelIds?: string[]; removeLabelIds?: string[] } {
  const labels: Record<
    GoogleGmailBulkOperation,
    { addLabelIds?: string[]; removeLabelIds?: string[] }
  > = {
    archive: { removeLabelIds: ["INBOX"] },
    trash: {},
    delete: {},
    report_spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
    mark_read: { removeLabelIds: ["UNREAD"] },
    mark_unread: { addLabelIds: ["UNREAD"] },
    apply_label: { addLabelIds: labelIds },
    remove_label: { removeLabelIds: labelIds },
  };
  return labels[operation];
}

/**
 * Collapses CR/LF sequences in caller-supplied header values so LLM-composed
 * subjects or recipient strings cannot inject additional MIME headers (for
 * example a smuggled `Bcc:`) into the raw message.
 */
function sanitizeMailHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Uses RFC 2047 encoded words for Unicode, long subjects and literal encoded-word
 * syntax. Each word stays within the MIME line limit, including the Subject
 * prefix; code-point iteration preserves every UTF-8 character across folds.
 */
function encodeMailSubject(value: string): string {
  const subject = sanitizeMailHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(subject) && subject.length <= 67 && !subject.includes("=?")) {
    return subject;
  }
  const words: string[] = [];
  let chunk = "";
  let byteLength = 0;
  for (const character of subject) {
    const size = Buffer.byteLength(character, "utf8");
    // 39 UTF-8 bytes produce a 64-character encoded word and a 73-character first line.
    if (byteLength + size > 39) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      byteLength = 0;
    }
    chunk += character;
    byteLength += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words.join("\r\n ");
}

function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "Re: your message";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function encodeRawGmailMessage(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

function extractGoogleGmailBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plainText = extractGoogleGmailBodyByMime(payload, "text/plain");
  if (plainText) {
    return plainText;
  }
  const htmlText = extractGoogleGmailBodyByMime(payload, "text/html");
  if (htmlText) {
    return htmlText;
  }
  if (!payload) {
    return "";
  }
  const snapshot = snapshotGmailMimePart(payload);
  const directBody = snapshot.body?.data;
  if (typeof directBody === "string") {
    const decoded = decodeBase64Url(directBody);
    return snapshot.mimeType === "text/html" ? htmlToPlainText(decoded) : decoded.trim();
  }
  return "";
}

function extractGoogleGmailBodyByMime(
  payload: gmail_v1.Schema$MessagePart | undefined,
  mimeType: "text/plain" | "text/html"
): string {
  return extractGmailMimeBody(payload, mimeType, (node) => {
    const directBody = node.body?.data;
    if (typeof directBody !== "string") return "";
    const decoded = decodeBase64Url(directBody);
    return mimeType === "text/html" ? htmlToPlainText(decoded) : decoded.trim();
  });
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    stripHtmlRawTextElements(value)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|li|tr|table|h[1-6])>/gi, "\n")
      .replace(/<(?:li)[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mapSubscriptionHeaders(
  message: GoogleGmailMessageSummary
): GoogleGmailSubscriptionMessageHeaders {
  const listUnsubscribe =
    typeof message.metadata.listUnsubscribe === "string" ? message.metadata.listUnsubscribe : null;
  const listUnsubscribePost =
    typeof message.metadata.listUnsubscribePost === "string"
      ? message.metadata.listUnsubscribePost
      : null;
  const listId = typeof message.metadata.listId === "string" ? message.metadata.listId : null;
  return {
    messageId: message.externalId,
    threadId: message.threadId,
    receivedAt: message.receivedAt,
    subject: message.subject,
    fromDisplay: message.from,
    fromEmail: message.fromEmail,
    listId,
    listUnsubscribe,
    listUnsubscribePost,
    snippet: message.snippet,
    labels: message.labels,
  };
}

function googleErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }
  return undefined;
}
