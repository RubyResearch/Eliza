/**
 * LifeOps API methods on ElizaClient.
 *
 * Uses TypeScript declaration merging to augment the `ElizaClient` class in
 * `@elizaos/ui/api` with LifeOps-specific methods.
 *
 * Include once at startup to register the methods.
 *
 * The `@elizaos/plugin-personal-assistant/widgets` entry point imports this transitively.
 */

import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import type { GetLifeOpsScheduleMergedStateResponse } from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-contracts";
import type {
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsManualOverrideRequest,
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  GetLifeOpsIMessageMessagesRequest,
  IngestLifeOpsGmailEventRequest,
  LifeOpsActivitySignal,
  LifeOpsBrowserSession,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsDefinitionRecord,
  LifeOpsGmailEventIngestResult,
  LifeOpsGmailImportedDataPurgeReceipt,
  LifeOpsGmailManageResult,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailSeedReceipt,
  LifeOpsGmailSpamReviewFeed,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailSyncHealth,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoogleConnectorStatus,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  LifeOpsIMessageChat,
  LifeOpsIMessageMessage,
  LifeOpsManualOverrideResult,
  LifeOpsOccurrenceActionResult,
  LifeOpsOccurrenceExplanation,
  LifeOpsOverview,
  LifeOpsPersonalBaselineResponse,
  LifeOpsReminderInspection,
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryRequest,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
  LifeOpsSocialHabitSummary,
  ManageLifeOpsGmailMessagesRequest,
  PurgeLifeOpsGmailImportedDataRequest,
  SeedLifeOpsGmailRequest,
  SendLifeOpsDiscordMessageRequest,
  SendLifeOpsDiscordMessageResponse,
  SendLifeOpsGmailReplyRequest,
  SendLifeOpsIMessageRequest,
  SendLifeOpsWhatsAppMessageRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
  UpdateLifeOpsGoalRequest,
  VerifyLifeOpsDiscordConnectorRequest,
  VerifyLifeOpsDiscordConnectorResponse,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
// Import the ElizaClient CLASS from the `/api` subpath (not the root barrel):
// app-core/api/client.ts imports this file (LifeOps extension) as a side-effect
// before re-exporting `ElizaClient` from its root barrel, so a root-barrel
// import here resolves to `undefined` at module-init time (and the root barrel
// does not re-export the class value). The `/api` subpath is the class's home
// and is the pattern the sibling client extensions use (see
// plugins/plugin-calendar/src/api/client-calendar.ts).
import { ElizaClient } from "@elizaos/ui/api/client-base";
// Calendar client methods (getLifeOpsCalendarFeed / create|update|delete event,
// …) live in @elizaos/plugin-calendar now; this side-effect import attaches
// them to the shared ElizaClient prototype so the LifeOps dashboard keeps them.
import "@elizaos/plugin-calendar/api/client-calendar";
import type { AccountHandoffRetirementCandidate } from "../lifeops/account-handoff-approval-inventory.js";
import type {
  AccountHandoffCalendarEntry,
  AccountHandoffChoices,
} from "../lifeops/account-handoff-review.js";
import type { AccountHandoffRecord } from "../lifeops/account-handoff-store.js";
import type { FamilyEmailOptions } from "../lifeops/family-workflows/runtime.js";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";
import type {
  LifeOpsScheduleInspection,
  LifeOpsScheduleSummary,
} from "../lifeops/schedule-insight.js";

type LifeOpsScheduleInspectionResponse = LifeOpsScheduleInspection;

type LifeOpsScheduleMergedStateRequest = {
  timezone?: string | null;
  scope?: "local" | "cloud" | "effective";
  refresh?: boolean;
};

export type {
  LifeOpsHabitCategory,
  LifeOpsHabitDevice,
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeBreakdownItem,
  LifeOpsScreenTimeBucket,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryItem,
  LifeOpsScreenTimeSummaryRequest,
  LifeOpsSocialHabitDataSource,
  LifeOpsSocialHabitSummary,
} from "@elizaos/shared";

// Exported for consumers that import `client` from the `@elizaos/ui/api`
// subpath (headless chunks that must not touch the root barrel): the
// `declare module "@elizaos/ui"` merge below only covers root-barrel
// importers, so they re-type their client view with a Pick of this interface.
export interface LifeOpsElizaClientMethods {
  getLifeOpsFamilyEmailOptions(): Promise<{ options: FamilyEmailOptions }>;
  getLifeOpsHandoffRetirementCandidates(
    previousGrantId: string,
  ): Promise<{ candidates: AccountHandoffRetirementCandidate[] }>;
  getLifeOpsHandoffCalendarEntries(
    previousGrantId: string,
  ): Promise<{ entries: AccountHandoffCalendarEntry[] }>;
  createLifeOpsAccountHandoff(
    choices: AccountHandoffChoices,
  ): Promise<{ handoff: AccountHandoffRecord }>;
  getActiveLifeOpsAccountHandoff(): Promise<{
    handoff: AccountHandoffRecord | null;
  }>;
  getLifeOpsAccountHandoff(
    operationId: string,
  ): Promise<{ handoff: AccountHandoffRecord }>;
  cancelLifeOpsAccountHandoff(
    operationId: string,
    expectedRevision: number,
  ): Promise<{ handoff: AccountHandoffRecord }>;
  advanceLifeOpsAccountHandoff(
    operationId: string,
    expectedRevision: number,
  ): Promise<{ handoff: AccountHandoffRecord }>;

  getLifeOpsGoogleConnectorAccounts(options?: {
    side?: LifeOpsConnectorSide;
  }): Promise<{ accounts: LifeOpsGoogleConnectorStatus[] }>;
  startLifeOpsGoogleConnector(
    data: StartLifeOpsGoogleConnectorRequest,
  ): Promise<StartLifeOpsGoogleConnectorResponse>;
  disconnectLifeOpsGoogleConnector(
    data: DisconnectLifeOpsGoogleConnectorRequest,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  getLifeOpsOverview(): Promise<LifeOpsOverview>;
  getLifeOpsPaymentsDashboard(data?: {
    windowDays?: number | null;
  }): Promise<import("@elizaos/plugin-finances").LifeOpsPaymentsDashboard>;
  listLifeOpsPaymentSources(): Promise<{
    sources: import("@elizaos/plugin-finances").LifeOpsPaymentSource[];
  }>;
  addLifeOpsPaymentSource(
    data: import("@elizaos/plugin-finances").AddPaymentSourceRequest,
  ): Promise<{
    source: import("@elizaos/plugin-finances").LifeOpsPaymentSource;
  }>;
  deleteLifeOpsPaymentSource(sourceId: string): Promise<{ ok: true }>;
  importLifeOpsPaymentCsv(
    data: import("@elizaos/plugin-finances").ImportTransactionsCsvRequest,
  ): Promise<import("@elizaos/plugin-finances").ImportTransactionsCsvResult>;
  listLifeOpsPaymentTransactions(data?: {
    sourceId?: string | null;
    limit?: number | null;
    merchantContains?: string | null;
    onlyDebits?: boolean | null;
  }): Promise<{
    transactions: import("@elizaos/plugin-finances").LifeOpsPaymentTransaction[];
  }>;
  listLifeOpsRecurringCharges(data?: {
    sourceId?: string | null;
    sinceDays?: number | null;
  }): Promise<{
    charges: import("@elizaos/plugin-finances").LifeOpsRecurringCharge[];
  }>;
  listLifeOpsUpcomingBills(): Promise<{
    bills: import("@elizaos/plugin-finances").LifeOpsUpcomingBill[];
  }>;
  getLifeOpsSmartFeatureSettings(): Promise<{
    emailClassifierEnabled: boolean;
    emailClassifierModel: string;
    billsAutoExtract: boolean;
  }>;
  updateLifeOpsSmartFeatureSettings(data: {
    emailClassifierEnabled?: boolean;
    emailClassifierModel?: string | null;
    billsAutoExtract?: boolean;
  }): Promise<{ ok: true }>;
  markLifeOpsBillPaid(data: {
    billId: string;
    paidAt?: string | null;
  }): Promise<{ ok: true }>;
  snoozeLifeOpsBill(data: {
    billId: string;
    days?: number;
  }): Promise<{ ok: true; dueDate: string }>;
  scanLifeOpsEmailSubscriptions(): Promise<
    import("../lifeops/email-unsubscribe-types.js").EmailSubscriptionScanResult
  >;
  lookupLifeOpsSubscriptionPlaybook(merchant: string): Promise<{
    playbook: {
      key: string;
      serviceName: string;
      managementUrl: string;
      executorPreference: "user_browser" | "agent_browser" | "desktop_native";
    } | null;
  }>;
  listLifeOpsSubscriptionPlaybooks(): Promise<{
    playbooks: Array<{
      key: string;
      serviceName: string;
      aliases: string[];
      managementUrl: string;
      executorPreference: "user_browser" | "agent_browser" | "desktop_native";
    }>;
  }>;
  cancelLifeOpsSubscription(data: {
    serviceName?: string | null;
    serviceSlug?: string | null;
    candidateId?: string | null;
    executor?: "user_browser" | "agent_browser" | "desktop_native" | null;
    confirmed?: boolean;
  }): Promise<unknown>;
  createLifeOpsPlaidLinkToken(): Promise<{
    linkToken: string;
    expiration: string;
    environment: string;
  }>;
  completeLifeOpsPlaidLink(data: {
    publicToken: string;
    label?: string | null;
  }): Promise<{
    source: import("@elizaos/plugin-finances").LifeOpsPaymentSource;
  }>;
  syncLifeOpsPlaidTransactions(data: { sourceId: string }): Promise<{
    inserted: number;
    skipped: number;
    nextCursor: string;
  }>;
  createLifeOpsPaypalAuthorizeUrl(data: { state: string }): Promise<{
    url: string;
    scope: string;
    environment: "live" | "sandbox";
  }>;
  completeLifeOpsPaypalLink(data: {
    code: string;
    label?: string | null;
  }): Promise<{
    source: import("@elizaos/plugin-finances").LifeOpsPaymentSource;
    capability: { hasReporting: boolean; hasIdentity: boolean };
  }>;
  syncLifeOpsPaypalTransactions(data: {
    sourceId: string;
    windowDays?: number | null;
  }): Promise<{
    inserted: number;
    skipped: number;
    fallback: "csv_export" | null;
  }>;
  unsubscribeLifeOpsEmailSender(data: {
    senderEmail: string;
    blockAfter?: boolean;
    trashExisting?: boolean;
    confirmed: boolean;
  }): Promise<
    import("../lifeops/email-unsubscribe-types.js").EmailUnsubscribeResult
  >;
  getLifeOpsScheduleMergedState(
    data?: LifeOpsScheduleMergedStateRequest,
  ): Promise<GetLifeOpsScheduleMergedStateResponse>;
  getLifeOpsScreenTimeSummary(
    data: LifeOpsScreenTimeSummaryRequest,
  ): Promise<LifeOpsScreenTimeSummary>;
  getLifeOpsScreenTimeBreakdown(
    data: LifeOpsScreenTimeSummaryRequest,
  ): Promise<LifeOpsScreenTimeBreakdown>;
  getLifeOpsScreenTimeHistory(data: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse>;
  getLifeOpsSocialHabitSummary(
    data: Omit<LifeOpsScreenTimeSummaryRequest, "source" | "identifier">,
  ): Promise<LifeOpsSocialHabitSummary>;
  getLifeOpsSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse>;
  getLifeOpsSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse>;
  getLifeOpsPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse>;
  getBrowserBridgeSettings(): Promise<{ settings: BrowserBridgeSettings }>;
  listBrowserBridgeCompanions(): Promise<{
    companions: BrowserBridgeCompanionStatus[];
  }>;
  listLifeOpsBrowserSessions(): Promise<{
    sessions: LifeOpsBrowserSession[];
  }>;
  getLifeOpsBrowserSession(
    sessionId: string,
  ): Promise<{ session: LifeOpsBrowserSession }>;
  createLifeOpsBrowserSession(
    data: CreateLifeOpsBrowserSessionRequest,
  ): Promise<{ session: LifeOpsBrowserSession }>;
  confirmLifeOpsBrowserSession(
    sessionId: string,
    data: ConfirmLifeOpsBrowserSessionRequest,
  ): Promise<{ session: LifeOpsBrowserSession }>;
  updateLifeOpsBrowserSessionProgress(
    sessionId: string,
    data: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<{ session: LifeOpsBrowserSession }>;
  completeLifeOpsBrowserSession(
    sessionId: string,
    data: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<{ session: LifeOpsBrowserSession }>;
  captureLifeOpsActivitySignal(
    data: CaptureLifeOpsActivitySignalRequest,
  ): Promise<{ signal: LifeOpsActivitySignal }>;
  captureLifeOpsManualOverride(
    data: CaptureLifeOpsManualOverrideRequest,
  ): Promise<LifeOpsManualOverrideResult>;
  getLifeOpsScheduleInspection(
    timezone: string,
  ): Promise<LifeOpsScheduleInspectionResponse>;
  getLifeOpsScheduleSummary(timezone: string): Promise<LifeOpsScheduleSummary>;
  getLifeOpsFullDiskAccessStatus(): Promise<FullDiskAccessProbeResult>;
  getLifeOpsGmailTriage(
    options?: GetLifeOpsGmailTriageRequest,
  ): Promise<LifeOpsGmailTriageFeed>;
  getLifeOpsGmailSyncHealth(options: {
    grantId: string;
    side?: LifeOpsConnectorSide;
    mode?: LifeOpsConnectorMode;
  }): Promise<LifeOpsGmailSyncHealth>;
  purgeLifeOpsGmailImportedData(
    data: PurgeLifeOpsGmailImportedDataRequest,
  ): Promise<LifeOpsGmailImportedDataPurgeReceipt>;
  seedLifeOpsGmail(
    data: SeedLifeOpsGmailRequest,
  ): Promise<LifeOpsGmailSeedReceipt>;
  getLifeOpsGmailSearch(
    options: GetLifeOpsGmailSearchRequest,
  ): Promise<LifeOpsGmailSearchFeed>;
  getLifeOpsGmailNeedsResponse(
    options?: GetLifeOpsGmailTriageRequest,
  ): Promise<LifeOpsGmailNeedsResponseFeed>;
  getLifeOpsGmailRecommendations(
    options?: GetLifeOpsGmailRecommendationsRequest,
  ): Promise<LifeOpsGmailRecommendationsFeed>;
  getLifeOpsGmailSpamReview(
    options?: GetLifeOpsGmailSpamReviewRequest,
  ): Promise<LifeOpsGmailSpamReviewFeed>;
  updateLifeOpsGmailSpamReviewItem(
    itemId: string,
    data: UpdateLifeOpsGmailSpamReviewItemRequest,
  ): Promise<{ item: LifeOpsGmailSpamReviewItem }>;
  getLifeOpsGmailUnresponded(
    options?: GetLifeOpsGmailUnrespondedRequest,
  ): Promise<LifeOpsGmailUnrespondedFeed>;
  createLifeOpsGmailReplyDraft(
    data: CreateLifeOpsGmailReplyDraftRequest,
  ): Promise<{ draft: LifeOpsGmailReplyDraft }>;
  sendLifeOpsGmailReply(
    data: SendLifeOpsGmailReplyRequest,
  ): Promise<{ ok: true }>;
  manageLifeOpsGmailMessages(
    data: ManageLifeOpsGmailMessagesRequest,
  ): Promise<LifeOpsGmailManageResult>;
  ingestLifeOpsGmailEvent(
    data: IngestLifeOpsGmailEventRequest,
  ): Promise<LifeOpsGmailEventIngestResult>;
  listLifeOpsDefinitions(): Promise<{
    definitions: LifeOpsDefinitionRecord[];
  }>;
  getLifeOpsDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord>;
  createLifeOpsDefinition(
    data: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  updateLifeOpsDefinition(
    definitionId: string,
    data: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  listLifeOpsGoals(): Promise<{ goals: LifeOpsGoalRecord[] }>;
  getLifeOpsGoal(goalId: string): Promise<LifeOpsGoalRecord>;
  reviewLifeOpsGoal(goalId: string): Promise<LifeOpsGoalReview>;
  createLifeOpsGoal(data: CreateLifeOpsGoalRequest): Promise<LifeOpsGoalRecord>;
  updateLifeOpsGoal(
    goalId: string,
    data: UpdateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord>;
  completeLifeOpsOccurrence(
    occurrenceId: string,
    data?: CompleteLifeOpsOccurrenceRequest,
  ): Promise<LifeOpsOccurrenceActionResult>;
  skipLifeOpsOccurrence(
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceActionResult>;
  snoozeLifeOpsOccurrence(
    occurrenceId: string,
    data: SnoozeLifeOpsOccurrenceRequest,
  ): Promise<LifeOpsOccurrenceActionResult>;
  getLifeOpsOccurrenceExplanation(
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceExplanation>;
  inspectLifeOpsReminder(
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
  ): Promise<LifeOpsReminderInspection>;
  getHealthLifeOpsConnectorStatuses(
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]>;
  getHealthLifeOpsConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus>;
  getLifeOpsHealthSummary(
    data?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  // --- iMessage connector ---
  listLifeOpsIMessageChats(): Promise<{
    chats: LifeOpsIMessageChat[];
    count: number;
  }>;
  getLifeOpsIMessageMessages(
    options?: GetLifeOpsIMessageMessagesRequest,
  ): Promise<{
    messages: LifeOpsIMessageMessage[];
    count: number;
  }>;
  sendLifeOpsIMessage(
    data: SendLifeOpsIMessageRequest,
  ): Promise<{ ok: true; messageId?: string }>;

  // --- Discord connector ---
  sendDiscordConnectorMessage(
    data: SendLifeOpsDiscordMessageRequest,
  ): Promise<SendLifeOpsDiscordMessageResponse>;
  verifyDiscordConnector(
    data?: VerifyLifeOpsDiscordConnectorRequest,
  ): Promise<VerifyLifeOpsDiscordConnectorResponse>;

  // --- WhatsApp connector ---
  sendWhatsAppConnectorMessage(
    data: SendLifeOpsWhatsAppMessageRequest,
  ): Promise<{ ok: true; messageId: string }>;
  getWhatsAppConnectorMessages(options?: { limit?: number }): Promise<{
    count: number;
    messages: Array<{
      id: string;
      from: string;
      channelId: string;
      timestamp: string;
      type: "text" | "image" | "audio" | "document" | "unknown";
      text?: string;
    }>;
  }>;

  // --- Telegram connector ---
  verifyTelegramConnector(
    data?: VerifyLifeOpsTelegramConnectorRequest,
  ): Promise<VerifyLifeOpsTelegramConnectorResponse>;
}

declare module "@elizaos/ui/api/client-base" {
  interface ElizaClient extends LifeOpsElizaClientMethods {}
}

const lifeOpsClientPrototype = ElizaClient.prototype as ElizaClient &
  LifeOpsElizaClientMethods;

lifeOpsClientPrototype.getLifeOpsFamilyEmailOptions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/family-workflows/email-options");
};

lifeOpsClientPrototype.getLifeOpsHandoffRetirementCandidates = async function (
  this: ElizaClient,
  previousGrantId: string,
) {
  return this.fetch(
    `/api/lifeops/account-handoffs/retirement-candidates?${new URLSearchParams({ previousGrantId })}`,
  );
};

lifeOpsClientPrototype.getLifeOpsHandoffCalendarEntries = async function (
  this: ElizaClient,
  previousGrantId,
) {
  return this.fetch(
    `/api/lifeops/account-handoffs/calendar-entries?${new URLSearchParams({ previousGrantId })}`,
  );
};

lifeOpsClientPrototype.createLifeOpsAccountHandoff = async function (
  this: ElizaClient,
  choices,
) {
  return this.fetch("/api/lifeops/account-handoffs", {
    method: "POST",
    body: JSON.stringify(choices),
  });
};
lifeOpsClientPrototype.getActiveLifeOpsAccountHandoff = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/account-handoffs/active");
};
lifeOpsClientPrototype.getLifeOpsAccountHandoff = async function (
  this: ElizaClient,
  operationId,
) {
  return this.fetch(
    `/api/lifeops/account-handoffs/${encodeURIComponent(operationId)}`,
  );
};
lifeOpsClientPrototype.advanceLifeOpsAccountHandoff = async function (
  this: ElizaClient,
  operationId,
  expectedRevision,
) {
  return this.fetch(
    `/api/lifeops/account-handoffs/${encodeURIComponent(operationId)}/advance`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    },
  );
};

lifeOpsClientPrototype.cancelLifeOpsAccountHandoff = async function (
  this: ElizaClient,
  operationId,
  expectedRevision,
) {
  return this.fetch(
    `/api/lifeops/account-handoffs/${encodeURIComponent(operationId)}/cancel`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
};

lifeOpsClientPrototype.getLifeOpsGoogleConnectorAccounts = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.side) params.set("side", options.side);
  const query = params.toString();
  return this.fetch<{ accounts: LifeOpsGoogleConnectorStatus[] }>(
    `/api/lifeops/connectors/google/status${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.startLifeOpsGoogleConnector = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<StartLifeOpsGoogleConnectorResponse>(
    "/api/lifeops/connectors/google/connect",
    { method: "POST", body: JSON.stringify(data) },
  );
};

lifeOpsClientPrototype.disconnectLifeOpsGoogleConnector = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsGoogleConnectorStatus>(
    "/api/lifeops/connectors/google/disconnect",
    { method: "POST", body: JSON.stringify(data) },
  );
};

lifeOpsClientPrototype.getLifeOpsOverview = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/overview");
};

lifeOpsClientPrototype.getLifeOpsPaymentsDashboard = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.windowDays !== null && data.windowDays !== undefined) {
    params.set("windowDays", String(data.windowDays));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/money/dashboard${query ? `?${query}` : ""}`);
};

lifeOpsClientPrototype.listLifeOpsPaymentSources = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/sources");
};

lifeOpsClientPrototype.addLifeOpsPaymentSource = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.deleteLifeOpsPaymentSource = async function (
  this: ElizaClient,
  sourceId: string,
) {
  return this.fetch(
    `/api/lifeops/money/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
};

lifeOpsClientPrototype.importLifeOpsPaymentCsv = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/import-csv", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listLifeOpsPaymentTransactions = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.limit !== null && data.limit !== undefined) {
    params.set("limit", String(data.limit));
  }
  if (data.merchantContains)
    params.set("merchantContains", data.merchantContains);
  if (data.onlyDebits) params.set("onlyDebits", "true");
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/money/transactions${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.listLifeOpsRecurringCharges = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.sinceDays !== null && data.sinceDays !== undefined) {
    params.set("sinceDays", String(data.sinceDays));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/money/recurring${query ? `?${query}` : ""}`);
};

lifeOpsClientPrototype.scanLifeOpsEmailSubscriptions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/scan", { method: "POST" });
};

lifeOpsClientPrototype.listLifeOpsUpcomingBills = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/bills");
};

lifeOpsClientPrototype.markLifeOpsBillPaid = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/bills/mark-paid", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.snoozeLifeOpsBill = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/bills/snooze", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsSmartFeatureSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/smart-features/settings");
};

lifeOpsClientPrototype.updateLifeOpsSmartFeatureSettings = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/smart-features/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.lookupLifeOpsSubscriptionPlaybook = async function (
  this: ElizaClient,
  merchant: string,
) {
  const params = new URLSearchParams({ merchant });
  return this.fetch(
    `/api/lifeops/subscriptions/playbook-lookup?${params.toString()}`,
  );
};

lifeOpsClientPrototype.listLifeOpsSubscriptionPlaybooks = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/subscriptions/playbooks");
};

lifeOpsClientPrototype.cancelLifeOpsSubscription = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/subscriptions/cancel", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createLifeOpsPlaidLinkToken = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/plaid/link-token", { method: "POST" });
};

lifeOpsClientPrototype.completeLifeOpsPlaidLink = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/plaid/complete", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.syncLifeOpsPlaidTransactions = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/plaid/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createLifeOpsPaypalAuthorizeUrl = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/authorize-url", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.completeLifeOpsPaypalLink = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/complete", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.syncLifeOpsPaypalTransactions = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.unsubscribeLifeOpsEmailSender = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/unsubscribe", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsScheduleMergedState = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.timezone) {
    params.set("timezone", data.timezone);
  }
  if (data.scope) {
    params.set("scope", data.scope);
  }
  if (data.refresh !== undefined) {
    params.set("refresh", String(data.refresh));
  }
  const query = params.toString();
  return this.fetch<GetLifeOpsScheduleMergedStateResponse>(
    `/api/lifeops/schedule/merged-state${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsScreenTimeSummary = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.identifier) {
    params.set("identifier", data.identifier);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeSummary>(
    `/api/lifeops/screen-time/summary?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsScreenTimeBreakdown = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.identifier) {
    params.set("identifier", data.identifier);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeBreakdown>(
    `/api/lifeops/screen-time/breakdown?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsScreenTimeHistory = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("range", data.range);
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  if (data.socialTopN !== undefined) {
    params.set("socialTopN", String(data.socialTopN));
  }
  return this.fetch<LifeOpsScreenTimeHistoryResponse>(
    `/api/lifeops/screen-time/history?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsSocialHabitSummary = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsSocialHabitSummary>(
    `/api/lifeops/social/summary?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsSleepHistory = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  if (opts?.includeNaps !== undefined) {
    params.set("includeNaps", String(opts.includeNaps));
  }
  const query = params.toString();
  return this.fetch<LifeOpsSleepHistoryResponse>(
    `/api/lifeops/sleep/history${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsSleepRegularity = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  if (opts?.includeNaps !== undefined) {
    params.set("includeNaps", String(opts.includeNaps));
  }
  const query = params.toString();
  return this.fetch<LifeOpsSleepRegularityResponse>(
    `/api/lifeops/sleep/regularity${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsPersonalBaseline = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  const query = params.toString();
  return this.fetch<LifeOpsPersonalBaselineResponse>(
    `/api/lifeops/sleep/baseline${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getBrowserBridgeSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/settings");
};

lifeOpsClientPrototype.listBrowserBridgeCompanions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/companions");
};

lifeOpsClientPrototype.listLifeOpsBrowserSessions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/sessions");
};

lifeOpsClientPrototype.getLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}`,
  );
};

lifeOpsClientPrototype.createLifeOpsBrowserSession = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.confirmLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.updateLifeOpsBrowserSessionProgress = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/progress`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.completeLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.captureLifeOpsActivitySignal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/activity-signals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.captureLifeOpsManualOverride = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/manual-override", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsScheduleInspection = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/inspection?${params.toString()}`);
};

lifeOpsClientPrototype.getLifeOpsScheduleSummary = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/summary?${params.toString()}`);
};

lifeOpsClientPrototype.getLifeOpsFullDiskAccessStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/permissions/full-disk-access");
};

lifeOpsClientPrototype.getLifeOpsGmailTriage = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailTriageRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch<LifeOpsGmailTriageFeed>(
    `/api/lifeops/gmail/triage${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailSyncHealth = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams({ grantId: options.grantId });
  if (options.side) params.set("side", options.side);
  if (options.mode) params.set("mode", options.mode);
  return this.fetch<LifeOpsGmailSyncHealth>(
    `/api/lifeops/gmail/sync-health?${params.toString()}`,
  );
};

lifeOpsClientPrototype.seedLifeOpsGmail = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsGmailSeedReceipt>("/api/lifeops/gmail/seed", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.purgeLifeOpsGmailImportedData = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsGmailImportedDataPurgeReceipt>(
    "/api/lifeops/gmail/imported-data/purge",
    { method: "POST", body: JSON.stringify(data) },
  );
};

lifeOpsClientPrototype.getLifeOpsGmailSearch = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailSearchRequest,
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.replyNeededOnly !== undefined) {
    params.set("replyNeededOnly", String(options.replyNeededOnly));
  }
  if (options.includeSpamTrash !== undefined) {
    params.set("includeSpamTrash", String(options.includeSpamTrash));
  }
  params.set("query", options.query);
  const query = params.toString();
  return this.fetch<LifeOpsGmailSearchFeed>(
    `/api/lifeops/gmail/search${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailNeedsResponse = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailTriageRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch<LifeOpsGmailNeedsResponseFeed>(
    `/api/lifeops/gmail/needs-response${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailRecommendations = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailRecommendationsRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.query) {
    params.set("query", options.query);
  }
  if (options.replyNeededOnly !== undefined) {
    params.set("replyNeededOnly", String(options.replyNeededOnly));
  }
  if (options.includeSpamTrash !== undefined) {
    params.set("includeSpamTrash", String(options.includeSpamTrash));
  }
  const query = params.toString();
  return this.fetch<LifeOpsGmailRecommendationsFeed>(
    `/api/lifeops/gmail/recommendations${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailSpamReview = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.status) {
    params.set("status", options.status);
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/gmail/spam-review${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.updateLifeOpsGmailSpamReviewItem = async function (
  this: ElizaClient,
  itemId,
  data,
) {
  return this.fetch(
    `/api/lifeops/gmail/spam-review/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.getLifeOpsGmailUnresponded = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailUnrespondedRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.olderThanDays !== undefined) {
    params.set("olderThanDays", String(options.olderThanDays));
  }
  const query = params.toString();
  return this.fetch<LifeOpsGmailUnrespondedFeed>(
    `/api/lifeops/gmail/unresponded${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.createLifeOpsGmailReplyDraft = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-drafts", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.sendLifeOpsGmailReply = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.manageLifeOpsGmailMessages = async function (
  this: ElizaClient,
  data: ManageLifeOpsGmailMessagesRequest,
) {
  return this.fetch<LifeOpsGmailManageResult>("/api/lifeops/gmail/manage", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.ingestLifeOpsGmailEvent = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/events/ingest", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listLifeOpsDefinitions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/definitions");
};

lifeOpsClientPrototype.getLifeOpsDefinition = async function (
  this: ElizaClient,
  definitionId,
) {
  return this.fetch(
    `/api/lifeops/definitions/${encodeURIComponent(definitionId)}`,
  );
};

lifeOpsClientPrototype.createLifeOpsDefinition = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/definitions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.updateLifeOpsDefinition = async function (
  this: ElizaClient,
  definitionId,
  data,
) {
  return this.fetch(
    `/api/lifeops/definitions/${encodeURIComponent(definitionId)}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.listLifeOpsGoals = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/goals");
};

lifeOpsClientPrototype.getLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`);
};

lifeOpsClientPrototype.reviewLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}/review`);
};

lifeOpsClientPrototype.createLifeOpsGoal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/goals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.updateLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
  data,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.completeLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
  data = {},
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.skipLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/skip`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
};

lifeOpsClientPrototype.snoozeLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
  data,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/snooze`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.getLifeOpsOccurrenceExplanation = async function (
  this: ElizaClient,
  occurrenceId,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/explanation`,
  );
};

lifeOpsClientPrototype.inspectLifeOpsReminder = async function (
  this: ElizaClient,
  ownerType,
  ownerId,
) {
  const params = new URLSearchParams({
    ownerType,
    ownerId,
  });
  return this.fetch(`/api/lifeops/reminders/inspection?${params.toString()}`);
};

lifeOpsClientPrototype.getHealthLifeOpsConnectorStatuses = async function (
  this: ElizaClient,
  mode?: LifeOpsConnectorMode,
  side?: LifeOpsConnectorSide,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthConnectorStatus[]>(
    `/api/lifeops/connectors/health/status${query}`,
  );
};

lifeOpsClientPrototype.getHealthLifeOpsConnectorStatus = async function (
  this: ElizaClient,
  provider,
  mode?: LifeOpsConnectorMode,
  side?: LifeOpsConnectorSide,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthConnectorStatus>(
    `/api/lifeops/connectors/health/${encodeURIComponent(provider)}/status${query}`,
  );
};

lifeOpsClientPrototype.getLifeOpsHealthSummary = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.provider) params.set("provider", data.provider);
  if (data.mode) params.set("mode", data.mode);
  if (data.side) params.set("side", data.side);
  if (data.days !== undefined) params.set("days", String(data.days));
  if (data.startDate) params.set("startDate", data.startDate);
  if (data.endDate) params.set("endDate", data.endDate);
  if (data.forceSync) params.set("forceSync", "true");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthSummaryResponse>(
    `/api/lifeops/health/summary${query}`,
  );
};

// ---------------------------------------------------------------------------
// iMessage connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.listLifeOpsIMessageChats = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/imessage/chats");
};

lifeOpsClientPrototype.getLifeOpsIMessageMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.chatId) {
    params.set("chatId", options.chatId);
  }
  if (options.since) {
    params.set("since", options.since);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/imessage/messages${query}`);
};

lifeOpsClientPrototype.sendLifeOpsIMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/imessage/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// Discord connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.sendDiscordConnectorMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/discord/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.verifyDiscordConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/discord/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// WhatsApp connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.sendWhatsAppConnectorMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/whatsapp/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getWhatsAppConnectorMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/whatsapp/messages${query}`);
};

// ---------------------------------------------------------------------------
// Telegram connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.verifyTelegramConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/telegram/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });
};
