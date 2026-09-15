/**
 * LifeOps Service — single concrete facade.
 *
 * Declares every domain sub-service field and delegates each public method to
 * its domain. Standalone helpers live in `service-normalize-*.ts` and
 * `service-helpers-*.ts`; the per-domain public interfaces and shared types are
 * still exported from the `service-mixin-*.ts` files that consumers import.
 */

export {
  LifeOpsServiceError,
  LifeOpsWorkflowRunFailedUncompensatedError,
} from "./service-types.js";

import type {
  BrowserBridgeCompanionPairingResponse,
  BrowserBridgeCompanionPreflightRequest,
  BrowserBridgeCompanionPreflightResponse,
  BrowserBridgeCompanionRevocationResetResponse,
  BrowserBridgeCompanionRevokeResponse,
  BrowserBridgeCompanionSessionBeginRequest,
  BrowserBridgeCompanionSessionProgressRequest,
  BrowserBridgeCompanionStatus,
  BrowserBridgeCompanionSyncRequest,
  BrowserBridgeCompanionSyncResponse,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  CreateBrowserBridgeCompanionPairingRequest,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser";
import type { DiscordMessageSearchResult } from "@elizaos/plugin-discord/user-account-scraper";
import type {
  DuffelOffer,
  DuffelOrder,
  DuffelPayment,
  SearchFlightsRequest,
  SearchFlightsResult,
} from "@elizaos/plugin-elizacloud/cloud/duffel-client";
import type { LifeOpsSubscriptionPlaybook } from "@elizaos/plugin-finances/subscriptions-playbooks";
import type {
  LifeOpsSubscriptionAuditSummary,
  LifeOpsSubscriptionCancellationRequest,
  LifeOpsSubscriptionCancellationSummary,
  LifeOpsSubscriptionDiscoveryRequest,
  LifeOpsSubscriptionExecutor,
} from "@elizaos/plugin-finances/subscriptions-types";
import type { GoogleDriveFile } from "@elizaos/plugin-google-workspace";
import type {
  HealthBackend,
  HealthDailySummary,
  HealthDataPoint,
  LifeOpsDerivedEvent,
  ScreenTimeAggregateRow,
  ScreenTimeWeeklyAverageItem,
} from "@elizaos/plugin-health";
import type {
  EmailSubscriptionScanResult,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
} from "@elizaos/plugin-inbox/inbox/email-unsubscribe-types";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsInboxRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSummary,
  LifeOpsCapabilitiesStatus,
  LifeOpsDiscordConnectorStatus,
  LifeOpsIMessageConnectorStatus,
  LifeOpsInbox,
  LifeOpsInboxMessage,
  LifeOpsMessageChannel,
  LifeOpsNextCalendarEventContext,
  LifeOpsOwnerBrowserAccessSource,
  LifeOpsPersonalBaselineResponse,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSession,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
  LifeOpsTelegramConnectorStatus,
  LifeOpsWhatsAppConnectorStatus,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  ListLifeOpsCalendarsRequest,
  LifeOpsScreenTimeBreakdown as ScreenTimeBreakdown,
  SetLifeOpsCalendarIncludedRequest,
  SetLifeOpsCalendarIncludedResponse,
  LifeOpsSocialHabitSummary as SocialHabitSummary,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  CreateLifeOpsWorkflowRequest,
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  IngestLifeOpsGmailEventRequest,
  LifeOpsBrowserSession,
  LifeOpsChannelPolicy,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsDefinitionCreationResult,
  LifeOpsDefinitionRecord,
  LifeOpsDefinitionTransitionResult,
  LifeOpsGmailBatchReplyDraftsFeed,
  LifeOpsGmailBatchReplySendResult,
  LifeOpsGmailEventIngestResult,
  LifeOpsGmailImportedDataPurgeReceipt,
  LifeOpsGmailManageResult,
  LifeOpsGmailMessageSummary,
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
  LifeOpsGoalExperienceLoop,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoogleConnectorStatus,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  LifeOpsOccurrenceExplanation,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsTodoView,
  LifeOpsWeeklyGoalReview,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
  LifeOpsXPostResponse,
  ManageLifeOpsGmailMessagesRequest,
  PurgeLifeOpsGmailImportedDataRequest,
  RecordLifeOpsProgressRequest,
  RecordLifeOpsProgressResult,
  SeedLifeOpsGmailRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
  UpdateLifeOpsGoalRequest,
  UpdateLifeOpsWorkflowRequest,
} from "../contracts/index.js";
import { loadLifeOpsAppState } from "./app-state.js";
import { resolveDefaultTimeZone } from "./defaults.js";
import type { DefinitionCreationContext } from "./definition-creation-identity.js";
import { BrowserDomain } from "./domains/browser-service.js";
import { CalendarDomain } from "./domains/calendar-service.js";
import { DefinitionsDomain } from "./domains/definitions-service.js";
import {
  type DiscordConnectorVerification,
  DiscordDomain,
  type DiscordSendMessageResult,
} from "./domains/discord-service.js";
import { DriveDomain } from "./domains/drive-service.js";
import { EmailUnsubscribeDomain } from "./domains/email-unsubscribe-service.js";
import { GmailDomain } from "./domains/gmail-service.js";
import { GoalsDomain } from "./domains/goals-service.js";
import { GoogleDomain } from "./domains/google-service.js";
import { HealthDomain } from "./domains/health-service.js";
import {
  type IMessageChat,
  type IMessageDeliveryResult,
  IMessageDomain,
  type IMessageRecord,
  type IMessageSendRequest,
} from "./domains/imessage-service.js";
import { InboxDomain } from "./domains/inbox-service.js";
import { RelationshipsDomain } from "./domains/relationships-service.js";
import { RemindersDomain } from "./domains/reminders-service.js";
import {
  type CounterpartyTarget,
  SchedulingDomain,
} from "./domains/scheduling-service.js";
import { ScreenTimeDomain } from "./domains/screentime-service.js";
import { SleepDomain } from "./domains/sleep-service.js";
import { StatusDomain } from "./domains/status-service.js";
import { SubscriptionsDomain } from "./domains/subscriptions-service.js";
import {
  TelegramDomain,
  type TelegramMessageSearchResult,
  type TelegramReadReceiptResult,
} from "./domains/telegram-service.js";
import { TravelDomain } from "./domains/travel-service.js";
import {
  WhatsAppDomain,
  type WhatsAppMessage,
  type WhatsAppSendRequest,
} from "./domains/whatsapp-service.js";
import { WorkflowsDomain } from "./domains/workflows-service.js";
import { XReadDomain } from "./domains/x-read-service.js";
import { XDomain } from "./domains/x-service.js";
import { resolveOwnerFactStore } from "./owner/fact-store.js";
import type {
  LifeOpsScheduleInspection,
  LifeOpsScheduleSummary,
} from "./schedule-insight.js";
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail, requireNonEmptyString } from "./service-normalize.js";
import type { TransactionalDb } from "./sql.js";
import { getZonedDateParts } from "./time.js";
import type {
  FlightBookingExecutionResult,
  PreparedFlightBooking,
  TravelBookingPassenger,
  TravelCalendarSyncPlan,
} from "./travel-booking.types.js";

type ScreenTimeEventInput = {
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt?: string | null;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

type ScreenTimeWeeklyAverageResponse = {
  items: ScreenTimeWeeklyAverageItem[];
  totalSeconds: number;
  daysInWindow: number;
};

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
};

type OptionalXGrantResolver = {
  resolveXGrant?: () => Promise<LifeOpsConnectorGrant | null>;
};

/**
 * Main LifeOps service — every domain sub-service composed on one concrete
 * class built directly on {@link LifeOpsServiceBase}.
 */
export class LifeOpsService extends LifeOpsServiceBase {
  get google() {
    return this.googleDomain;
  }

  get calendar() {
    return this.calendarDomain;
  }

  get gmail() {
    return this.gmailDomain;
  }

  get drive() {
    return this.driveDomain;
  }

  get reminders() {
    return this.remindersDomain;
  }

  get browser() {
    return this.browserDomain;
  }

  get workflows() {
    return this.workflowsDomain;
  }

  get definitions() {
    return this.definitionsDomain;
  }

  get goals() {
    return this.goalsDomain;
  }

  get x() {
    return this.xDomain;
  }

  get relationships() {
    return this.relationshipsDomain;
  }

  get emailUnsubscribe() {
    return this.emailUnsubscribeDomain;
  }

  get health() {
    return this.healthDomain;
  }

  get xRead() {
    return this.xReadDomain;
  }

  get imessage() {
    return this.imessageDomain;
  }

  get telegram() {
    return this.telegramDomain;
  }

  get discord() {
    return this.discordDomain;
  }

  get whatsapp() {
    return this.whatsappDomain;
  }

  get travel() {
    return this.travelDomain;
  }

  get scheduling() {
    return this.schedulingDomain;
  }

  get subscriptions() {
    return this.subscriptionsDomain;
  }

  get status() {
    return this.statusDomain;
  }

  get screenTime() {
    return this.screenTimeDomain;
  }

  get sleep() {
    return this.sleepDomain;
  }

  get inbox() {
    return this.inboxDomain;
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly googleDomain = new GoogleDomain(this);

  public withGoogleGrantOperation<T>(
    _grant: LifeOpsConnectorGrant,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.googleDomain.withGoogleGrantOperation(_grant, operation);
  }

  public runManagedGoogleOperation<T>(
    _grant: LifeOpsConnectorGrant,
    _operation: () => Promise<T>,
  ): Promise<T> {
    return this.googleDomain.runManagedGoogleOperation(_grant, _operation);
  }

  public clearGoogleConnectorData(side?: LifeOpsConnectorSide): Promise<void> {
    return this.googleDomain.clearGoogleConnectorData(side);
  }

  public clearGoogleGrantData(grant: LifeOpsConnectorGrant): Promise<void> {
    return this.googleDomain.clearGoogleGrantData(grant);
  }

  public deleteCalendarReminderPlansForEvents(
    _eventIds: string[],
  ): Promise<void> {
    return this.googleDomain.deleteCalendarReminderPlansForEvents(_eventIds);
  }

  public requireGoogleCalendarGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.googleDomain.requireGoogleCalendarGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  public requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.googleDomain.requireGoogleCalendarWriteGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  public requireGoogleGmailGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.googleDomain.requireGoogleGmailGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  public requireGoogleGmailSendGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.googleDomain.requireGoogleGmailSendGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    return this.googleDomain.getGoogleConnectorStatus(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  getGoogleConnectorAccounts(
    requestUrl: URL,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]> {
    return this.googleDomain.getGoogleConnectorAccounts(
      requestUrl,
      requestedSide,
    );
  }

  selectGoogleConnectorMode(
    requestUrl: URL,
    preferredModeInput: LifeOpsConnectorMode | undefined,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    return this.googleDomain.selectGoogleConnectorMode(
      requestUrl,
      preferredModeInput,
      requestedSide,
    );
  }

  startGoogleConnector(
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsGoogleConnectorResponse> {
    return this.googleDomain.startGoogleConnector(request, requestUrl);
  }

  completeGoogleConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    return this.googleDomain.completeGoogleConnectorCallback(callbackUrl);
  }

  disconnectGoogleConnector(
    request: DisconnectLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    return this.googleDomain.disconnectGoogleConnector(request, requestUrl);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly calendarDomain = new CalendarDomain(this);

  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]> {
    return this.calendarDomain.listCalendars(requestUrl, request);
  }

  setCalendarIncluded(
    requestUrl: URL,
    request: SetLifeOpsCalendarIncludedRequest,
  ): Promise<SetLifeOpsCalendarIncludedResponse> {
    return this.calendarDomain.setCalendarIncluded(requestUrl, request);
  }

  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarFeed> {
    return this.calendarDomain.getCalendarFeed(requestUrl, request, now);
  }

  createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarEvent> {
    return this.calendarDomain.createCalendarEvent(requestUrl, request, now);
  }

  createCalendarEventMutation(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    return this.calendarDomain.createCalendarEventMutation(
      requestUrl,
      request,
      now,
    );
  }

  getAppleCalendarCreateAccess(): ReturnType<
    CalendarDomain["getAppleCalendarCreateAccess"]
  > {
    return this.calendarDomain.getAppleCalendarCreateAccess();
  }

  updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    return this.calendarDomain.updateCalendarEvent(requestUrl, request);
  }

  deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    return this.calendarDomain.deleteCalendarEvent(requestUrl, request);
  }

  getConditionalCalendarMutationTarget(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<LifeOpsCalendarEvent> {
    return this.calendarDomain.getConditionalCalendarMutationTarget(
      requestUrl,
      request,
    );
  }

  respondToCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      responseStatus: "accepted" | "declined" | "tentative";
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
    },
  ): Promise<LifeOpsCalendarEvent> {
    return this.calendarDomain.respondToCalendarEvent(requestUrl, request);
  }

  reserveTravelBuffer(request: {
    eventId: string;
    bufferMinutes: number;
    method: string;
  }): Promise<LifeOpsCalendarEvent> {
    return this.calendarDomain.reserveTravelBuffer(request);
  }

  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsNextCalendarEventContext> {
    return this.calendarDomain.getNextCalendarEventContext(
      requestUrl,
      request,
      now,
    );
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly gmailDomain = new GmailDomain(this, {
    requireGoogleGmailGrant: (
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    ) =>
      this.requireGoogleGmailGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ),
    requireGoogleGmailSendGrant: (
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    ) =>
      this.requireGoogleGmailSendGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ),
  });

  seedGmailMessages(
    requestUrl: URL,
    request: SeedLifeOpsGmailRequest,
    now?: Date,
  ): Promise<LifeOpsGmailSeedReceipt> {
    return this.gmailDomain.seedGmailMessages(requestUrl, request, now);
  }

  getGmailSyncHealth(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId: string;
    },
  ): Promise<LifeOpsGmailSyncHealth> {
    return this.gmailDomain.getGmailSyncHealth(requestUrl, request);
  }

  purgeGmailImportedData(
    requestUrl: URL,
    request: PurgeLifeOpsGmailImportedDataRequest,
    now?: Date,
  ): Promise<LifeOpsGmailImportedDataPurgeReceipt> {
    return this.gmailDomain.purgeGmailImportedData(requestUrl, request, now);
  }

  getGmailTriage(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailTriageFeed> {
    return this.gmailDomain.getGmailTriage(requestUrl, request, now);
  }

  getGmailSearch(
    requestUrl: URL,
    request: GetLifeOpsGmailSearchRequest,
    now?: Date,
  ): Promise<LifeOpsGmailSearchFeed> {
    return this.gmailDomain.getGmailSearch(requestUrl, request, now);
  }

  readGmailMessage(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
      forceSync?: boolean;
      maxResults?: number;
      messageId?: string;
      query?: string;
      replyNeededOnly?: boolean;
    },
    now?: Date,
  ): Promise<{
    query: string | null;
    message: LifeOpsGmailMessageSummary;
    bodyText: string;
    source: "synced";
    syncedAt: string;
  }> {
    return this.gmailDomain.readGmailMessage(requestUrl, request, now);
  }

  getGmailNeedsResponse(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailNeedsResponseFeed> {
    return this.gmailDomain.getGmailNeedsResponse(requestUrl, request, now);
  }

  getGmailRecommendations(
    requestUrl: URL,
    request?: GetLifeOpsGmailRecommendationsRequest,
    now?: Date,
  ): Promise<LifeOpsGmailRecommendationsFeed> {
    return this.gmailDomain.getGmailRecommendations(requestUrl, request, now);
  }

  getGmailSpamReviewItems(
    requestUrl: URL,
    request?: GetLifeOpsGmailSpamReviewRequest,
  ): Promise<LifeOpsGmailSpamReviewFeed> {
    return this.gmailDomain.getGmailSpamReviewItems(requestUrl, request);
  }

  updateGmailSpamReviewItem(
    requestUrl: URL,
    itemId: string,
    request: UpdateLifeOpsGmailSpamReviewItemRequest,
    now?: Date,
  ): Promise<{ item: LifeOpsGmailSpamReviewItem }> {
    return this.gmailDomain.updateGmailSpamReviewItem(
      requestUrl,
      itemId,
      request,
      now,
    );
  }

  getGmailUnresponded(
    requestUrl: URL,
    request?: GetLifeOpsGmailUnrespondedRequest,
    now?: Date,
  ): Promise<LifeOpsGmailUnrespondedFeed> {
    return this.gmailDomain.getGmailUnresponded(requestUrl, request, now);
  }

  manageGmailMessages(
    requestUrl: URL,
    request: ManageLifeOpsGmailMessagesRequest,
  ): Promise<LifeOpsGmailManageResult> {
    return this.gmailDomain.manageGmailMessages(requestUrl, request);
  }

  ingestGmailEvent(
    requestUrl: URL,
    request: IngestLifeOpsGmailEventRequest,
    now?: Date,
  ): Promise<LifeOpsGmailEventIngestResult> {
    return this.gmailDomain.ingestGmailEvent(requestUrl, request, now);
  }

  createGmailBatchReplyDrafts(
    requestUrl: URL,
    request: CreateLifeOpsGmailBatchReplyDraftsRequest,
    now?: Date,
  ): Promise<LifeOpsGmailBatchReplyDraftsFeed> {
    return this.gmailDomain.createGmailBatchReplyDrafts(
      requestUrl,
      request,
      now,
    );
  }

  createGmailReplyDraft(
    requestUrl: URL,
    request: CreateLifeOpsGmailReplyDraftRequest,
  ): Promise<LifeOpsGmailReplyDraft> {
    return this.gmailDomain.createGmailReplyDraft(requestUrl, request);
  }

  sendGmailReply(
    requestUrl: URL,
    request: SendLifeOpsGmailReplyRequest,
  ): Promise<{ ok: true }> {
    return this.gmailDomain.sendGmailReply(requestUrl, request);
  }

  sendGmailMessage(
    requestUrl: URL,
    request: SendLifeOpsGmailMessageRequest,
  ): Promise<{ ok: true; messageId: string; threadId: string | null }> {
    return this.gmailDomain.sendGmailMessage(requestUrl, request);
  }

  sendGmailReplies(
    requestUrl: URL,
    request: SendLifeOpsGmailBatchReplyRequest,
  ): Promise<LifeOpsGmailBatchReplySendResult> {
    return this.gmailDomain.sendGmailReplies(requestUrl, request);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly driveDomain = new DriveDomain(this, {
    getGoogleConnectorStatus: (
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    ) =>
      this.getGoogleConnectorStatus(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ),
  });

  requireGoogleDriveReadGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.driveDomain.requireGoogleDriveReadGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  requireGoogleDriveWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    return this.driveDomain.requireGoogleDriveWriteGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
  }

  listDriveFiles(
    requestUrl: URL,
    request?: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      folderId?: string;
      maxResults?: number;
      pageToken?: string;
    },
  ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
    return this.driveDomain.listDriveFiles(requestUrl, request);
  }

  getDriveFile(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      fileId: string;
    },
  ): Promise<GoogleDriveFile> {
    return this.driveDomain.getDriveFile(requestUrl, request);
  }

  searchDriveFiles(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      query: string;
      maxResults?: number;
    },
  ): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }> {
    return this.driveDomain.searchDriveFiles(requestUrl, request);
  }

  getDocContent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      documentId: string;
    },
  ): Promise<{ title: string; plainText: string }> {
    return this.driveDomain.getDocContent(requestUrl, request);
  }

  getSheetContent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      spreadsheetId: string;
      range?: string;
    },
  ): Promise<{ title: string; rows: string[][] }> {
    return this.driveDomain.getSheetContent(requestUrl, request);
  }

  createDriveFile(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      name: string;
      mimeType: string;
      content?: string | Uint8Array;
      parentFolderId?: string;
    },
  ): Promise<GoogleDriveFile> {
    return this.driveDomain.createDriveFile(requestUrl, request);
  }

  appendToDoc(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      documentId: string;
      text: string;
    },
  ): Promise<void> {
    return this.driveDomain.appendToDoc(requestUrl, request);
  }

  updateSheetCells(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    },
  ): Promise<{ updatedRange: string; updatedCells: number }> {
    return this.driveDomain.updateSheetCells(requestUrl, request);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext, and the
  // composed runtime service supplies the cross-domain dependencies below.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly remindersDomain = new RemindersDomain(this, {
    runDueWorkflows: (...args) => this.runDueWorkflows(...args),
    // RemindersDeps types the event payload as the health-domain
    // `LifeOpsDerivedEvent`, while the workflows domain method this forwards to
    // types it as `LifeOpsWorkflowEvent`. The two are runtime-compatible; a
    // localized structural cast reconciles the cross-domain payload types.
    runDueEventWorkflows: (...args) =>
      this.runDueDerivedEventWorkflows(...args),
    snoozeOccurrence: (...args) => this.snoozeOccurrence(...args),
    checkinSource: this,
  });

  readRecentReminderConversation(
    ...args: Parameters<RemindersDomain["readRecentReminderConversation"]>
  ): ReturnType<RemindersDomain["readRecentReminderConversation"]> {
    return this.remindersDomain.readRecentReminderConversation(...args);
  }

  classifyReminderOwnerResponseSemantically(
    ...args: Parameters<
      RemindersDomain["classifyReminderOwnerResponseSemantically"]
    >
  ): ReturnType<RemindersDomain["classifyReminderOwnerResponseSemantically"]> {
    return this.remindersDomain.classifyReminderOwnerResponseSemantically(
      ...args,
    );
  }

  reviewOwnerResponseAfterReminderAttempt(
    ...args: Parameters<
      RemindersDomain["reviewOwnerResponseAfterReminderAttempt"]
    >
  ): ReturnType<RemindersDomain["reviewOwnerResponseAfterReminderAttempt"]> {
    return this.remindersDomain.reviewOwnerResponseAfterReminderAttempt(
      ...args,
    );
  }

  renderReminderBody(
    ...args: Parameters<RemindersDomain["renderReminderBody"]>
  ): ReturnType<RemindersDomain["renderReminderBody"]> {
    return this.remindersDomain.renderReminderBody(...args);
  }

  renderWorkflowRunBody(
    ...args: Parameters<RemindersDomain["renderWorkflowRunBody"]>
  ): ReturnType<RemindersDomain["renderWorkflowRunBody"]> {
    return this.remindersDomain.renderWorkflowRunBody(...args);
  }

  emitWorkflowRunNudge(
    ...args: Parameters<RemindersDomain["emitWorkflowRunNudge"]>
  ): ReturnType<RemindersDomain["emitWorkflowRunNudge"]> {
    return this.remindersDomain.emitWorkflowRunNudge(...args);
  }

  withNativeAppleReminderId(
    ...args: Parameters<RemindersDomain["withNativeAppleReminderId"]>
  ): ReturnType<RemindersDomain["withNativeAppleReminderId"]> {
    return this.remindersDomain.withNativeAppleReminderId(...args);
  }

  syncNativeAppleReminderForDefinition(
    ...args: Parameters<RemindersDomain["syncNativeAppleReminderForDefinition"]>
  ): ReturnType<RemindersDomain["syncNativeAppleReminderForDefinition"]> {
    return this.remindersDomain.syncNativeAppleReminderForDefinition(...args);
  }

  getDefinitionRecord(
    ...args: Parameters<RemindersDomain["getDefinitionRecord"]>
  ): ReturnType<RemindersDomain["getDefinitionRecord"]> {
    return this.remindersDomain.getDefinitionRecord(...args);
  }

  getGoalRecord(
    ...args: Parameters<RemindersDomain["getGoalRecord"]>
  ): ReturnType<RemindersDomain["getGoalRecord"]> {
    return this.remindersDomain.getGoalRecord(...args);
  }

  ensureGoalExists(
    ...args: Parameters<RemindersDomain["ensureGoalExists"]>
  ): ReturnType<RemindersDomain["ensureGoalExists"]> {
    return this.remindersDomain.ensureGoalExists(...args);
  }

  syncGoalLink(
    ...args: Parameters<RemindersDomain["syncGoalLink"]>
  ): ReturnType<RemindersDomain["syncGoalLink"]> {
    return this.remindersDomain.syncGoalLink(...args);
  }

  syncReminderPlan(
    ...args: Parameters<RemindersDomain["syncReminderPlan"]>
  ): ReturnType<RemindersDomain["syncReminderPlan"]> {
    return this.remindersDomain.syncReminderPlan(...args);
  }

  serializeScheduleObservationForSync(
    ...args: Parameters<RemindersDomain["serializeScheduleObservationForSync"]>
  ): ReturnType<RemindersDomain["serializeScheduleObservationForSync"]> {
    return this.remindersDomain.serializeScheduleObservationForSync(...args);
  }

  refreshLocalMergedScheduleState(
    ...args: Parameters<RemindersDomain["refreshLocalMergedScheduleState"]>
  ): ReturnType<RemindersDomain["refreshLocalMergedScheduleState"]> {
    return this.remindersDomain.refreshLocalMergedScheduleState(...args);
  }

  ingestScheduleObservations(
    ...args: Parameters<RemindersDomain["ingestScheduleObservations"]>
  ): ReturnType<RemindersDomain["ingestScheduleObservations"]> {
    return this.remindersDomain.ingestScheduleObservations(...args);
  }

  fetchCloudMergedScheduleState(
    ...args: Parameters<RemindersDomain["fetchCloudMergedScheduleState"]>
  ): ReturnType<RemindersDomain["fetchCloudMergedScheduleState"]> {
    return this.remindersDomain.fetchCloudMergedScheduleState(...args);
  }

  readEffectiveScheduleState(
    ...args: Parameters<RemindersDomain["readEffectiveScheduleState"]>
  ): ReturnType<RemindersDomain["readEffectiveScheduleState"]> {
    return this.remindersDomain.readEffectiveScheduleState(...args);
  }

  refreshEffectiveScheduleState(
    ...args: Parameters<RemindersDomain["refreshEffectiveScheduleState"]>
  ): ReturnType<RemindersDomain["refreshEffectiveScheduleState"]> {
    return this.remindersDomain.refreshEffectiveScheduleState(...args);
  }

  getScheduleMergedState(
    ...args: Parameters<RemindersDomain["getScheduleMergedState"]>
  ): ReturnType<RemindersDomain["getScheduleMergedState"]> {
    return this.remindersDomain.getScheduleMergedState(...args);
  }

  resolveAdaptiveWindowPolicy(
    ...args: Parameters<RemindersDomain["resolveAdaptiveWindowPolicy"]>
  ): ReturnType<RemindersDomain["resolveAdaptiveWindowPolicy"]> {
    return this.remindersDomain.resolveAdaptiveWindowPolicy(...args);
  }

  refreshDefinitionOccurrences(
    ...args: Parameters<RemindersDomain["refreshDefinitionOccurrences"]>
  ): ReturnType<RemindersDomain["refreshDefinitionOccurrences"]> {
    return this.remindersDomain.refreshDefinitionOccurrences(...args);
  }

  getFreshOccurrence(
    ...args: Parameters<RemindersDomain["getFreshOccurrence"]>
  ): ReturnType<RemindersDomain["getFreshOccurrence"]> {
    return this.remindersDomain.getFreshOccurrence(...args);
  }

  resolvePrimaryChannelPolicy(
    ...args: Parameters<RemindersDomain["resolvePrimaryChannelPolicy"]>
  ): ReturnType<RemindersDomain["resolvePrimaryChannelPolicy"]> {
    return this.remindersDomain.resolvePrimaryChannelPolicy(...args);
  }

  resolveRuntimeReminderTarget(
    ...args: Parameters<RemindersDomain["resolveRuntimeReminderTarget"]>
  ): ReturnType<RemindersDomain["resolveRuntimeReminderTarget"]> {
    return this.remindersDomain.resolveRuntimeReminderTarget(...args);
  }

  readLifeOpsAttentionContext(
    ...args: Parameters<RemindersDomain["readLifeOpsAttentionContext"]>
  ): ReturnType<RemindersDomain["readLifeOpsAttentionContext"]> {
    return this.remindersDomain.readLifeOpsAttentionContext(...args);
  }

  readReminderActivityProfileSnapshot(
    ...args: Parameters<RemindersDomain["readReminderActivityProfileSnapshot"]>
  ): ReturnType<RemindersDomain["readReminderActivityProfileSnapshot"]> {
    return this.remindersDomain.readReminderActivityProfileSnapshot(...args);
  }

  scanReadReceipts(
    ...args: Parameters<RemindersDomain["scanReadReceipts"]>
  ): ReturnType<RemindersDomain["scanReadReceipts"]> {
    return this.remindersDomain.scanReadReceipts(...args);
  }

  buildReminderPlanSchedule(
    ...args: Parameters<RemindersDomain["buildReminderPlanSchedule"]>
  ): ReturnType<RemindersDomain["buildReminderPlanSchedule"]> {
    return this.remindersDomain.buildReminderPlanSchedule(...args);
  }

  resolveOwnerContactRouteCandidates(
    ...args: Parameters<RemindersDomain["resolveOwnerContactRouteCandidates"]>
  ): ReturnType<RemindersDomain["resolveOwnerContactRouteCandidates"]> {
    return this.remindersDomain.resolveOwnerContactRouteCandidates(...args);
  }

  resolveReminderEscalationRouteCandidates(
    ...args: Parameters<
      RemindersDomain["resolveReminderEscalationRouteCandidates"]
    >
  ): ReturnType<RemindersDomain["resolveReminderEscalationRouteCandidates"]> {
    return this.remindersDomain.resolveReminderEscalationRouteCandidates(
      ...args,
    );
  }

  buildOwnerContactRouteEventMetadata(
    ...args: Parameters<RemindersDomain["buildOwnerContactRouteEventMetadata"]>
  ): ReturnType<RemindersDomain["buildOwnerContactRouteEventMetadata"]> {
    return this.remindersDomain.buildOwnerContactRouteEventMetadata(...args);
  }

  resolveReminderEscalationChannels(
    ...args: Parameters<RemindersDomain["resolveReminderEscalationChannels"]>
  ): ReturnType<RemindersDomain["resolveReminderEscalationChannels"]> {
    return this.remindersDomain.resolveReminderEscalationChannels(...args);
  }

  markReminderEscalationStarted(
    ...args: Parameters<RemindersDomain["markReminderEscalationStarted"]>
  ): ReturnType<RemindersDomain["markReminderEscalationStarted"]> {
    return this.remindersDomain.markReminderEscalationStarted(...args);
  }

  resolveReminderEscalation(
    ...args: Parameters<RemindersDomain["resolveReminderEscalation"]>
  ): ReturnType<RemindersDomain["resolveReminderEscalation"]> {
    return this.remindersDomain.resolveReminderEscalation(...args);
  }

  resolveReminderReviewFromOwnerResponse(
    ...args: Parameters<
      RemindersDomain["resolveReminderReviewFromOwnerResponse"]
    >
  ): ReturnType<RemindersDomain["resolveReminderReviewFromOwnerResponse"]> {
    return this.remindersDomain.resolveReminderReviewFromOwnerResponse(...args);
  }

  markReminderReviewResolvedFromState(
    ...args: Parameters<RemindersDomain["markReminderReviewResolvedFromState"]>
  ): ReturnType<RemindersDomain["markReminderReviewResolvedFromState"]> {
    return this.remindersDomain.markReminderReviewResolvedFromState(...args);
  }

  markReminderReviewEscalated(
    ...args: Parameters<RemindersDomain["markReminderReviewEscalated"]>
  ): ReturnType<RemindersDomain["markReminderReviewEscalated"]> {
    return this.remindersDomain.markReminderReviewEscalated(...args);
  }

  markReminderReviewClarificationRequested(
    ...args: Parameters<
      RemindersDomain["markReminderReviewClarificationRequested"]
    >
  ): ReturnType<RemindersDomain["markReminderReviewClarificationRequested"]> {
    return this.remindersDomain.markReminderReviewClarificationRequested(
      ...args,
    );
  }

  markReminderReviewObservedResponse(
    ...args: Parameters<RemindersDomain["markReminderReviewObservedResponse"]>
  ): ReturnType<RemindersDomain["markReminderReviewObservedResponse"]> {
    return this.remindersDomain.markReminderReviewObservedResponse(...args);
  }

  processDueReminderReviewJobs(
    ...args: Parameters<RemindersDomain["processDueReminderReviewJobs"]>
  ): ReturnType<RemindersDomain["processDueReminderReviewJobs"]> {
    return this.remindersDomain.processDueReminderReviewJobs(...args);
  }

  dispatchDueReminderEscalation(
    ...args: Parameters<RemindersDomain["dispatchDueReminderEscalation"]>
  ): ReturnType<RemindersDomain["dispatchDueReminderEscalation"]> {
    return this.remindersDomain.dispatchDueReminderEscalation(...args);
  }

  awardWebsiteAccessGrant(
    ...args: Parameters<RemindersDomain["awardWebsiteAccessGrant"]>
  ): ReturnType<RemindersDomain["awardWebsiteAccessGrant"]> {
    return this.remindersDomain.awardWebsiteAccessGrant(...args);
  }

  syncWebsiteAccessState(
    ...args: Parameters<RemindersDomain["syncWebsiteAccessState"]>
  ): ReturnType<RemindersDomain["syncWebsiteAccessState"]> {
    return this.remindersDomain.syncWebsiteAccessState(...args);
  }

  dispatchReminderAttempt(
    ...args: Parameters<RemindersDomain["dispatchReminderAttempt"]>
  ): ReturnType<RemindersDomain["dispatchReminderAttempt"]> {
    return this.remindersDomain.dispatchReminderAttempt(...args);
  }

  resolveGlobalReminderPreferencePolicy(
    ...args: Parameters<
      RemindersDomain["resolveGlobalReminderPreferencePolicy"]
    >
  ): ReturnType<RemindersDomain["resolveGlobalReminderPreferencePolicy"]> {
    return this.remindersDomain.resolveGlobalReminderPreferencePolicy(...args);
  }

  buildReminderPreferenceResponse(
    ...args: Parameters<RemindersDomain["buildReminderPreferenceResponse"]>
  ): ReturnType<RemindersDomain["buildReminderPreferenceResponse"]> {
    return this.remindersDomain.buildReminderPreferenceResponse(...args);
  }

  resolveEffectiveReminderPlan(
    ...args: Parameters<RemindersDomain["resolveEffectiveReminderPlan"]>
  ): ReturnType<RemindersDomain["resolveEffectiveReminderPlan"]> {
    return this.remindersDomain.resolveEffectiveReminderPlan(...args);
  }

  getReminderPreference(
    ...args: Parameters<RemindersDomain["getReminderPreference"]>
  ): ReturnType<RemindersDomain["getReminderPreference"]> {
    return this.remindersDomain.getReminderPreference(...args);
  }

  setReminderPreference(
    ...args: Parameters<RemindersDomain["setReminderPreference"]>
  ): ReturnType<RemindersDomain["setReminderPreference"]> {
    return this.remindersDomain.setReminderPreference(...args);
  }

  captureActivitySignal(
    ...args: Parameters<RemindersDomain["captureActivitySignal"]>
  ): ReturnType<RemindersDomain["captureActivitySignal"]> {
    return this.remindersDomain.captureActivitySignal(...args);
  }

  captureManualOverride(
    ...args: Parameters<RemindersDomain["captureManualOverride"]>
  ): ReturnType<RemindersDomain["captureManualOverride"]> {
    return this.remindersDomain.captureManualOverride(...args);
  }

  listActivitySignals(
    ...args: Parameters<RemindersDomain["listActivitySignals"]>
  ): ReturnType<RemindersDomain["listActivitySignals"]> {
    return this.remindersDomain.listActivitySignals(...args);
  }

  upsertChannelPolicy(
    ...args: Parameters<RemindersDomain["upsertChannelPolicy"]>
  ): ReturnType<RemindersDomain["upsertChannelPolicy"]> {
    return this.remindersDomain.upsertChannelPolicy(...args);
  }

  capturePhoneConsent(
    ...args: Parameters<RemindersDomain["capturePhoneConsent"]>
  ): ReturnType<RemindersDomain["capturePhoneConsent"]> {
    return this.remindersDomain.capturePhoneConsent(...args);
  }

  processDueReminderDeliveries(
    ...args: Parameters<RemindersDomain["processDueReminderDeliveries"]>
  ): ReturnType<RemindersDomain["processDueReminderDeliveries"]> {
    return this.remindersDomain.processDueReminderDeliveries(...args);
  }

  processReminders(
    ...args: Parameters<RemindersDomain["processReminders"]>
  ): ReturnType<RemindersDomain["processReminders"]> {
    return this.remindersDomain.processReminders(...args);
  }

  processScheduledWork(
    ...args: Parameters<RemindersDomain["processScheduledWork"]>
  ): ReturnType<RemindersDomain["processScheduledWork"]> {
    return this.remindersDomain.processScheduledWork(...args);
  }

  relockWebsiteAccessGroup(
    ...args: Parameters<RemindersDomain["relockWebsiteAccessGroup"]>
  ): ReturnType<RemindersDomain["relockWebsiteAccessGroup"]> {
    return this.remindersDomain.relockWebsiteAccessGroup(...args);
  }

  resolveWebsiteAccessCallback(
    ...args: Parameters<RemindersDomain["resolveWebsiteAccessCallback"]>
  ): ReturnType<RemindersDomain["resolveWebsiteAccessCallback"]> {
    return this.remindersDomain.resolveWebsiteAccessCallback(...args);
  }

  inspectReminder(
    ...args: Parameters<RemindersDomain["inspectReminder"]>
  ): ReturnType<RemindersDomain["inspectReminder"]> {
    return this.remindersDomain.inspectReminder(...args);
  }

  acknowledgeReminder(
    ...args: Parameters<RemindersDomain["acknowledgeReminder"]>
  ): ReturnType<RemindersDomain["acknowledgeReminder"]> {
    return this.remindersDomain.acknowledgeReminder(...args);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly browserDomain = new BrowserDomain(this, {
    getBrowserSettingsInternal: (...args) =>
      this.getBrowserSettingsInternal(...args),
    isBrowserPaused: (...args) => this.isBrowserPaused(...args),
    requireBrowserAvailableForActions: (...args) =>
      this.requireBrowserAvailableForActions(...args),
    buildBrowserCompanion: (...args) => this.buildBrowserCompanion(...args),
    recordBrowserAudit: (...args) => this.recordBrowserAudit(...args),
    getWorkflowDefinition: (...args) => this.getWorkflowDefinition(...args),
    recordScreenTimeEvent: (...args) => this.recordScreenTimeEvent(...args),
  });

  createBrowserSessionInternal(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.createBrowserSessionInternal(request);
  }

  getBrowserSettings(): Promise<BrowserBridgeSettings> {
    return this.browserDomain.getBrowserSettings();
  }

  updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettings> {
    return this.browserDomain.updateBrowserSettings(request);
  }

  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]> {
    return this.browserDomain.listBrowserCompanions();
  }

  listBrowserTabs(): Promise<BrowserBridgeTabSummary[]> {
    return this.browserDomain.listBrowserTabs();
  }

  getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null> {
    return this.browserDomain.getCurrentBrowserPage();
  }

  syncBrowserState(request: SyncBrowserBridgeStateRequest): Promise<{
    companion: BrowserBridgeCompanionStatus;
    tabs: BrowserBridgeTabSummary[];
    currentPage: BrowserBridgePageContext | null;
  }> {
    return this.browserDomain.syncBrowserState(request);
  }

  createBrowserCompanionPairing(
    request: CreateBrowserBridgeCompanionPairingRequest,
  ): Promise<BrowserBridgeCompanionPairingResponse> {
    return this.browserDomain.createBrowserCompanionPairing(request);
  }

  resetBrowserCompanionRevocation(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevocationResetResponse> {
    return this.browserDomain.resetBrowserCompanionRevocation(companionId);
  }

  syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: BrowserBridgeCompanionSyncRequest,
  ): Promise<BrowserBridgeCompanionSyncResponse> {
    return this.browserDomain.syncBrowserCompanion(
      companionId,
      pairingToken,
      request,
    );
  }

  preflightBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: BrowserBridgeCompanionPreflightRequest,
  ): Promise<BrowserBridgeCompanionPreflightResponse> {
    return this.browserDomain.preflightBrowserCompanion(
      companionId,
      pairingToken,
      request,
    );
  }

  listBrowserSessions(): Promise<LifeOpsBrowserSession[]> {
    return this.browserDomain.listBrowserSessions();
  }

  getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.getBrowserSession(sessionId);
  }

  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.createBrowserSession(request);
  }

  confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.confirmBrowserSession(sessionId, request);
  }

  completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.completeBrowserSession(sessionId, request);
  }

  updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.updateBrowserSessionProgress(sessionId, request);
  }

  updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: BrowserBridgeCompanionSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.updateBrowserSessionProgressFromCompanion(
      companionId,
      pairingToken,
      sessionId,
      request,
    );
  }

  beginBrowserSessionActionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: BrowserBridgeCompanionSessionBeginRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.beginBrowserSessionActionFromCompanion(
      companionId,
      pairingToken,
      sessionId,
      request,
    );
  }

  completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    return this.browserDomain.completeBrowserSessionFromCompanion(
      companionId,
      pairingToken,
      sessionId,
      request,
    );
  }

  revokeBrowserCompanion(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse> {
    return this.browserDomain.revokeBrowserCompanion(companionId);
  }

  revokeBrowserCompanionFromCompanion(
    companionId: string,
    pairingToken: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse> {
    return this.browserDomain.revokeBrowserCompanionFromCompanion(
      companionId,
      pairingToken,
    );
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly workflowsDomain = new WorkflowsDomain(this, {
    recordWorkflowAudit: (...args) => this.recordWorkflowAudit(...args),
    getWorkflowDefinition: (...args) => this.getWorkflowDefinition(...args),
    readEffectiveScheduleState: (...args) =>
      this.readEffectiveScheduleState(...args),
    emitWorkflowRunNudge: (...args) => this.emitWorkflowRunNudge(...args),
    // Workflow-step contributions reach across many domains, so the
    // execution context is the fully composed service instance, not the
    // workflows sub-service.
    workflowStepContext: this,
  });

  listWorkflows(): Promise<LifeOpsWorkflowRecord[]> {
    return this.workflowsDomain.listWorkflows();
  }

  getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord> {
    return this.workflowsDomain.getWorkflow(workflowId);
  }

  createWorkflow(
    request: CreateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    return this.workflowsDomain.createWorkflow(request);
  }

  updateWorkflow(
    workflowId: string,
    request: UpdateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord> {
    return this.workflowsDomain.updateWorkflow(workflowId, request);
  }

  runWorkflow(
    workflowId: string,
    request: {
      now?: string;
      confirmBrowserActions?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<LifeOpsWorkflowRun> {
    return this.workflowsDomain.runWorkflow(workflowId, request);
  }

  // Consumed by the reminders scheduler via the composed instance.
  runDueWorkflows(
    args: Parameters<WorkflowsDomain["runDueWorkflows"]>[0],
  ): Promise<LifeOpsWorkflowRun[]> {
    return this.workflowsDomain.runDueWorkflows(args);
  }

  runDueEventWorkflows(
    args: Parameters<WorkflowsDomain["runDueEventWorkflows"]>[0],
  ): Promise<LifeOpsWorkflowRun[]> {
    return this.workflowsDomain.runDueEventWorkflows(args);
  }

  runDueDerivedEventWorkflows(args: {
    now: string;
    limit: number;
    lifeOpsEvents?: LifeOpsDerivedEvent[];
  }): Promise<LifeOpsWorkflowRun[]> {
    return this.workflowsDomain.runDueEventWorkflows(
      args as Parameters<WorkflowsDomain["runDueEventWorkflows"]>[0],
    );
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly definitionsDomain = new DefinitionsDomain(this, {
    getDefinitionRecord: (...args) => this.getDefinitionRecord(...args),
    ensureGoalExists: (...args) => this.ensureGoalExists(...args),
    syncReminderPlan: (...args) => this.syncReminderPlan(...args),
    syncGoalLink: (...args) => this.syncGoalLink(...args),
    refreshDefinitionOccurrences: (...args) =>
      this.refreshDefinitionOccurrences(...args),
    syncNativeAppleReminderForDefinition: (...args) =>
      this.syncNativeAppleReminderForDefinition(...args),
    syncWebsiteAccessState: (...args) => this.syncWebsiteAccessState(...args),
    getFreshOccurrence: (...args) => this.getFreshOccurrence(...args),
    awardWebsiteAccessGrant: (...args) => this.awardWebsiteAccessGrant(...args),
    resolveReminderEscalation: (...args) =>
      this.resolveReminderEscalation(...args),
  });

  listDefinitions(): Promise<LifeOpsDefinitionRecord[]> {
    return this.definitionsDomain.listDefinitions();
  }

  getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord> {
    return this.definitionsDomain.getDefinition(definitionId);
  }

  async getTodos(): Promise<LifeOpsTodoView[]> {
    const overview = await this.getOverview();
    return this.definitionsDomain.getTodos(overview.owner.occurrences);
  }

  completeTodo(
    definitionId: string,
  ): Promise<LifeOpsDefinitionTransitionResult> {
    return this.definitionsDomain.transitionTodo(definitionId, "completed");
  }

  reopenTodo(definitionId: string): Promise<LifeOpsDefinitionTransitionResult> {
    return this.definitionsDomain.transitionTodo(definitionId, "active");
  }

  createDefinition(
    request: CreateLifeOpsDefinitionRequest,
    context?: DefinitionCreationContext,
  ): Promise<LifeOpsDefinitionCreationResult> {
    return this.definitionsDomain.createDefinition(request, context);
  }

  updateDefinition(
    definitionId: string,
    request: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord> {
    return this.definitionsDomain.updateDefinition(definitionId, request);
  }

  deleteDefinition(definitionId: string): Promise<void> {
    return this.definitionsDomain.deleteDefinition(definitionId);
  }

  completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView> {
    return this.definitionsDomain.completeOccurrence(
      occurrenceId,
      request,
      now,
    );
  }

  recordOccurrenceProgress(
    occurrenceId: string,
    request: RecordLifeOpsProgressRequest,
    now?: Date,
  ): Promise<RecordLifeOpsProgressResult> {
    return this.definitionsDomain.recordOccurrenceProgress(
      occurrenceId,
      request,
      now,
    );
  }

  skipOccurrence(
    occurrenceId: string,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView> {
    return this.definitionsDomain.skipOccurrence(occurrenceId, now);
  }

  snoozeOccurrence(
    occurrenceId: string,
    request: SnoozeLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView> {
    return this.definitionsDomain.snoozeOccurrence(occurrenceId, request, now);
  }

  readonly goalsDomain = new GoalsDomain(this, {
    // The reminders domain re-declares a structurally-narrower local
    // `LifeOpsGoalRecord`; GoalsDeps expects the shared contracts record. A
    // localized structural cast reconciles the two record shapes.
    getGoalRecord: (...args) => this.getSharedGoalRecord(...args),
    getDefinitionRecord: (...args) => this.getDefinitionRecord(...args),
    listActivitySignals: (...args) => this.listActivitySignals(...args),
    inspectReminder: (...args) => this.inspectReminder(...args),
    refreshEffectiveScheduleState: (...args) =>
      this.refreshEffectiveScheduleState(...args),
    refreshDefinitionOccurrences: (...args) =>
      this.refreshDefinitionOccurrences(...args),
    buildReminderPreferenceResponse: (...args) =>
      this.buildReminderPreferenceResponse(...args),
    resolveEffectiveReminderPlan: (...args) =>
      this.resolveEffectiveReminderPlan(...args),
  });

  async deleteGoal(goalId: string): Promise<void> {
    return this.goalsDomain.deleteGoal(goalId);
  }

  async listGoals(): Promise<LifeOpsGoalRecord[]> {
    return this.goalsDomain.listGoals();
  }

  getSharedGoalRecord(goalId: string): Promise<LifeOpsGoalRecord> {
    return this.getGoalRecord(goalId) as Promise<LifeOpsGoalRecord>;
  }

  async getGoal(goalId: string): Promise<LifeOpsGoalRecord> {
    return this.goalsDomain.getGoal(goalId);
  }

  async createGoal(
    request: CreateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    return this.goalsDomain.createGoal(request);
  }

  async updateGoal(
    goalId: string,
    request: UpdateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    return this.goalsDomain.updateGoal(goalId, request);
  }

  async reviewGoal(
    goalId: string,
    now = new Date(),
  ): Promise<LifeOpsGoalReview> {
    return this.goalsDomain.reviewGoal(goalId, now);
  }

  async buildGoalExperienceLoop(
    reference: {
      goalId?: string | null;
      title: string;
      description?: string | null;
      successCriteria?: Record<string, unknown> | null;
    },
    now = new Date(),
  ): Promise<LifeOpsGoalExperienceLoop> {
    return this.goalsDomain.buildGoalExperienceLoop(reference, now);
  }

  async reviewGoalsForWeek(now = new Date()): Promise<LifeOpsWeeklyGoalReview> {
    return this.goalsDomain.reviewGoalsForWeek(now);
  }

  async explainOccurrence(
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceExplanation> {
    return this.goalsDomain.explainOccurrence(occurrenceId);
  }

  async getOverview(now = new Date()): Promise<LifeOpsOverview> {
    return this.goalsDomain.getOverview(now);
  }

  /**
   * Owner occurrences completed within the owner's current local calendar
   * day, newest first. The overview above deliberately lists only OPEN
   * occurrences; recap surfaces (the lifeops provider block, the evening
   * brief) need the finished items too so an end-of-day recap can lead with
   * real wins instead of reporting an empty day (#16935). Bounded lookback
   * in UTC, then narrowed to the local day here — timezone math stays in
   * one place.
   */
  async listOwnerOccurrencesCompletedToday(
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView[]> {
    const timeZone = resolveDefaultTimeZone();
    const dayKey = (date: Date): string => {
      const parts = getZonedDateParts(date, timeZone);
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const todayKey = dayKey(now);
    const lookbackMs = 36 * 60 * 60 * 1000;
    // The owner filter lives in the SQL WHERE (not here) so the row limit is
    // applied AFTER it: with the filter in TypeScript, agent-subject
    // completions under multi-room load consumed the LIMIT window and
    // silently evicted owner wins from the recap (#16966 post-merge review).
    // The scan limit is sized for the 36h window, newest-first — the local-day
    // filter below only trims the older-than-today tail, so today's rows are
    // never the ones cut. The final cap bounds the provider/brief block.
    const views = await this.repository.listCompletedOccurrenceViewsSince(
      this.agentId(),
      new Date(now.getTime() - lookbackMs).toISOString(),
      {
        subjectType: "owner",
        definitionScopes: [
          {
            domain: "user_lifeops",
            subjectType: "owner",
            subjectId: this.ownerEntityId(),
          },
        ],
        limit: 200,
      },
    );
    return views
      .filter(
        (occurrence) => dayKey(new Date(occurrence.updatedAt)) === todayKey,
      )
      .slice(0, 24);
  }

  async listChannelPolicies(): Promise<LifeOpsChannelPolicy[]> {
    return this.goalsDomain.listChannelPolicies();
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly xDomain = new XDomain(this, {
    recordXPostAudit: (...args) => this.recordXPostAudit(...args),
    resolvePrimaryChannelPolicy: (...args) =>
      this.resolvePrimaryChannelPolicy(...args),
  });

  resolveXGrant(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    requestedAccountId?: string | null,
  ): Promise<LifeOpsConnectorGrant | null> {
    return this.xDomain.resolveXGrant(
      requestedMode,
      requestedSide,
      requestedAccountId,
    );
  }

  getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    requestedAccountId?: string | null,
  ): Promise<LifeOpsXConnectorStatus> {
    return this.xDomain.getXConnectorStatus(
      requestedMode,
      requestedSide,
      requestedAccountId,
    );
  }

  createXPost(
    request: CreateLifeOpsXPostRequest,
  ): Promise<LifeOpsXPostResponse> {
    return this.xDomain.createXPost(request);
  }

  getXDmDigest(opts?: {
    accountId?: string;
    limit?: number;
    conversationId?: string;
  }): Promise<{
    generatedAt: string;
    conversationId: string | null;
    unreadCount: number;
    readCount: number;
    repliedCount: number;
    recent: LifeOpsXDm[];
  }> {
    return this.xDomain.getXDmDigest(opts);
  }

  curateXDms(request: {
    messageIds?: string[];
    conversationId?: string;
    markRead?: boolean;
    markReplied?: boolean;
  }): Promise<{ curated: number }> {
    return this.xDomain.curateXDms(request);
  }

  sendXDirectMessage(request: {
    participantId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }> {
    return this.xDomain.sendXDirectMessage(request);
  }

  sendXConversationMessage(request: {
    conversationId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }> {
    return this.xDomain.sendXConversationMessage(request);
  }

  createXDirectMessageGroup(request: {
    participantIds: string[];
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{
    ok: boolean;
    status: number | null;
    conversationId: string | null;
    error?: string;
  }> {
    return this.xDomain.createXDirectMessageGroup(request);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly relationshipsDomain = new RelationshipsDomain(this);

  upsertRelationship(
    input: Omit<
      LifeOpsRelationship,
      "id" | "agentId" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): Promise<LifeOpsRelationship> {
    return this.relationshipsDomain.upsertRelationship(input);
  }

  getRelationship(id: string): Promise<LifeOpsRelationship | null> {
    return this.relationshipsDomain.getRelationship(id);
  }

  listRelationships(opts?: {
    limit?: number;
    primaryChannel?: LifeOpsMessageChannel;
  }): Promise<LifeOpsRelationship[]> {
    return this.relationshipsDomain.listRelationships(opts);
  }

  logInteraction(
    input: Omit<LifeOpsRelationshipInteraction, "id" | "agentId" | "createdAt">,
  ): Promise<LifeOpsRelationshipInteraction> {
    return this.relationshipsDomain.logInteraction(input);
  }

  getDaysSinceContact(relationshipId: string): Promise<number | null> {
    return this.relationshipsDomain.getDaysSinceContact(relationshipId);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly emailUnsubscribeDomain = new EmailUnsubscribeDomain(this);

  async scanEmailSubscriptions(
    requestUrl: URL,
    request: EmailUnsubscribeScanRequest = {},
  ): Promise<EmailSubscriptionScanResult> {
    return this.emailUnsubscribeDomain.scanEmailSubscriptions(
      requestUrl,
      request,
    );
  }

  async unsubscribeEmailSender(
    requestUrl: URL,
    request: EmailUnsubscribeRequest,
  ): Promise<EmailUnsubscribeResult> {
    return this.emailUnsubscribeDomain.unsubscribeEmailSender(
      requestUrl,
      request,
    );
  }

  async listEmailUnsubscribes(limit = 100): Promise<EmailUnsubscribeRecord[]> {
    return this.emailUnsubscribeDomain.listEmailUnsubscribes(limit);
  }

  summarizeEmailUnsubscribeScan(result: EmailSubscriptionScanResult): string {
    return this.emailUnsubscribeDomain.summarizeEmailUnsubscribeScan(result);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly healthDomain = new HealthDomain(this);

  getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt: string;
  }> {
    return this.healthDomain.getHealthConnectorStatus();
  }

  getHealthDataConnectorStatuses(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]> {
    return this.healthDomain.getHealthDataConnectorStatuses(
      requestUrl,
      requestedMode,
      requestedSide,
    );
  }

  getHealthDataConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus> {
    return this.healthDomain.getHealthDataConnectorStatus(
      provider,
      requestUrl,
      requestedMode,
      requestedSide,
    );
  }

  startHealthConnector(
    request: StartLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsHealthConnectorResponse> {
    return this.healthDomain.startHealthConnector(request, requestUrl);
  }

  completeHealthConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus> {
    return this.healthDomain.completeHealthConnectorCallback(callbackUrl);
  }

  disconnectHealthConnector(
    request: DisconnectLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus> {
    return this.healthDomain.disconnectHealthConnector(request, requestUrl);
  }

  syncHealthConnectors(
    request?: SyncLifeOpsHealthConnectorRequest,
  ): Promise<LifeOpsHealthSummaryResponse> {
    return this.healthDomain.syncHealthConnectors(request);
  }

  getHealthSummary(
    request?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse> {
    return this.healthDomain.getHealthSummary(request);
  }

  getHealthDailySummary(date: string): Promise<HealthDailySummary> {
    return this.healthDomain.getHealthDailySummary(date);
  }

  getHealthTrend(
    days: number,
    window: { timeZone: string },
  ): Promise<HealthDailySummary[]> {
    return this.healthDomain.getHealthTrend(days, window);
  }

  getHealthDataPoints(opts: {
    metric: HealthDataPoint["metric"];
    startAt: string;
    endAt: string;
  }): Promise<HealthDataPoint[]> {
    return this.healthDomain.getHealthDataPoints(opts);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly xReadDomain = new XReadDomain(this, {
    resolveXGrant: () => {
      const resolver = (this as OptionalXGrantResolver).resolveXGrant;
      return typeof resolver === "function"
        ? resolver.call(this)
        : Promise.resolve(null);
    },
  });

  syncXDms(opts?: XReadOpts): Promise<{ synced: number }> {
    return this.xReadDomain.syncXDms(opts);
  }

  syncXFeed(
    feedType: LifeOpsXFeedType,
    opts?: XFeedReadOpts,
  ): Promise<{ synced: number }> {
    return this.xReadDomain.syncXFeed(feedType, opts);
  }

  searchXPosts(query: string, opts?: XReadOpts): Promise<LifeOpsXFeedItem[]> {
    return this.xReadDomain.searchXPosts(query, opts);
  }

  getXDms(opts?: {
    conversationId?: string;
    limit?: number;
  }): Promise<LifeOpsXDm[]> {
    return this.xReadDomain.getXDms(opts);
  }

  getXFeedItems(
    feedType: LifeOpsXFeedType,
    opts?: { limit?: number },
  ): Promise<LifeOpsXFeedItem[]> {
    return this.xReadDomain.getXFeedItems(feedType, opts);
  }

  readXInboundDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]> {
    return this.xReadDomain.readXInboundDms(opts);
  }

  // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
  // re-exported mixin class.
  readonly imessageDomain = new IMessageDomain(this);

  getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
    return this.imessageDomain.getIMessageConnectorStatus();
  }

  sendIMessage(
    req: IMessageSendRequest,
  ): Promise<{ ok: true; messageId?: string }> {
    return this.imessageDomain.sendIMessage(req);
  }

  readIMessages(opts: {
    chatId?: string;
    since?: string;
    limit?: number;
  }): Promise<IMessageRecord[]> {
    return this.imessageDomain.readIMessages(opts);
  }

  listIMessageChats(): Promise<IMessageChat[]> {
    return this.imessageDomain.listIMessageChats();
  }

  searchIMessages(opts: {
    query: string;
    chatId?: string;
    limit?: number;
  }): Promise<IMessageRecord[]> {
    return this.imessageDomain.searchIMessages(opts);
  }

  getIMessageDeliveryStatus(
    messageIds: string[],
  ): Promise<IMessageDeliveryResult[]> {
    return this.imessageDomain.getIMessageDeliveryStatus(messageIds);
  }

  // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
  // re-exported mixin class.
  readonly telegramDomain = new TelegramDomain(this);

  getTelegramConnectorStatus(
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsTelegramConnectorStatus> {
    return this.telegramDomain.getTelegramConnectorStatus(requestedSide);
  }

  sendTelegramMessage(request: {
    side?: LifeOpsConnectorSide;
    target: string;
    message: string;
  }): Promise<{ ok: true; messageId: string | null }> {
    return this.telegramDomain.sendTelegramMessage(request);
  }

  verifyTelegramConnector(
    request: VerifyLifeOpsTelegramConnectorRequest,
  ): Promise<VerifyLifeOpsTelegramConnectorResponse> {
    return this.telegramDomain.verifyTelegramConnector(request);
  }

  searchTelegramMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<TelegramMessageSearchResult[]> {
    return this.telegramDomain.searchTelegramMessages(request);
  }

  getTelegramDeliveryStatus(_request: {
    side?: LifeOpsConnectorSide;
    target: string;
    messageIds: string[];
  }): Promise<TelegramReadReceiptResult[]> {
    return this.telegramDomain.getTelegramDeliveryStatus(_request);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly discordDomain = new DiscordDomain(this, {
    createBrowserSession: (...args) => this.createBrowserSession(...args),
    getBrowserSession: (...args) => this.getBrowserSession(...args),
    getBrowserSettings: (...args) => this.getBrowserSettings(...args),
    getCurrentBrowserPage: (...args) => this.getCurrentBrowserPage(...args),
    listBrowserCompanions: (...args) => this.listBrowserCompanions(...args),
    listBrowserTabs: (...args) => this.listBrowserTabs(...args),
    isBrowserPaused: (...args) => this.isBrowserPaused(...args),
  });

  getDiscordConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    return this.discordDomain.getDiscordConnectorStatus(side);
  }

  authorizeDiscordConnector(
    side?: LifeOpsConnectorSide,
    source?: LifeOpsOwnerBrowserAccessSource,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    return this.discordDomain.authorizeDiscordConnector(side, source);
  }

  searchDiscordMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    channelId?: string;
    limit?: number;
  }): Promise<DiscordMessageSearchResult[]> {
    return this.discordDomain.searchDiscordMessages(request);
  }

  captureDiscordDeliveryStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<DiscordMessageSearchResult[]> {
    return this.discordDomain.captureDiscordDeliveryStatus(side);
  }

  sendDiscordMessage(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    /** Discord user id target (DM via createDM); exclusive with channelId. */
    userId?: string;
    text: string;
    allowTransportFallback?: boolean;
  }): Promise<DiscordSendMessageResult> {
    return this.discordDomain.sendDiscordMessage(request);
  }

  verifyDiscordConnector(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    sendMessage?: string;
  }): Promise<DiscordConnectorVerification> {
    return this.discordDomain.verifyDiscordConnector(request);
  }

  disconnectDiscord(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    return this.discordDomain.disconnectDiscord(side);
  }

  // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
  // re-exported mixin class.
  readonly whatsappDomain = new WhatsAppDomain(this);

  getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
    return this.whatsappDomain.getWhatsAppConnectorStatus();
  }

  sendWhatsAppMessage(
    req: WhatsAppSendRequest,
  ): Promise<{ ok: true; messageId: string }> {
    return this.whatsappDomain.sendWhatsAppMessage(req);
  }

  ingestWhatsAppWebhook(
    payload: unknown,
  ): Promise<{ ingested: number; messages: WhatsAppMessage[] }> {
    return this.whatsappDomain.ingestWhatsAppWebhook(payload);
  }

  syncWhatsAppInbound(): Promise<{
    drained: number;
    messages: WhatsAppMessage[];
  }> {
    return this.whatsappDomain.syncWhatsAppInbound();
  }

  pullWhatsAppRecent(limit?: number): Promise<{
    count: number;
    messages: WhatsAppMessage[];
  }> {
    return this.whatsappDomain.pullWhatsAppRecent(limit);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly travelDomain = new TravelDomain(this, {
    createCalendarEvent: (...args) => this.createCalendarEvent(...args),
  });

  getTravelConnectorStatus() {
    return this.travelDomain.getTravelConnectorStatus();
  }

  searchFlights(request: SearchFlightsRequest): Promise<SearchFlightsResult> {
    return this.travelDomain.searchFlights(request);
  }

  getFlightOffer(offerId: string): Promise<DuffelOffer> {
    return this.travelDomain.getFlightOffer(offerId);
  }

  prepareFlightBooking(args: {
    offerId?: string | null;
    search?: SearchFlightsRequest | null;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    calendarSync?: TravelCalendarSyncPlan | null;
  }): Promise<PreparedFlightBooking> {
    return this.travelDomain.prepareFlightBooking(args);
  }

  createFlightOrder(args: {
    offer: DuffelOffer;
    passengers: ReadonlyArray<TravelBookingPassenger>;
    orderType: "hold" | "instant";
  }): Promise<DuffelOrder> {
    return this.travelDomain.createFlightOrder(args);
  }

  getTravelOrder(orderId: string): Promise<DuffelOrder> {
    return this.travelDomain.getTravelOrder(orderId);
  }

  payTravelOrder(args: {
    orderId: string;
    amount: string;
    currency: string;
  }): Promise<DuffelPayment> {
    return this.travelDomain.payTravelOrder(args);
  }

  async bookFlightItinerary(
    requestUrl: URL,
    args: {
      offerId?: string | null;
      search?: SearchFlightsRequest | null;
      passengers: ReadonlyArray<TravelBookingPassenger>;
      calendarSync?: TravelCalendarSyncPlan | null;
      calendarGrantId?: string;
    },
  ): Promise<FlightBookingExecutionResult> {
    const result = await this.travelDomain.bookFlightItinerary(
      requestUrl,
      args,
    );
    // A confirmed itinerary is the strongest travel signal we have: the owner
    // will be away for the booked window. Record it as a first-class travel
    // fact so the `during_travel` scheduling gate can derive `travelActive`.
    // The window comes from the booked order's own departure/arrival segments;
    // `calendarSync.timeZone` (when the caller supplied one) is the only
    // destination-zone signal Duffel exposes — orders carry IATA codes, not
    // zones. A store-write failure is not swallowed: a silently-dropped travel
    // fact would leave the gate blind, so we let it surface.
    const departingAt = result.order.slices[0]?.segments[0]?.departingAt;
    const lastSlice = result.order.slices[result.order.slices.length - 1];
    const arrivingAt =
      lastSlice?.segments[lastSlice.segments.length - 1]?.arrivingAt;
    if (departingAt) {
      const destinationTimezone = args.calendarSync?.timeZone ?? undefined;
      await resolveOwnerFactStore(this.runtime).setActiveTravel(
        {
          startIso: departingAt,
          ...(arrivingAt ? { endIso: arrivingAt } : {}),
          ...(destinationTimezone ? { destinationTimezone } : {}),
        },
        { source: "connector_inferred", recordedAt: new Date().toISOString() },
      );
    }
    return result;
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly schedulingDomain = new SchedulingDomain(this);

  inspectSchedule(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleInspection> {
    return this.schedulingDomain.inspectSchedule(args);
  }

  readScheduleSummary(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleSummary> {
    return this.schedulingDomain.readScheduleSummary(args);
  }

  resolveCounterpartyTarget(
    negotiation: LifeOpsSchedulingNegotiation,
  ): ReturnType<SchedulingDomain["resolveCounterpartyTarget"]> {
    return this.schedulingDomain.resolveCounterpartyTarget(negotiation);
  }

  resolveCounterpartyTargetForRelationship(
    relationshipId: string | null,
    negotiationId?: string,
  ): ReturnType<SchedulingDomain["resolveCounterpartyTargetForRelationship"]> {
    return this.schedulingDomain.resolveCounterpartyTargetForRelationship(
      relationshipId,
      negotiationId,
    );
  }

  draftOpeningMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    counterparty?: CounterpartyTarget | null,
  ): ReturnType<SchedulingDomain["draftOpeningMessage"]> {
    return this.schedulingDomain.draftOpeningMessage(negotiation, counterparty);
  }

  draftProposalMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): ReturnType<SchedulingDomain["draftProposalMessage"]> {
    return this.schedulingDomain.draftProposalMessage(
      negotiation,
      proposal,
      counterparty,
    );
  }

  draftConfirmationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): ReturnType<SchedulingDomain["draftConfirmationMessage"]> {
    return this.schedulingDomain.draftConfirmationMessage(
      negotiation,
      proposal,
      counterparty,
    );
  }

  draftCancellationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    reason?: string,
    counterparty?: CounterpartyTarget | null,
  ): ReturnType<SchedulingDomain["draftCancellationMessage"]> {
    return this.schedulingDomain.draftCancellationMessage(
      negotiation,
      reason,
      counterparty,
    );
  }

  startNegotiation(input: {
    subject: string;
    relationshipId?: string | null;
    durationMinutes?: number;
    timezone?: string;
    metadata?: Record<string, unknown>;
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingNegotiation> {
    return this.schedulingDomain.startNegotiation(input);
  }

  getNegotiation(
    id: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation | null> {
    return this.schedulingDomain.getNegotiation(id, tx);
  }

  listActiveNegotiations(opts?: {
    limit?: number;
  }): Promise<LifeOpsSchedulingNegotiation[]> {
    return this.schedulingDomain.listActiveNegotiations(opts);
  }

  proposeTime(input: {
    negotiationId: string;
    startAt: string;
    endAt: string;
    proposedBy: "agent" | "owner" | "counterparty";
    metadata?: Record<string, unknown>;
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingProposal> {
    return this.schedulingDomain.proposeTime(input);
  }

  respondToProposal(
    proposalId: string,
    status: "accepted" | "declined" | "expired",
  ): Promise<LifeOpsSchedulingProposal> {
    return this.schedulingDomain.respondToProposal(proposalId, status);
  }

  finalizeNegotiation(
    id: string,
    acceptedProposalId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation> {
    return this.schedulingDomain.finalizeNegotiation(
      id,
      acceptedProposalId,
      tx,
    );
  }

  cancelNegotiation(
    id: string,
    reason?: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation> {
    return this.schedulingDomain.cancelNegotiation(id, reason, tx);
  }

  listProposals(
    negotiationId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingProposal[]> {
    return this.schedulingDomain.listProposals(negotiationId, tx);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly subscriptionsDomain = new SubscriptionsDomain(this);

  async listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]> {
    return this.subscriptionsDomain.listSubscriptionPlaybooks();
  }

  findSubscriptionPlaybookForMerchant(merchant: string): {
    key: string;
    serviceName: string;
    managementUrl: string;
    executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
  } | null {
    return this.subscriptionsDomain.findSubscriptionPlaybookForMerchant(
      merchant,
    );
  }

  async getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null> {
    return this.subscriptionsDomain.getLatestSubscriptionAudit();
  }

  async auditSubscriptions(
    requestUrl: URL,
    request: LifeOpsSubscriptionDiscoveryRequest = {},
  ): Promise<LifeOpsSubscriptionAuditSummary> {
    return this.subscriptionsDomain.auditSubscriptions(requestUrl, request);
  }

  async getSubscriptionCancellationStatus(args: {
    cancellationId?: string | null;
    serviceName?: string | null;
    serviceSlug?: string | null;
  }): Promise<LifeOpsSubscriptionCancellationSummary | null> {
    return this.subscriptionsDomain.getSubscriptionCancellationStatus(args);
  }

  async cancelSubscription(
    request: LifeOpsSubscriptionCancellationRequest,
  ): Promise<LifeOpsSubscriptionCancellationSummary> {
    return this.subscriptionsDomain.cancelSubscription(request);
  }

  summarizeSubscriptionAudit(summary: LifeOpsSubscriptionAuditSummary): string {
    return this.subscriptionsDomain.summarizeSubscriptionAudit(summary);
  }

  summarizeSubscriptionCancellation(
    summary: LifeOpsSubscriptionCancellationSummary,
  ): string {
    return this.subscriptionsDomain.summarizeSubscriptionCancellation(summary);
  }

  resolveSubscriptionIntent(text: string): {
    mode: "audit" | "cancel" | "status" | null;
    serviceName?: string;
    serviceSlug?: string;
    executor?: LifeOpsSubscriptionExecutor;
  } {
    return this.subscriptionsDomain.resolveSubscriptionIntent(text);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly statusDomain = new StatusDomain(this, {
    getScheduleMergedState: (...args) => this.getScheduleMergedState(...args),
    getBrowserSettings: (...args) => this.getBrowserSettings(...args),
    listBrowserCompanions: (...args) => this.listBrowserCompanions(...args),
    getXConnectorStatus: (...args) => this.getXConnectorStatus(...args),
    getHealthConnectorStatus: (...args) =>
      this.getHealthConnectorStatus(...args),
  });

  getCapabilityStatus(now?: Date): Promise<LifeOpsCapabilitiesStatus> {
    return this.statusDomain.getCapabilityStatus(now);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly screenTimeDomain = new ScreenTimeDomain(this, {
    getBrowserSettings: (...args) => this.getBrowserSettings(...args),
    listBrowserCompanions: (...args) => this.listBrowserCompanions(...args),
  });

  recordScreenTimeEvent(
    event: ScreenTimeEventInput,
  ): Promise<LifeOpsScreenTimeSession> {
    return this.screenTimeDomain.recordScreenTimeEvent(event);
  }

  finishActiveScreenTimeSession(
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void> {
    return this.screenTimeDomain.finishActiveScreenTimeSession(
      id,
      endAt,
      durationSeconds,
    );
  }

  collectScreenTimeRows(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
  }): Promise<ScreenTimeAggregateRow[]> {
    return this.screenTimeDomain.collectScreenTimeRows(opts);
  }

  getScreenTimeDaily(opts: {
    date: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    limit?: number;
  }): Promise<LifeOpsScreenTimeDaily[]> {
    return this.screenTimeDomain.getScreenTimeDaily(opts);
  }

  getScreenTimeSummary(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<LifeOpsScreenTimeSummary> {
    return this.screenTimeDomain.getScreenTimeSummary(opts);
  }

  getScreenTimeBreakdown(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeBreakdown> {
    return this.screenTimeDomain.getScreenTimeBreakdown(opts);
  }

  getSocialHabitSummary(opts: {
    since: string;
    until: string;
    topN?: number;
  }): Promise<SocialHabitSummary> {
    return this.screenTimeDomain.getSocialHabitSummary(opts);
  }

  getScreenTimeHistory(opts: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse> {
    return this.screenTimeDomain.getScreenTimeHistory(opts);
  }

  getScreenTimeWeeklyAverageByApp(opts: {
    since: string;
    until: string;
    daysInWindow: number;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeWeeklyAverageResponse> {
    return this.screenTimeDomain.getScreenTimeWeeklyAverageByApp(opts);
  }

  aggregateDailyForDate(date: string): Promise<{ updated: number }> {
    return this.screenTimeDomain.aggregateDailyForDate(date);
  }

  // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly sleepDomain = new SleepDomain(this);

  getSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse> {
    return this.sleepDomain.getSleepHistory(opts);
  }

  getSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse> {
    return this.sleepDomain.getSleepRegularity(opts);
  }

  getPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse> {
    return this.sleepDomain.getPersonalBaseline(opts);
  }

  // The inbox aggregation domain lives in @elizaos/plugin-inbox
  // (`inbox/aggregate.ts`). PA is the composition host: it injects the
  // host-owned pieces through the domain's typed seams — the
  // `life_inbox_messages` cache (LifeOpsRepository satisfies
  // InboxMessageCache), the Gmail/X connector projections, and the owner's
  // priority-scoring policy from the LifeOps app state.
  // Public (not private) to avoid TS4094 on the re-exported mixin class.
  readonly inboxDomain = new InboxDomain({
    runtime: this.runtime,
    cache: this.repository,
    sources: {
      getGoogleConnectorStatus: (...args) =>
        this.getGoogleConnectorStatus(...args),
      getGmailTriage: (...args) => this.getGmailTriage(...args),
      getXConnectorStatus: (...args) => this.getXConnectorStatus(...args),
      syncXDms: (...args) => this.syncXDms(...args),
      getXDms: (...args) => this.getXDms(...args),
    },
    loadPriorityScoringSettings: async () => {
      // Deterministic harnesses opt out the same way they disable the
      // character-voice rewrite (ACTION_CALLBACK_VOICE_REWRITE): scoring spends
      // background TEXT_SMALL calls that a strict scenario LLM proxy has no
      // fixtures for, and the resulting reported errors contaminate the
      // RECENT_ERRORS provider text that strict turn fixtures key on.
      const scoringOverride = this.runtime.getSetting(
        "LIFEOPS_INBOX_PRIORITY_SCORING",
      );
      if (
        scoringOverride === false ||
        (typeof scoringOverride === "string" &&
          scoringOverride.trim().toLowerCase() === "false")
      ) {
        return { enabled: false, model: null };
      }
      try {
        const state = await loadLifeOpsAppState(this.runtime);
        return {
          enabled: state.priorityScoring.enabled === true,
          model: state.priorityScoring.model ?? null,
        };
      } catch (error) {
        this.logLifeOpsWarn(
          "inbox.priority_scoring_settings",
          "failed to load priority scoring settings; using default model",
          { error: error instanceof Error ? error.message : String(error) },
        );
        return { enabled: true, model: null };
      }
    },
  });

  getInbox(request: GetLifeOpsInboxRequest = {}): Promise<LifeOpsInbox> {
    return this.inboxDomain.getInbox(request);
  }

  async markInboxEntryRead(inboxEntryId: string): Promise<LifeOpsInboxMessage> {
    const id = requireNonEmptyString(inboxEntryId, "inboxEntryId");
    const message = await this.inboxDomain.markInboxEntryRead(id);
    if (!message) {
      fail(404, "life-ops inbox entry not found");
    }
    return message;
  }
}
