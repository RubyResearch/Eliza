/**
 * Shared type surface for the Google connector: the account reference every
 * call is scoped by (`GoogleAccountRef`), OAuth provider metadata/config shapes,
 * the DTOs returned by each sub-client (Gmail, Calendar, Drive, Meet), and the
 * `IGoogle*Service` interfaces that `GoogleWorkspaceService` implements. These
 * are the contract the service, clients, and consumers agree on.
 */
import type { Service } from "@elizaos/core";
// Import the auth client type through googleapis' own re-export so the type
// identity always matches the google-auth-library copy googleapis was built
// against (bun's isolated linker can install two copies, which makes a direct
// google-auth-library import nominally incompatible with googleapis Options).
import type { Auth } from "googleapis";
import type { GoogleCapability } from "./scopes.js";

export const GOOGLE_SERVICE_NAME = "google";

export type GoogleAccountId = string;

export interface GoogleAccountRef {
  accountId: GoogleAccountId;
}

export type GoogleAuthClient = Auth.OAuth2Client;

export interface GoogleAuthResolutionRequest extends GoogleAccountRef {
  provider: typeof GOOGLE_SERVICE_NAME;
  capabilities: readonly GoogleCapability[];
  scopes: readonly string[];
  reason: string;
}

export interface GoogleCredentialResolver {
  getAuthClient(request: GoogleAuthResolutionRequest): Promise<GoogleAuthClient>;
}

export interface GoogleOAuthProviderMetadata {
  provider: typeof GOOGLE_SERVICE_NAME;
  label: string;
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth";
  tokenEndpoint: "https://oauth2.googleapis.com/token";
  revokeEndpoint: "https://oauth2.googleapis.com/revoke";
  clientIdSetting: "GOOGLE_CLIENT_ID";
  clientSecretSetting: "GOOGLE_CLIENT_SECRET";
  redirectUriSetting: "GOOGLE_REDIRECT_URI";
  responseType: "code";
  accessType: "offline";
  prompt: "consent";
  supportsPkce: true;
  identityScopes: readonly string[];
  capabilities: readonly GoogleCapability[];
}

export interface GoogleOAuthProviderConfig {
  provider: typeof GOOGLE_SERVICE_NAME;
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth";
  tokenUrl: "https://oauth2.googleapis.com/token";
  capabilities: readonly GoogleCapability[];
  scopes: readonly string[];
  authorizationParams: {
    access_type: "offline";
    prompt: "consent";
    include_granted_scopes: "false";
  };
}

export interface GoogleEmailAddress {
  email: string;
  name?: string;
}

export type GoogleCalendarAttendeeResponseStatus =
  | "needsAction"
  | "declined"
  | "tentative"
  | "accepted";

export interface GoogleCalendarAttendeeInput extends GoogleEmailAddress {
  responseStatus?: GoogleCalendarAttendeeResponseStatus;
  optional?: boolean;
}

export interface GoogleCalendarAttendee extends GoogleEmailAddress {
  responseStatus: GoogleCalendarAttendeeResponseStatus | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export type GoogleCalendarSendUpdates = "all" | "externalOnly" | "none";

export type GoogleCalendarTransparency = "opaque" | "transparent";

export type GoogleCalendarVisibility = "default" | "public" | "private" | "confidential";

export interface GoogleMessageSummary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: GoogleEmailAddress;
  replyTo?: GoogleEmailAddress;
  to?: GoogleEmailAddress[];
  cc?: GoogleEmailAddress[];
  snippet?: string;
  receivedAt?: string;
  labelIds?: string[];
  bodyText?: string;
  bodyHtml?: string;
  headers?: Record<string, string>;
}

export interface GoogleSendEmailInput extends GoogleAccountRef {
  to: GoogleEmailAddress[];
  cc?: GoogleEmailAddress[];
  bcc?: GoogleEmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  threadId?: string;
}

export type GoogleGmailBulkOperation =
  | "archive"
  | "trash"
  | "delete"
  | "report_spam"
  | "mark_read"
  | "mark_unread"
  | "apply_label"
  | "remove_label";

export interface GoogleGmailMutationFailure {
  messageId: string;
  code: number | null;
  retryable: boolean;
}

export interface GoogleGmailMutationReceipt {
  operation: GoogleGmailBulkOperation;
  requestedMessageIds: string[];
  succeededMessageIds: string[];
  failures: GoogleGmailMutationFailure[];
}

export interface GoogleGmailMessageSummary {
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
}

export interface GoogleGmailMessageDetail {
  message: GoogleGmailMessageSummary;
  bodyText: string;
}

export interface GoogleGmailUnrespondedThread {
  threadId: string;
  externalMessageId: string;
  subject: string;
  to: string[];
  cc: string[];
  lastOutboundAt: string;
  lastInboundAt: string | null;
  daysWaiting: number;
  snippet: string;
  labels: string[];
  htmlLink: string | null;
}

export interface GoogleGmailSendResult {
  messageId: string | null;
  threadId: string | null;
  labelIds: string[];
}

export interface GoogleGmailDraftResult extends GoogleGmailSendResult {
  draftId: string;
}

export interface GoogleGmailHistoryMessageRef {
  messageId: string;
  threadId: string | null;
  labelIds: string[];
}

export interface GoogleGmailHistoryChange {
  historyId: string;
  messagesAdded: GoogleGmailHistoryMessageRef[];
  messagesDeleted: GoogleGmailHistoryMessageRef[];
  labelsAdded: Array<GoogleGmailHistoryMessageRef & { changedLabelIds: string[] }>;
  labelsRemoved: Array<GoogleGmailHistoryMessageRef & { changedLabelIds: string[] }>;
}

export interface GoogleGmailHistoryPage {
  changes: GoogleGmailHistoryChange[];
  nextPageToken: string | null;
  historyId: string;
}

/**
 * One provider page of a Gmail search. `nextPageToken` is null only when the
 * provider reported no further page, so a caller that walks pages until null
 * has seen every message matching the query.
 */
export interface GoogleGmailSearchPage {
  messages: GoogleGmailMessageSummary[];
  nextPageToken: string | null;
}

export interface GoogleGmailSubscriptionMessageHeaders {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  fromDisplay: string;
  fromEmail: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  snippet: string;
  labels: string[];
}

export interface GoogleGmailFilterCreateResult {
  filterId: string | null;
  trashed: boolean;
}

export interface GoogleParsedMailto {
  recipient: string;
  subject: string | null;
  body: string | null;
}

export interface GoogleCalendarEventInput extends GoogleAccountRef {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  attendees?: GoogleCalendarAttendeeInput[];
  location?: string;
  description?: string;
  createMeetLink?: boolean;
  timeZone?: string;
  /**
   * Controls attendee notification email. Omission is treated as `none` so an
   * agent cannot notify external people without making that side effect explicit.
   */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** RFC 5545 recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  recurrence?: string[];
  /**
   * Stable caller key for exactly-once creation. The connector hashes this
   * value into a provider event id and private marker; the raw key never leaves
   * the process.
   */
  idempotencyKey?: string;
}

export interface GoogleCalendarEventPatchInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: GoogleCalendarAttendeeInput[];
  location?: string;
  description?: string;
  timeZone?: string;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Replacement RFC 5545 recurrence lines. Valid on series masters only. */
  recurrence?: string[];
  /** Provider ETag required by an approval-bound conditional write. */
  expectedEtag?: string;
}

export interface GoogleCalendarEventDeleteInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Provider ETag required by an approval-bound conditional delete. */
  expectedEtag?: string;
}

export interface GoogleCalendarEventResponseInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  responseStatus: Extract<
    GoogleCalendarAttendeeResponseStatus,
    "accepted" | "declined" | "tentative"
  >;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Provider ETag required by an approval-bound conditional response. */
  expectedEtag?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  title?: string;
  status?: string;
  start?: string;
  end?: string;
  isAllDay?: boolean;
  timeZone?: string | null;
  htmlLink?: string;
  meetLink?: string;
  attendees?: GoogleCalendarAttendee[];
  location?: string;
  description?: string;
  organizer?: GoogleEmailAddress & { self?: boolean };
  transparency?: GoogleCalendarTransparency;
  visibility?: GoogleCalendarVisibility;
  /** RFC 5545 recurrence lines when the event is a recurring series master. */
  recurrence?: string[] | null;
  /** Series master event id when this event is a flattened occurrence. */
  recurringEventId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GoogleCalendarListEntry {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  /** Present on incremental-sync tombstones. */
  deleted?: boolean;
  hidden?: boolean;
}

export interface GoogleCalendarListPageInput extends GoogleAccountRef {
  pageToken?: string;
  syncToken?: string;
  maxResults?: number;
  showDeleted?: boolean;
  showHidden?: boolean;
  minAccessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
}

export interface GoogleCalendarListPage {
  calendars: GoogleCalendarListEntry[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface GoogleCalendarEventListPageInput extends GoogleAccountRef {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  pageToken?: string;
  syncToken?: string;
  timeZone?: string;
  showDeleted?: boolean;
  /**
   * Google suppresses nextSyncToken on any events.list request that carries
   * orderBy, so sync drains must leave this unset; only display paths that
   * need provider-side ordering opt in.
   */
  orderBy?: "startTime" | "updated";
}

export interface GoogleCalendarEventListPage {
  events: GoogleCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface GoogleCalendarWatchInput extends GoogleAccountRef {
  calendarId?: string;
  channelId: string;
  address: string;
  token: string;
  ttlSeconds: number;
}

export interface GoogleCalendarWatchResponse {
  channelId: string;
  resourceId: string;
  resourceUri: string;
  token: string | null;
  expirationAt: string;
}

export interface GoogleCalendarStopChannelInput extends GoogleAccountRef {
  channelId: string;
  resourceId: string;
}

export interface GoogleCalendarBusyInterval {
  start: string;
  end: string;
}

export interface GoogleCalendarFreeBusyError {
  domain: string | null;
  reason: string | null;
}

export interface GoogleCalendarFreeBusyCalendar {
  busy: GoogleCalendarBusyInterval[];
  errors: GoogleCalendarFreeBusyError[];
}

export interface GoogleCalendarFreeBusyInput extends GoogleAccountRef {
  timeMin: string;
  timeMax: string;
  calendarIds: readonly string[];
  timeZone?: string;
  groupExpansionMax?: number;
  calendarExpansionMax?: number;
}

/**
 * Availability-only response. It intentionally has no event metadata, titles,
 * descriptions, attendee identities, or expanded group membership.
 */
export interface GoogleCalendarFreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Record<string, GoogleCalendarFreeBusyCalendar>;
}

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

export interface GoogleDriveFileList {
  files: GoogleDriveFile[];
  nextPageToken: string | null;
}

export interface GooglePersonEmailAddress {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface GooglePersonPhoneNumber {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface GooglePersonOrganization {
  name?: string;
  title?: string;
}

export interface GooglePersonContact {
  /** People API resource name, e.g. `people/c123`. Stable per-account handle. */
  resourceName: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  emailAddresses: GooglePersonEmailAddress[];
  phoneNumbers: GooglePersonPhoneNumber[];
  organizations: GooglePersonOrganization[];
  photoUrl?: string;
  /** "contact" for saved contacts, "otherContact" for interaction-derived entries. */
  source: "contact" | "otherContact";
}

export interface GooglePeopleContactPage {
  contacts: GooglePersonContact[];
  nextPageToken: string | null;
}

export interface GooglePeopleListContactsInput extends GoogleAccountRef {
  maxResults?: number;
  pageToken?: string;
}

export interface GooglePeopleSearchContactsInput extends GoogleAccountRef {
  query: string;
  maxResults?: number;
  /** Include interaction-derived "Other Contacts" in the search (default true). */
  includeOtherContacts?: boolean;
}

export interface GooglePeopleGetContactInput extends GoogleAccountRef {
  resourceName: string;
}

export interface GoogleDocContent {
  title: string;
  plainText: string;
}

export interface GoogleSheetContent {
  title: string;
  rows: string[][];
}

export interface GoogleDriveCreateFileInput extends GoogleAccountRef {
  name: string;
  mimeType: string;
  content?: string | Uint8Array;
  parentFolderId?: string;
}

export interface GoogleSheetUpdateResult {
  updatedRange: string;
  updatedCells: number;
}

export type GoogleMeetAccessType = "OPEN" | "TRUSTED" | "RESTRICTED";

export enum GoogleMeetStatus {
  WAITING = "waiting",
  ACTIVE = "active",
  ENDED = "ended",
  ERROR = "error",
}

export interface GoogleMeetSpace {
  id: string;
  spaceName: string;
  meetingCode?: string;
  meetingUri: string;
  title?: string;
  accessType?: GoogleMeetAccessType;
  activeConferenceRecord?: string;
}

export interface GoogleMeetMeeting extends GoogleMeetSpace {
  title?: string;
  startTime?: string;
  endTime?: string;
  participants: GoogleMeetParticipant[];
  transcripts: GoogleMeetTranscript[];
  status: GoogleMeetStatus;
}

export interface GoogleMeetConferenceRecord {
  id: string;
  name: string;
  spaceName?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

export interface GoogleMeetParticipant {
  id: string;
  name: string;
  displayName?: string;
  joinTime?: string;
  leaveTime?: string;
  isActive: boolean;
  userType?: "signed_in" | "anonymous" | "phone" | "unknown";
}

export interface GoogleMeetParticipantSession {
  id: string;
  name: string;
  participantId: string;
  participantName: string;
  startTime?: string;
  endTime?: string;
  isActive: boolean;
}

export interface GoogleMeetTranscript {
  id: string;
  speakerName?: string;
  speakerId?: string;
  text: string;
  timestamp?: string;
  startTime?: string;
  endTime?: string;
  languageCode?: string;
  confidence?: number;
}

export interface GoogleMeetTranscriptArtifact {
  id: string;
  name: string;
  documentId?: string;
  documentUri?: string;
  startTime?: string;
  endTime?: string;
  state?: string;
}

export interface GoogleMeetRecording {
  id: string;
  name: string;
  uri?: string;
  fileId?: string;
  startTime?: string;
  endTime?: string;
  state?: string;
}

export interface GoogleMeetActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
  priority: "low" | "medium" | "high";
}

export type GoogleMeetCanonicalStreamKind =
  | "google_transcript_entries"
  | "google_docs_transcript"
  | "google_recording"
  | "bot_free_system_audio"
  | "bot_free_microphone"
  | "bot_free_screen_video";

export interface GoogleMeetCanonicalStream {
  id: string;
  kind: GoogleMeetCanonicalStreamKind;
  artifactId?: string;
  uri?: string;
  fileId?: string;
  startedAt?: string;
  endedAt?: string;
  state?: string;
}

export interface GoogleMeetCanonicalParticipant {
  id: string;
  displayName: string;
  userType?: GoogleMeetParticipant["userType"];
  nameProvenance: "google_signed_in" | "google_anonymous" | "phone" | "unknown";
}

export interface GoogleMeetCanonicalParticipantSession {
  id: string;
  participantId: string;
  startedAt?: string;
  endedAt?: string;
  isActive: boolean;
}

export interface GoogleMeetCanonicalTranscriptSpan {
  id: string;
  streamId: string;
  source: "google_meet_transcript_entry" | "bot_free_capture";
  text: string;
  participantId?: string;
  speakerLabel?: string;
  startedAt?: string;
  endedAt?: string;
  languageCode?: string;
  provenance: {
    transcriptName?: string;
    entryName?: string;
    participantName?: string;
  };
}

export interface GoogleMeetCanonicalGeneratedNote {
  id: string;
  kind: "summary" | "key_point" | "action_item";
  text: string;
  sourceSpanIds: string[];
  assignee?: string;
  dueDate?: string;
  priority?: GoogleMeetActionItem["priority"];
}

export type GoogleMeetMissingArtifactReason =
  | "no_transcript"
  | "transcript_delayed"
  | "missing_recording"
  | "revoked_access"
  | "permission_denied"
  | "meeting_not_found"
  | "organizer_only_artifact"
  | "expired_media_url";

export interface GoogleMeetMissingArtifact {
  artifactType: "conference" | "transcript" | "recording" | "participant_sessions";
  reason: GoogleMeetMissingArtifactReason;
  message: string;
  sourceName?: string;
}

export interface GoogleMeetCanonicalWarning {
  code:
    | "docs_transcript_mismatch"
    | "speaker_reference_missing"
    | "transcript_entry_empty"
    | "organizer_only_artifact"
    | "expired_media_url";
  message: string;
  sourceName?: string;
}

export interface GoogleMeetBotFreeCaptureArtifact {
  id: string;
  systemAudioUri?: string;
  microphoneAudioUri?: string;
  screenVideoUri?: string;
  startedAt?: string;
  endedAt?: string;
  transcriptSpans?: GoogleMeetTranscript[];
}

export interface GoogleMeetCanonicalArtifact {
  schemaVersion: "elizaos.meeting_artifact.v1";
  source: "google_meet";
  meeting: {
    id: string;
    conferenceRecordName: string;
    spaceName?: string;
    startedAt?: string;
    endedAt?: string;
    expireTime?: string;
    durationMinutes: number;
  };
  streams: GoogleMeetCanonicalStream[];
  participants: GoogleMeetCanonicalParticipant[];
  participantSessions: GoogleMeetCanonicalParticipantSession[];
  transcriptSpans: GoogleMeetCanonicalTranscriptSpan[];
  generatedNotes: GoogleMeetCanonicalGeneratedNote[];
  recordings: GoogleMeetRecording[];
  warnings: GoogleMeetCanonicalWarning[];
  missingArtifacts: GoogleMeetMissingArtifact[];
  metrics: {
    transcriptWordCount: number;
    participantCount: number;
    participantSessionCount: number;
    transcriptSpanCount: number;
    recordingCount: number;
    missingArtifactCount: number;
    warningCount: number;
  };
}

export interface GoogleMeetCanonicalArtifactInput {
  meetingId: string;
  conferenceRecordName: string;
  conference: GoogleMeetConferenceRecord;
  participants: readonly GoogleMeetParticipant[];
  participantSessions?: readonly GoogleMeetParticipantSession[];
  transcriptArtifacts: readonly GoogleMeetTranscriptArtifact[];
  transcriptEntries: readonly GoogleMeetTranscript[];
  recordings: readonly GoogleMeetRecording[];
  summary: string;
  keyPoints: readonly string[];
  actionItems: readonly GoogleMeetActionItem[];
  googleDocsTranscriptText?: string;
  botFreeCapture?: GoogleMeetBotFreeCaptureArtifact;
}

export interface GoogleMeetReport {
  meetingId: string;
  conferenceRecordName: string;
  title?: string;
  date?: string;
  durationMinutes: number;
  participants: GoogleMeetParticipant[];
  summary: string;
  keyPoints: string[];
  actionItems: GoogleMeetActionItem[];
  fullTranscript: GoogleMeetTranscript[];
  recordings: GoogleMeetRecording[];
  participantSessions: GoogleMeetParticipantSession[];
  canonicalArtifact: GoogleMeetCanonicalArtifact;
}

export interface GoogleMeetCreateMeetingInput extends GoogleAccountRef {
  title?: string;
  accessType?: GoogleMeetAccessType;
}

export interface GoogleMeetGetMeetingInput extends GoogleAccountRef {
  meetingId: string;
}

export interface GoogleMeetConferenceRecordInput extends GoogleAccountRef {
  conferenceRecordName: string;
}

export interface GoogleMeetParticipantSessionInput extends GoogleAccountRef {
  participantName: string;
}

export interface GoogleMeetTranscriptInput extends GoogleAccountRef {
  transcriptName: string;
}

export interface GoogleMeetRecordingInput extends GoogleAccountRef {
  recordingName: string;
}

export interface GoogleMeetGenerateReportInput extends GoogleAccountRef {
  meetingId?: string;
  conferenceRecordName?: string;
  transcriptName?: string;
  includeSummary?: boolean;
  includeActionItems?: boolean;
  includeTranscript?: boolean;
  includeRecordings?: boolean;
  googleDocsTranscriptText?: string;
  botFreeCapture?: GoogleMeetBotFreeCaptureArtifact;
}

export interface IGoogleGmailService extends Service {
  getGmailHistoryId(params: GoogleAccountRef): Promise<string>;
  listGmailHistoryPage(
    params: GoogleAccountRef & {
      startHistoryId: string;
      pageToken?: string;
      maxResults?: number;
    }
  ): Promise<GoogleGmailHistoryPage>;
  searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]>;
  getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary>;
  sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }>;
  listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]>;
  searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]>;
  searchGmailMessagesPage(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      pageToken?: string | null;
      pageSize?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailSearchPage>;
  getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null>;
  getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null>;
  listGmailUnrespondedThreads(
    params: GoogleAccountRef & {
      selfEmail?: string | null;
      olderThanDays?: number;
      maxResults?: number;
      now?: Date;
    }
  ): Promise<GoogleGmailUnrespondedThread[]>;
  modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<GoogleGmailMutationReceipt>;
  sendGmailReply(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailSendResult>;
  sendGmailMessage(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<GoogleGmailSendResult>;
  createGmailDraft(
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
  ): Promise<GoogleGmailDraftResult>;
  getGmailSubscriptionHeaders(
    params: GoogleAccountRef & { query?: string; maxMessages?: number }
  ): Promise<GoogleGmailSubscriptionMessageHeaders[]>;
  createGmailFilterForSender(
    params: GoogleAccountRef & { fromAddress: string; trash?: boolean }
  ): Promise<GoogleGmailFilterCreateResult>;
  trashGmailThread(params: GoogleAccountRef & { threadId: string }): Promise<void>;
  modifyGmailMessageLabels(
    params: GoogleAccountRef & {
      messageId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    }
  ): Promise<void>;
  sendMailtoUnsubscribeEmail(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<void>;
}

export interface IGoogleCalendarService extends Service {
  listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]>;
  listCalendarPage(params: GoogleCalendarListPageInput): Promise<GoogleCalendarListPage>;
  listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      /** Google page size; the convenience method still drains every page. */
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]>;
  listEventPage(params: GoogleCalendarEventListPageInput): Promise<GoogleCalendarEventListPage>;
  watchEvents(params: GoogleCalendarWatchInput): Promise<GoogleCalendarWatchResponse>;
  stopCalendarChannel(params: GoogleCalendarStopChannelInput): Promise<void>;
  queryFreeBusy(params: GoogleCalendarFreeBusyInput): Promise<GoogleCalendarFreeBusyResult>;
  getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent>;
  findEventByIdempotencyKey(
    params: GoogleAccountRef & { calendarId: string; idempotencyKey: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent | null>;
  createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent>;
  updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent>;
  deleteEvent(params: GoogleCalendarEventDeleteInput): Promise<void>;
  respondToEvent(params: GoogleCalendarEventResponseInput): Promise<GoogleCalendarEvent>;
}

export interface IGoogleDriveService extends Service {
  searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]>;
  getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile>;
  listDriveFiles(
    params: GoogleAccountRef & { folderId?: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList>;
  searchDriveFiles(
    params: GoogleAccountRef & { query: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList>;
  getDocContent(params: GoogleAccountRef & { documentId: string }): Promise<GoogleDocContent>;
  getSheetContent(
    params: GoogleAccountRef & { spreadsheetId: string; range?: string }
  ): Promise<GoogleSheetContent>;
  createDriveFile(params: GoogleDriveCreateFileInput): Promise<GoogleDriveFile>;
  appendToDoc(params: GoogleAccountRef & { documentId: string; text: string }): Promise<void>;
  updateSheetCells(
    params: GoogleAccountRef & {
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    }
  ): Promise<GoogleSheetUpdateResult>;
}

export interface IGooglePeopleService extends Service {
  listContacts(params: GooglePeopleListContactsInput): Promise<GooglePeopleContactPage>;
  searchContacts(params: GooglePeopleSearchContactsInput): Promise<GooglePersonContact[]>;
  getContact(params: GooglePeopleGetContactInput): Promise<GooglePersonContact>;
}

export interface IGoogleMeetService extends Service {
  createMeeting(params: GoogleMeetCreateMeetingInput): Promise<GoogleMeetMeeting>;
  getMeeting(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetMeeting>;
  getMeetingSpace(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetSpace>;
  getConferenceRecord(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetConferenceRecord>;
  listMeetingParticipants(
    params: GoogleMeetConferenceRecordInput & { limit?: number }
  ): Promise<GoogleMeetParticipant[]>;
  listMeetingParticipantSessions(
    params: GoogleMeetParticipantSessionInput & { limit?: number }
  ): Promise<GoogleMeetParticipantSession[]>;
  listMeetingTranscripts(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetTranscriptArtifact[]>;
  getMeetingTranscript(params: GoogleMeetTranscriptInput): Promise<GoogleMeetTranscript[]>;
  listMeetingRecordings(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetRecording[]>;
  getMeetingRecordingUrl(params: GoogleMeetRecordingInput): Promise<string | null>;
  endMeeting(params: GoogleAccountRef & { spaceName: string }): Promise<void>;
  generateReport(params: GoogleMeetGenerateReportInput): Promise<GoogleMeetReport>;
}

export interface IGoogleWorkspaceService
  extends IGoogleGmailService,
    IGoogleCalendarService,
    IGoogleDriveService,
    IGoogleMeetService,
    IGooglePeopleService {
  getOAuthProviderConfig(capabilities: readonly GoogleCapability[]): GoogleOAuthProviderConfig;
  getOAuthProviderMetadata(): GoogleOAuthProviderMetadata;
}
