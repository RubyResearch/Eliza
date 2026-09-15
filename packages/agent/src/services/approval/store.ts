/**
 * Persistent, subject-authorized approval state machine backed by the public
 * `approval_requests` table. Every decision and execution mutation uses an
 * agent-and-subject-scoped compare-and-swap; durable attempt metadata separates
 * safe retries from provider outcomes that require reconciliation.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentNotification,
  ElizaError,
  type IAgentRuntime,
  logger,
  type NotificationInput,
  ServiceType,
  stableStringify,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  ApprovalDispatchControlStore,
  approvalAccountAdmissionSql,
  approvalDispatchAdmissionCte,
} from "./dispatch-control.ts";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlText,
  type TransactionalDb,
  toText,
} from "./sql.ts";
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalEnqueueInput,
  type ApprovalEnqueueResult,
  type ApprovalExecution,
  type ApprovalExecutionClaim,
  type ApprovalExecutionCompletion,
  type ApprovalExecutionFailure,
  type ApprovalExecutionMutation,
  type ApprovalExecutionReconciliation,
  ApprovalIdempotencyConflictError,
  type ApprovalListFilter,
  ApprovalNotFoundError,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalQueueOptions,
  type ApprovalRequest,
  type ApprovalRequestState,
  type ApprovalResolution,
  ApprovalStateTransitionError,
} from "./types.ts";

const ALLOWED_TRANSITIONS: Readonly<
  Record<ApprovalRequestState, ReadonlyArray<ApprovalRequestState>>
> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["executing", "rejected", "expired"],
  executing: ["done", "retryable", "reconciliation_required"],
  retryable: ["executing", "rejected", "expired"],
  reconciliation_required: ["done", "retryable"],
  done: [],
  rejected: [],
  expired: [],
};

function assertTransition(
  id: string,
  from: ApprovalRequestState,
  to: ApprovalRequestState,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ApprovalStateTransitionError(id, from, to);
  }
}

const VALID_STATES: ReadonlySet<ApprovalRequestState> = new Set([
  "pending",
  "approved",
  "executing",
  "retryable",
  "reconciliation_required",
  "done",
  "rejected",
  "expired",
]);

const VALID_ACTIONS: ReadonlySet<ApprovalAction> = new Set([
  "send_message",
  "send_email",
  "schedule_event",
  "modify_event",
  "cancel_event",
  "book_travel",
  "make_call",
  "sign_document",
  "execute_workflow",
  "spend_money",
]);

const VALID_CHANNELS: ReadonlySet<ApprovalChannel> = new Set([
  "telegram",
  "discord",
  "whatsapp",
  "slack",
  "imessage",
  "sms",
  "x_dm",
  "email",
  "google_calendar",
  "microsoft_calendar",
  "apple_calendar",
  "ics_calendar",
  "browser",
  "phone",
  "internal",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown): ApprovalRequestState {
  const text = toText(value);
  if (!VALID_STATES.has(text as ApprovalRequestState)) {
    throw new Error(`[ApprovalQueue] unknown state from db: ${text}`);
  }
  return text as ApprovalRequestState;
}

function parseAction(value: unknown): ApprovalAction {
  const text = toText(value);
  if (!VALID_ACTIONS.has(text as ApprovalAction)) {
    throw new Error(`[ApprovalQueue] unknown action from db: ${text}`);
  }
  return text as ApprovalAction;
}

function parseChannel(value: unknown): ApprovalChannel {
  const text = toText(value);
  if (!VALID_CHANNELS.has(text as ApprovalChannel)) {
    throw new Error(`[ApprovalQueue] unknown channel from db: ${text}`);
  }
  return text as ApprovalChannel;
}

function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = toText(value);
  if (!text) {
    throw new Error("[ApprovalQueue] missing timestamp from db");
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`[ApprovalQueue] invalid timestamp from db: ${text}`);
  }
  return date;
}

function parseOptionalTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return parseTimestamp(value);
}

function parseOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = toText(value);
  return text === "" ? null : text;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[ApprovalQueue] invalid ${label}: expected object`);
  }
  return value;
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (typeof record[field] !== "string") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string`,
    );
  }
}

function requireNullableStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string or null`,
    );
  }
}

function requireOptionalNullableStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) {
    return;
  }
  requireNullableStringField(record, field, label);
}

function requireStringArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string[]`,
    );
  }
}

function requireOptionalStringArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined || record[field] === null) return;
  requireStringArrayField(record, field, label);
}

function requireCalendarAttendees(
  value: unknown,
  label: string,
  nullable: boolean,
): void {
  if (nullable && value === null) return;
  if (!Array.isArray(value)) {
    throw new Error(`[ApprovalQueue] invalid ${label}: expected attendee[]`);
  }
  value.forEach((entry, index) => {
    if (typeof entry === "string") return;
    const attendee = requireRecord(entry, `${label}[${index}]`);
    requireStringField(attendee, "email", `${label}[${index}]`);
    requireOptionalNullableStringField(
      attendee,
      "displayName",
      `${label}[${index}]`,
    );
    if (
      attendee.optional !== undefined &&
      typeof attendee.optional !== "boolean"
    ) {
      throw new Error(
        `[ApprovalQueue] invalid ${label}[${index}].optional: expected boolean`,
      );
    }
  });
}

function requireFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected number`,
    );
  }
}

function requireNullableFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected number or null`,
    );
  }
}

function requireBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (typeof record[field] !== "boolean") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected boolean`,
    );
  }
}

function requireOptionalBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) return;
  requireBooleanField(record, field, label);
}

function requireOptionalNullableFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) return;
  requireNullableFiniteNumberField(record, field, label);
}

function requireOptionalEnumField(
  record: Record<string, unknown>,
  field: string,
  label: string,
  values: ReadonlySet<string>,
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !values.has(value)) {
    throw new Error(`[ApprovalQueue] invalid ${label}.${field}`);
  }
}

function requireOptionalSeriesMaster(
  record: Record<string, unknown>,
  label: string,
): void {
  if (record.seriesMaster === undefined || record.seriesMaster === null) return;
  const master = requireRecord(record.seriesMaster, `${label}.seriesMaster`);
  requireStringField(master, "externalId", `${label}.seriesMaster`);
  requireFiniteNumberField(master, "startAtMs", `${label}.seriesMaster`);
  requireStringField(master, "updatedAt", `${label}.seriesMaster`);
  requireStringField(master, "etag", `${label}.seriesMaster`);
}

function requireOptionalRecordField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected object or null`,
    );
  }
}

function requirePrimitiveRecordField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = requireRecord(record[field], `${label}.${field}`);
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new Error(
        `[ApprovalQueue] invalid ${label}.${field}.${key}: expected string, number, or boolean`,
      );
    }
  }
}

function requireTravelPassengers(
  record: Record<string, unknown>,
  label: string,
): void {
  const passengers = record.passengers;
  if (passengers === undefined) {
    return;
  }
  if (!Array.isArray(passengers)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.passengers: expected array`,
    );
  }
  passengers.forEach((passenger, index) => {
    const passengerRecord = requireRecord(
      passenger,
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "givenName",
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "familyName",
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "bornOn",
      `${label}.passengers[${index}]`,
    );
    for (const field of [
      "offerPassengerId",
      "email",
      "phoneNumber",
      "title",
      "gender",
    ]) {
      requireOptionalNullableStringField(
        passengerRecord,
        field,
        `${label}.passengers[${index}]`,
      );
    }
  });
}

function requireTravelCalendarSync(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.calendarSync;
  if (value === undefined || value === null) {
    return;
  }
  const calendarSync = requireRecord(value, `${label}.calendarSync`);
  requireBooleanField(calendarSync, "enabled", `${label}.calendarSync`);
  for (const field of [
    "calendarId",
    "title",
    "description",
    "location",
    "timeZone",
  ]) {
    requireOptionalNullableStringField(
      calendarSync,
      field,
      `${label}.calendarSync`,
    );
  }
}

function requireTravelCost(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.cost;
  if (value === undefined || value === null) {
    return;
  }
  const cost = requireRecord(value, `${label}.cost`);
  requireFiniteNumberField(cost, "totalUsd", `${label}.cost`);
  requireFiniteNumberField(cost, "creatorMarkupUsd", `${label}.cost`);
  requireFiniteNumberField(cost, "platformFeeUsd", `${label}.cost`);
  requireNullableFiniteNumberField(cost, "markupPercent", `${label}.cost`);
}

function requirePaymentRequired(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.paymentRequired;
  if (value === undefined || value === null) {
    return;
  }
  const payment = requireRecord(value, `${label}.paymentRequired`);
  for (const field of ["amount", "asset", "network", "payTo", "scheme"]) {
    requireStringField(payment, field, `${label}.paymentRequired`);
  }
  requireNullableStringField(payment, "expiresAt", `${label}.paymentRequired`);
  requireNullableStringField(
    payment,
    "description",
    `${label}.paymentRequired`,
  );
}

function assertApprovalPayload(
  record: Record<string, unknown>,
  action: ApprovalAction,
  label: string,
): asserts record is ApprovalPayload {
  switch (action) {
    case "send_message":
      if (record.familyPacketId !== undefined)
        requireStringField(record, "familyPacketId", label);
      requireStringField(record, "recipient", label);
      requireStringField(record, "body", label);
      requireNullableStringField(record, "replyToMessageId", label);
      break;
    case "send_email":
      if (record.grantId !== undefined)
        requireStringField(record, "grantId", label);
      if (record.familyPacketId !== undefined)
        requireStringField(record, "familyPacketId", label);
      requireStringArrayField(record, "to", label);
      requireStringArrayField(record, "cc", label);
      requireStringArrayField(record, "bcc", label);
      requireStringField(record, "subject", label);
      requireStringField(record, "body", label);
      requireNullableStringField(record, "threadId", label);
      requireOptionalNullableStringField(record, "replyToMessageId", label);
      break;
    case "schedule_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "title", label);
      requireFiniteNumberField(record, "startsAtMs", label);
      requireFiniteNumberField(record, "endsAtMs", label);
      requireCalendarAttendees(record.attendees, `${label}.attendees`, false);
      requireNullableStringField(record, "location", label);
      requireNullableStringField(record, "description", label);
      requireOptionalNullableStringField(record, "timeZone", label);
      requireOptionalNullableFiniteNumberField(
        record,
        "durationMinutes",
        label,
      );
      requireOptionalEnumField(
        record,
        "windowPreset",
        label,
        new Set(["tomorrow_morning", "tomorrow_afternoon", "tomorrow_evening"]),
      );
      requireOptionalStringArrayField(record, "recurrence", label);
      requireOptionalBooleanField(record, "notifyAttendees", label);
      requireOptionalNullableStringField(record, "grantId", label);
      requireOptionalEnumField(
        record,
        "side",
        label,
        new Set(["owner", "agent"]),
      );
      requireOptionalNullableStringField(record, "editorRequestSha256", label);
      break;
    case "modify_event": {
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      requireOptionalEnumField(
        record,
        "expectedProvider",
        label,
        new Set(["google", "microsoft", "apple_calendar", "ics", "eliza"]),
      );
      requireOptionalNullableStringField(
        record,
        "expectedProviderVersion",
        label,
      );
      requireOptionalNullableStringField(
        record,
        "expectedEventUpdatedAt",
        label,
      );
      requireOptionalNullableFiniteNumberField(
        record,
        "expectedEventStartAtMs",
        label,
      );
      requireOptionalSeriesMaster(record, label);
      requireOptionalEnumField(
        record,
        "recurrenceScope",
        label,
        new Set(["instance", "this_and_following", "series"]),
      );
      requireOptionalBooleanField(record, "notifyAttendees", label);
      requireOptionalNullableStringField(record, "grantId", label);
      requireOptionalEnumField(
        record,
        "side",
        label,
        new Set(["owner", "agent"]),
      );
      requireOptionalNullableStringField(record, "editorRequestSha256", label);
      const patch = requireRecord(record.patch, `${label}.patch`);
      requireNullableStringField(patch, "title", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "startsAtMs", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "endsAtMs", `${label}.patch`);
      requireCalendarAttendees(
        patch.attendees,
        `${label}.patch.attendees`,
        true,
      );
      requireNullableStringField(patch, "location", `${label}.patch`);
      requireNullableStringField(patch, "description", `${label}.patch`);
      requireOptionalNullableStringField(patch, "timeZone", `${label}.patch`);
      requireOptionalStringArrayField(patch, "recurrence", `${label}.patch`);
      break;
    }
    case "cancel_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      requireBooleanField(record, "notifyAttendees", label);
      requireOptionalEnumField(
        record,
        "expectedProvider",
        label,
        new Set(["google", "microsoft", "apple_calendar", "ics", "eliza"]),
      );
      requireOptionalNullableStringField(
        record,
        "expectedProviderVersion",
        label,
      );
      requireOptionalNullableStringField(
        record,
        "expectedEventUpdatedAt",
        label,
      );
      requireOptionalNullableFiniteNumberField(
        record,
        "expectedEventStartAtMs",
        label,
      );
      requireOptionalSeriesMaster(record, label);
      requireOptionalEnumField(
        record,
        "recurrenceScope",
        label,
        new Set(["instance", "this_and_following", "series"]),
      );
      requireOptionalEnumField(
        record,
        "cancellationMode",
        label,
        new Set([
          "organizer_cancel",
          "decline_invitation",
          "remove_private_copy",
        ]),
      );
      requireOptionalNullableStringField(record, "grantId", label);
      requireOptionalEnumField(
        record,
        "side",
        label,
        new Set(["owner", "agent"]),
      );
      requireOptionalNullableStringField(record, "editorRequestSha256", label);
      break;
    case "book_travel":
      if (
        record.kind !== "flight" &&
        record.kind !== "hotel" &&
        record.kind !== "ground"
      ) {
        throw new Error(`[ApprovalQueue] invalid ${label}.kind`);
      }
      requireStringField(record, "provider", label);
      requireStringField(record, "itineraryRef", label);
      requireFiniteNumberField(record, "totalCents", label);
      requireStringField(record, "currency", label);
      requireOptionalNullableStringField(record, "offerId", label);
      requireOptionalNullableStringField(record, "offerRequestId", label);
      if (
        record.orderType !== undefined &&
        record.orderType !== null &&
        record.orderType !== "hold" &&
        record.orderType !== "instant"
      ) {
        throw new Error(`[ApprovalQueue] invalid ${label}.orderType`);
      }
      requireOptionalRecordField(record, "search", label);
      requireTravelPassengers(record, label);
      requireTravelCalendarSync(record, label);
      requireOptionalNullableStringField(record, "summary", label);
      requireTravelCost(record, label);
      requirePaymentRequired(record, label);
      break;
    case "make_call":
      requireStringField(record, "to", label);
      requireStringField(record, "script", label);
      requireFiniteNumberField(record, "maxDurationSeconds", label);
      break;
    case "sign_document":
      requireStringField(record, "documentId", label);
      requireStringField(record, "documentName", label);
      requireStringField(record, "signatureUrl", label);
      requireStringField(record, "deadline", label);
      break;
    case "execute_workflow":
      requireStringField(record, "workflowId", label);
      requirePrimitiveRecordField(record, "input", label);
      break;
    case "spend_money":
      requireStringField(record, "vendor", label);
      requireFiniteNumberField(record, "amountCents", label);
      requireStringField(record, "currency", label);
      requireStringField(record, "memo", label);
      break;
  }
}

function validateApprovalPayload(
  value: unknown,
  label: string,
): ApprovalPayload {
  const record = requireRecord(value, label);
  const action = parseAction(record.action);
  assertApprovalPayload(record, action, label);
  return record;
}

function parseExecution(
  row: Record<string, unknown>,
): ApprovalExecution | null {
  const attemptId = parseOptionalText(row.execution_attempt_id);
  if (!attemptId) {
    return null;
  }
  const provider = parseOptionalText(row.execution_provider);
  const providerIdempotencyKey = parseOptionalText(
    row.provider_idempotency_key,
  );
  const claimedAt = parseOptionalTimestamp(row.execution_claimed_at);
  if (!provider || !providerIdempotencyKey || !claimedAt) {
    throw new Error(
      `[ApprovalQueue] incomplete execution metadata for request ${toText(row.id)}`,
    );
  }
  const receipt =
    row.provider_receipt === null || row.provider_receipt === undefined
      ? null
      : parseJsonRecord(row.provider_receipt);
  return {
    attemptId,
    provider,
    providerIdempotencyKey,
    claimedAt,
    dispatchStartedAt: parseOptionalTimestamp(row.dispatch_started_at),
    providerReceipt: receipt,
    error: parseOptionalText(row.execution_error),
    reconciledAt: parseOptionalTimestamp(row.reconciliation_resolved_at),
    reconciledBy: parseOptionalText(row.reconciliation_resolved_by),
    reconciliationReason: parseOptionalText(row.reconciliation_reason),
  };
}

function rowToRequest(row: Record<string, unknown>): ApprovalRequest {
  const action = parseAction(row.action);
  const payload = validateApprovalPayload(
    parseJsonRecord(row.payload),
    `row ${toText(row.id)} payload`,
  );
  if (payload.action !== action) {
    throw new Error(
      `[ApprovalQueue] row ${toText(row.id)} payload action ${payload.action} does not match request action ${action}`,
    );
  }
  return {
    id: toText(row.id),
    createdAt: parseTimestamp(row.created_at),
    updatedAt: parseTimestamp(row.updated_at),
    state: parseState(row.state),
    requestedBy: toText(row.requested_by),
    subjectUserId: toText(row.subject_user_id),
    action,
    payload,
    channel: parseChannel(row.channel),
    reason: toText(row.reason),
    idempotencyKey: parseOptionalText(row.idempotency_key),
    expiresAt: parseTimestamp(row.expires_at),
    resolvedAt: parseOptionalTimestamp(row.resolved_at),
    resolvedBy: parseOptionalText(row.resolved_by),
    resolutionReason: parseOptionalText(row.resolution_reason),
    execution: parseExecution(row),
  };
}

const SELECT_COLUMNS =
  "id, state, requested_by, subject_user_id, action, payload, channel, reason, idempotency_key, expires_at, resolved_at, resolved_by, resolution_reason, execution_attempt_id, execution_provider, provider_idempotency_key, execution_claimed_at, dispatch_started_at, provider_receipt, execution_error, reconciliation_resolved_at, reconciliation_resolved_by, reconciliation_reason, created_at, updated_at";

function sameIdempotentApproval(
  existing: ApprovalRequest,
  input: ApprovalEnqueueInput,
  payload: ApprovalPayload,
): boolean {
  return (
    existing.requestedBy === input.requestedBy &&
    existing.subjectUserId === input.subjectUserId &&
    existing.action === input.action &&
    existing.channel === input.channel &&
    existing.reason === input.reason &&
    existing.expiresAt.getTime() === input.expiresAt.getTime() &&
    stableStringify(existing.payload) === stableStringify(payload)
  );
}

function timestampLiteral(date: Date): string {
  return sqlText(date.toISOString());
}

interface NotificationEmitter {
  notify: (input: NotificationInput) => Promise<AgentNotification>;
  ensureGroupedNotification?: (
    input: NotificationInput & { groupKey: string },
    isExact: (notification: AgentNotification) => boolean,
  ) => Promise<AgentNotification>;
  /**
   * §C.5 acted-upon auto-read: mark the notification(s) for a groupKey read
   * without removing them. Optional — an older NotificationService may not
   * expose it, so callers guard on its presence.
   */
  markReadByGroupKey?: (groupKey: string) => Promise<number>;
}

function getNotifier(runtime: IAgentRuntime): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

/** The inbox groupKey an approval's notification is filed under. */
function approvalGroupKey(id: string): string {
  return `approval:${id}`;
}

type ApprovalNotificationInput = Parameters<NotificationEmitter["notify"]>[0];

function approvalNotificationInput(
  request: ApprovalRequest,
): ApprovalNotificationInput {
  return {
    title: "Approval needed",
    body: truncateWellFormed(toWellFormedUnicode(request.reason), 200),
    category: "approval",
    priority: "high",
    source: "lifeops",
    deepLink: "/chat",
    groupKey: approvalGroupKey(request.id),
    data: { requestId: request.id, kind: request.action },
  };
}

function hasExactApprovalProjection(
  notification: AgentNotification,
  expected: ApprovalNotificationInput,
): boolean {
  return (
    notification.title === expected.title &&
    notification.body === expected.body &&
    notification.category === expected.category &&
    notification.priority === expected.priority &&
    notification.source === expected.source &&
    notification.deepLink === expected.deepLink &&
    notification.icon === undefined &&
    notification.groupKey === expected.groupKey &&
    notification.readAt == null &&
    notification.expiresAt == null &&
    stableStringify(notification.data ?? {}) ===
      stableStringify(expected.data ?? {})
  );
}

function requireProjectionNotifier(
  runtime: IAgentRuntime,
): Required<Pick<NotificationEmitter, "ensureGroupedNotification">> {
  const notifier = getNotifier(runtime);
  if (!notifier || typeof notifier.ensureGroupedNotification !== "function") {
    throw new Error(
      "[ApprovalQueue] notification service unavailable for awaited approval projection",
    );
  }
  return notifier as Required<
    Pick<NotificationEmitter, "ensureGroupedNotification">
  >;
}

async function ensureApprovalNotification(
  notifier: Required<Pick<NotificationEmitter, "ensureGroupedNotification">>,
  request: ApprovalRequest,
): Promise<void> {
  const expected = approvalNotificationInput(request);
  if (!expected.groupKey) {
    throw new Error("[ApprovalQueue] approval projection group is missing");
  }
  await notifier.ensureGroupedNotification(
    { ...expected, groupKey: expected.groupKey },
    (notification) => hasExactApprovalProjection(notification, expected),
  );
}

/**
 * §C.5 acted-upon auto-read: once an approval is resolved (approved/rejected/
 * expired), the "Approval needed" notification that pointed at it is a done
 * thing — mark it read so the inbox stops nagging. Fire-and-forget: a notifier
 * that predates this method, or a failed write, must never fail the resolve.
 */
function markApprovalNotificationRead(
  runtime: IAgentRuntime,
  id: string,
): void {
  const notifier = getNotifier(runtime);
  if (!notifier?.markReadByGroupKey) return;
  // error-policy:J7 Notification projection must not fail the durable approval
  // transition, but the diagnostic channel records every projection failure.
  void notifier.markReadByGroupKey(approvalGroupKey(id)).catch((error) => {
    // error-policy:J7 notification cleanup is diagnostic side-channel work;
    // the queue transition already committed, so report without undoing it.
    logger.warn(
      { error, id },
      "[ApprovalQueue] failed to auto-read resolved approval notification",
    );
    runtime.reportError("ApprovalQueue.notificationRead", error, {
      requestId: id,
    });
  });
}

export class PgApprovalQueue implements ApprovalQueue {
  readonly capability = APPROVAL_EXECUTION_CAPABILITY;
  readonly protocolVersion = APPROVAL_EXECUTION_PROTOCOL_VERSION;
  private readonly runtime: IAgentRuntime;
  private readonly agentId: string;

  constructor(runtime: IAgentRuntime, options: ApprovalQueueOptions) {
    this.runtime = runtime;
    this.agentId = options.agentId;
  }

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    return (await this.enqueueWithResult(input)).request;
  }

  async enqueueWithResult(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult> {
    return this.enqueueWithNotificationMode(input, false);
  }

  async enqueueWithResultAndNotification(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult> {
    return this.enqueueWithNotificationMode(input, true);
  }

  private async enqueueWithNotificationMode(
    input: ApprovalEnqueueInput,
    awaitNotification: boolean,
  ): Promise<ApprovalEnqueueResult> {
    const projectionNotifier = awaitNotification
      ? requireProjectionNotifier(this.runtime)
      : null;
    const inserted = await this.insertApproval(input);
    if (inserted.reused) {
      if (projectionNotifier) {
        await ensureApprovalNotification(projectionNotifier, inserted.request);
      }
      return inserted;
    }
    const { request } = inserted;
    logger.info(
      `[ApprovalQueue] enqueued ${input.action} for ${input.subjectUserId} as ${request.id}`,
    );
    // An outbound action now needs the owner's go-ahead. Ordinary callers keep
    // this side-channel non-blocking, while exact import/seed callers await it
    // so their receipt boundary owns every durable projection.
    if (projectionNotifier) {
      await ensureApprovalNotification(projectionNotifier, request);
      return inserted;
    }
    const notifier = getNotifier(this.runtime);
    if (notifier) {
      const notificationWrite = notifier.notify(
        approvalNotificationInput(request),
      );
      void notificationWrite.catch((error) => {
        // error-policy:J7 owner notification is a non-blocking side-channel,
        // but a failed rail must remain visible to diagnostics.
        logger.warn(
          { error, id: request.id, action: input.action },
          "[ApprovalQueue] failed to notify owner about pending approval",
        );
        this.runtime.reportError("ApprovalQueue.notify", error, {
          requestId: request.id,
          action: input.action,
        });
      });
    }
    return inserted;
  }

  async enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    const inserted = await this.insertApproval(input, undefined, resolution);
    if (inserted.request.state === "pending") {
      try {
        return await this.approve(
          inserted.request.id,
          inserted.request.subjectUserId,
          resolution,
        );
      } catch (error) {
        if (!(error instanceof ApprovalStateTransitionError)) throw error;
        const current = await this.byId(
          inserted.request.id,
          inserted.request.subjectUserId,
        );
        if (!current) throw new ApprovalNotFoundError(inserted.request.id);
        if (
          current.state === "approved" ||
          current.state === "executing" ||
          current.state === "done"
        ) {
          return current;
        }
        throw error;
      }
    }
    return inserted.request;
  }

  /**
   * Insert or reuse an approval inside the caller's transaction. This is the
   * same `approval_requests` queue, not an auxiliary one; it lets a domain
   * mutation and its owner gate commit or roll back together. Owner-facing
   * side channels (task, chat choice, notification) belong after the commit
   * and are therefore the caller's responsibility on this path.
   */
  async enqueueTransactional(
    input: ApprovalEnqueueInput,
    tx: TransactionalDb,
  ): Promise<ApprovalEnqueueResult> {
    return this.insertApproval(input, tx);
  }

  private async insertApproval(
    input: ApprovalEnqueueInput,
    tx?: TransactionalDb,
    confirmedResolution?: ApprovalResolution,
  ): Promise<ApprovalEnqueueResult> {
    const payload = validateApprovalPayload(input.payload, "enqueue payload");
    if (input.action !== payload.action) {
      throw new Error(
        `[ApprovalQueue] payload action ${payload.action} does not match request action ${input.action}`,
      );
    }
    const id = randomUUID();
    const now = new Date();
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const initialState = confirmedResolution ? "approved" : "pending";
    const sql = `${approvalDispatchAdmissionCte(this.agentId, input.subjectUserId)} INSERT INTO approval_requests (
        id, state, requested_by, subject_user_id, action, payload, channel, reason,
        idempotency_key, expires_at, resolved_at, resolved_by, resolution_reason,
        execution_attempt_id, execution_provider, provider_idempotency_key,
        execution_claimed_at, dispatch_started_at, provider_receipt,
        execution_error, reconciliation_resolved_at, reconciliation_resolved_by,
        reconciliation_reason,
        agent_id, created_at, updated_at, admission_revision
      ) SELECT
        ${sqlText(id)},
        ${sqlText(initialState)},
        ${sqlText(input.requestedBy)},
        ${sqlText(input.subjectUserId)},
        ${sqlText(input.action)},
        ${sqlJson(payload)},
        ${sqlText(input.channel)},
        ${sqlText(input.reason)},
        ${sqlText(idempotencyKey)},
        ${timestampLiteral(input.expiresAt)},
        ${confirmedResolution ? timestampLiteral(now) : "NULL"},
        ${confirmedResolution ? sqlText(confirmedResolution.resolvedBy) : "NULL"},
        ${confirmedResolution ? sqlText(confirmedResolution.resolutionReason) : "NULL"},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ${sqlText(this.agentId)},
        ${timestampLiteral(now)},
        ${timestampLiteral(now)}, revision
      FROM approval_admission
      WHERE ${approvalAccountAdmissionSql(`${sqlJson(payload)}::jsonb`, "revision")}
      ${
        idempotencyKey
          ? "ON CONFLICT (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING"
          : ""
      }
      RETURNING ${SELECT_COLUMNS}`;
    const rows = tx
      ? await executeRawSqlTx(tx, sql)
      : await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      if (!idempotencyKey) {
        throw new ElizaError(
          "Select and review an active sender account before creating this approval",
          {
            code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED",
          },
        );
      }
      const existing = await this.fetchByIdempotencyKey(idempotencyKey, tx);
      if (!existing) {
        throw new ElizaError(
          "Select and review an active sender account before creating this approval",
          {
            code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED",
          },
        );
      }
      if (!sameIdempotentApproval(existing, input, payload)) {
        throw new ApprovalIdempotencyConflictError(idempotencyKey);
      }
      return { request: existing, reused: true };
    }
    return { request: rowToRequest(rows[0]), reused: false };
  }

  async list(
    filter: ApprovalListFilter,
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    const where: string[] = [`agent_id = ${sqlText(this.agentId)}`];
    if (filter.subjectUserId !== null) {
      where.push(`subject_user_id = ${sqlText(filter.subjectUserId)}`);
    }
    if (filter.state !== null) {
      where.push(`state = ${sqlText(filter.state)}`);
    }
    if (filter.action !== null) {
      where.push(`action = ${sqlText(filter.action)}`);
    }
    const limitClause =
      typeof filter.limit === "number"
        ? `LIMIT ${sqlInteger(filter.limit)}`
        : "";
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      ${limitClause}`;
    const rows = await executeRawSql(this.runtime, sql);
    return rows.map(rowToRequest);
  }

  async byId(
    id: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    const rows = await this.fetchById(id, subjectUserId);
    return rows ?? null;
  }

  /**
   * Subject-fenced replay lookup. The key is unique per agent, so the subject
   * predicate is what stops one owner's key guess from reading another's
   * request; a key held by a different subject reads as absent.
   */
  async byIdempotencyKey(
    idempotencyKey: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    const normalized = idempotencyKey.trim();
    if (!normalized) {
      throw new Error("[ApprovalQueue] idempotency key is required");
    }
    const existing = await this.fetchByIdempotencyKey(normalized);
    return existing?.subjectUserId === subjectUserId ? existing : null;
  }

  async approve(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.transitionWithResolution(
      id,
      subjectUserId,
      "approved",
      resolution,
    );
  }

  async reject(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.transitionWithResolution(
      id,
      subjectUserId,
      "rejected",
      resolution,
    );
  }

  async markExpired(
    id: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest> {
    return this.transitionWithoutResolution(id, subjectUserId, "expired");
  }

  async removePending(id: string, subjectUserId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM approval_requests
       WHERE id = ${sqlText(id)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(subjectUserId)}
         AND state = ${sqlText("pending")}`,
    );
  }

  async claimExecution(
    claim: ApprovalExecutionClaim,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(claim.requestId, claim.subjectUserId);
    if (!current) throw new ApprovalNotFoundError(claim.requestId);
    assertTransition(claim.requestId, current.state, "executing");
    const attemptId = randomUUID();
    const now = new Date();
    const sql = `${approvalDispatchAdmissionCte(this.agentId, claim.subjectUserId, claim.requestId)}
      UPDATE approval_requests
      SET state = ${sqlText("executing")},
          execution_attempt_id = ${sqlText(attemptId)},
          execution_provider = ${sqlText(claim.provider)},
          provider_idempotency_key = ${sqlText(claim.providerIdempotencyKey)},
          execution_claimed_at = ${timestampLiteral(now)},
          dispatch_started_at = NULL,
          provider_receipt = NULL,
          execution_error = NULL,
          reconciliation_resolved_at = NULL,
          reconciliation_resolved_by = NULL,
          reconciliation_reason = NULL,
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(claim.requestId)}
        AND agent_id = ${sqlText(this.agentId)}
        AND subject_user_id = ${sqlText(claim.subjectUserId)}
        AND state = ${sqlText(current.state)}
        AND EXISTS (SELECT 1 FROM approval_permission WHERE NOT paused AND permitted)
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      const control = await new ApprovalDispatchControlStore(
        this.runtime,
        this.agentId,
      ).read(claim.subjectUserId);
      if (control.paused) {
        throw new ElizaError(
          "Dispatch is paused for account handoff; finish or cancel the handoff before sending",
          {
            code: "APPROVAL_DISPATCH_PAUSED",
            context: {
              subjectUserId: claim.subjectUserId,
              operationId: control.operationId,
            },
          },
        );
      }
      const permission = await executeRawSql(
        this.runtime,
        `${approvalDispatchAdmissionCte(this.agentId, claim.subjectUserId, claim.requestId)} SELECT permitted FROM approval_permission`,
      );
      if (permission[0]?.permitted === false)
        throw new ElizaError(
          "This approval predates account handoff. Review a new approval with an explicit sender account.",
          { code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED" },
        );
      return this.throwLostRace(
        claim.requestId,
        claim.subjectUserId,
        "executing",
      );
    }
    logger.info(
      `[ApprovalQueue] ${current.state} -> executing (${claim.requestId}, attempt ${attemptId})`,
    );
    return rowToRequest(rows[0]);
  }

  async markDispatchStarted(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest> {
    const now = new Date();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_requests
       SET dispatch_started_at = ${timestampLiteral(now)},
           updated_at = ${timestampLiteral(now)}
       WHERE id = ${sqlText(mutation.requestId)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(mutation.subjectUserId)}
         AND state = ${sqlText("executing")}
         AND execution_attempt_id = ${sqlText(mutation.attemptId)}
         AND dispatch_started_at IS NULL
       RETURNING ${SELECT_COLUMNS}`,
    );
    if (rows.length === 0) {
      return this.throwExecutionMutationConflict(mutation, "executing");
    }
    return rowToRequest(rows[0]);
  }

  async markDone(
    completion: ApprovalExecutionCompletion,
  ): Promise<ApprovalRequest> {
    const now = new Date();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_requests
       SET state = ${sqlText("done")},
           provider_receipt = ${sqlJson(completion.providerReceipt)},
           execution_error = NULL,
           updated_at = ${timestampLiteral(now)}
       WHERE id = ${sqlText(completion.requestId)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(completion.subjectUserId)}
         AND state = ${sqlText("executing")}
         AND execution_attempt_id = ${sqlText(completion.attemptId)}
         AND dispatch_started_at IS NOT NULL
       RETURNING ${SELECT_COLUMNS}`,
    );
    if (rows.length === 0) {
      return this.throwExecutionMutationConflict(completion, "done");
    }
    return rowToRequest(rows[0]);
  }

  async markRetryableFailure(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest> {
    return this.finishFailedAttempt(failure, "retryable");
  }

  async markReconciliationRequired(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest> {
    return this.finishFailedAttempt(failure, "reconciliation_required");
  }

  async recoverUnstartedExecution(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest> {
    const now = new Date();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_requests
       SET state = ${sqlText("retryable")},
           execution_error = ${sqlText("execution claim recovered before dispatch start")},
           updated_at = ${timestampLiteral(now)}
       WHERE id = ${sqlText(mutation.requestId)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(mutation.subjectUserId)}
         AND state = ${sqlText("executing")}
         AND execution_attempt_id = ${sqlText(mutation.attemptId)}
         AND dispatch_started_at IS NULL
       RETURNING ${SELECT_COLUMNS}`,
    );
    if (rows.length === 0) {
      return this.throwExecutionMutationConflict(mutation, "retryable");
    }
    return rowToRequest(rows[0]);
  }

  async reconcileExecution(
    reconciliation: ApprovalExecutionReconciliation,
  ): Promise<ApprovalRequest> {
    const target =
      reconciliation.outcome === "delivered" ? "done" : "retryable";
    const now = new Date();
    const receipt =
      reconciliation.providerReceipt === undefined
        ? "provider_receipt"
        : sqlJson(reconciliation.providerReceipt);
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_requests
       SET state = ${sqlText(target)},
           provider_receipt = ${receipt},
           execution_error = ${
             target === "retryable"
               ? sqlText("provider reconciliation confirmed non-delivery")
               : "NULL"
},
           reconciliation_resolved_at = ${timestampLiteral(now)},
           reconciliation_resolved_by = ${sqlText(reconciliation.reconciledBy)},
           reconciliation_reason = ${sqlText(reconciliation.reconciliationReason)},
           updated_at = ${timestampLiteral(now)}
       WHERE id = ${sqlText(reconciliation.requestId)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(reconciliation.subjectUserId)}
         AND state = ${sqlText("reconciliation_required")}
         AND execution_attempt_id = ${sqlText(reconciliation.attemptId)}
       RETURNING ${SELECT_COLUMNS}`,
    );
    if (rows.length === 0) {
      return this.throwExecutionMutationConflict(reconciliation, target);
    }
    return rowToRequest(rows[0]);
  }

  async purgeExpired(now: Date): Promise<ReadonlyArray<string>> {
    const sql = `UPDATE approval_requests
      SET state = ${sqlText("expired")}, updated_at = ${timestampLiteral(now)}
      WHERE agent_id = ${sqlText(this.agentId)}
        AND state = ${sqlText("pending")}
        AND expires_at <= ${timestampLiteral(now)}
      RETURNING id`;
    const rows = await executeRawSql(this.runtime, sql);
    const ids = rows.map((row) => toText(row.id));
    if (ids.length > 0) {
      logger.info(`[ApprovalQueue] purged ${ids.length} expired requests`);
      for (const id of ids) {
        markApprovalNotificationRead(this.runtime, id);
      }
    }
    return ids;
  }

  protected async fetchById(
    id: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE id = ${sqlText(id)}
        AND agent_id = ${sqlText(this.agentId)}
        AND subject_user_id = ${sqlText(subjectUserId)}
      LIMIT 1`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]);
  }

  /**
   * Agent-scoped, deliberately not subject-scoped: the unique constraint the
   * idempotent insert races against spans `(agent_id, idempotency_key)`, so a
   * key claimed by another subject must surface as an
   * `ApprovalIdempotencyConflictError` rather than as a missing row.
   */
  private async fetchByIdempotencyKey(
    idempotencyKey: string,
    tx?: TransactionalDb,
  ): Promise<ApprovalRequest | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE idempotency_key = ${sqlText(idempotencyKey)}
        AND agent_id = ${sqlText(this.agentId)}
      LIMIT 1`;
    const rows = tx
      ? await executeRawSqlTx(tx, sql)
      : await executeRawSql(this.runtime, sql);
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]);
  }

  /**
   * Lazily enforce expiry at the transition boundary (#11092): no production
   * caller runs purgeExpired periodically, so without this check a request
   * whose expiresAt has passed stays `pending` forever and remains approvable.
   * A lapsed pending row is flipped to `expired` (CAS — a concurrent
   * transition wins cleanly) and the attempted transition is refused as
   * from-expired, the same typed error callers already handle.
   */
  private async refuseLapsedPending(
    current: ApprovalRequest,
    target: ApprovalRequestState,
  ): Promise<void> {
    if (current.state !== "pending" || target === "expired") return;
    if (current.expiresAt.getTime() > Date.now()) return;
    await this.transitionWithoutResolution(
      current.id,
      current.subjectUserId,
      "expired",
    );
    throw new ApprovalStateTransitionError(current.id, "expired", target);
  }

  private async transitionWithResolution(
    id: string,
    subjectUserId: string,
    target: ApprovalRequestState,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(id, subjectUserId);
    if (!current) throw new ApprovalNotFoundError(id);
    await this.refuseLapsedPending(current, target);
    assertTransition(id, current.state, target);
    const now = new Date();
    // Compare-and-swap on the observed state: without the `AND state =`
    // guard an in-flight concurrent transition (e.g. the atomic
    // purgeExpired flipping pending → expired) was silently overwritten,
    // resurrecting an expired request into `approved`.
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          resolved_at = ${timestampLiteral(now)},
          resolved_by = ${sqlText(resolution.resolvedBy)},
          resolution_reason = ${sqlText(resolution.resolutionReason)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
        AND subject_user_id = ${sqlText(subjectUserId)}
        AND state = ${sqlText(current.state)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      return this.throwLostRace(id, subjectUserId, target);
    }
    logger.info(
      `[ApprovalQueue] ${current.state} -> ${target} (${id}) by ${resolution.resolvedBy}`,
    );
    // §C.5: the approval is now resolved — the owner acted, so auto-read the
    // "Approval needed" notification (fire-and-forget; never blocks resolve).
    markApprovalNotificationRead(this.runtime, id);
    return rowToRequest(rows[0]);
  }

  private async transitionWithoutResolution(
    id: string,
    subjectUserId: string,
    target: ApprovalRequestState,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(id, subjectUserId);
    if (!current) throw new ApprovalNotFoundError(id);
    await this.refuseLapsedPending(current, target);
    assertTransition(id, current.state, target);
    const now = new Date();
    // Compare-and-swap on the observed state — see transitionWithResolution.
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
        AND subject_user_id = ${sqlText(subjectUserId)}
        AND state = ${sqlText(current.state)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      return this.throwLostRace(id, subjectUserId, target);
    }
    logger.info(`[ApprovalQueue] ${current.state} -> ${target} (${id})`);
    if (target === "expired") {
      // Terminal expiry also resolves the thing the notification pointed at;
      // auto-read so a dead approval cannot keep nagging (§C.5).
      markApprovalNotificationRead(this.runtime, id);
    }
    return rowToRequest(rows[0]);
  }

  private async finishFailedAttempt(
    failure: ApprovalExecutionFailure,
    target: "retryable" | "reconciliation_required",
  ): Promise<ApprovalRequest> {
    const now = new Date();
    const receipt =
      failure.providerReceipt === undefined
        ? "provider_receipt"
        : sqlJson(failure.providerReceipt);
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE approval_requests
       SET state = ${sqlText(target)},
           execution_error = ${sqlText(failure.error)},
           provider_receipt = ${receipt},
           updated_at = ${timestampLiteral(now)}
       WHERE id = ${sqlText(failure.requestId)}
         AND agent_id = ${sqlText(this.agentId)}
         AND subject_user_id = ${sqlText(failure.subjectUserId)}
         AND state = ${sqlText("executing")}
         AND execution_attempt_id = ${sqlText(failure.attemptId)}
         AND dispatch_started_at IS NOT NULL
       RETURNING ${SELECT_COLUMNS}`,
    );
    if (rows.length === 0) {
      return this.throwExecutionMutationConflict(failure, target);
    }
    return rowToRequest(rows[0]);
  }

  private async throwExecutionMutationConflict(
    mutation: ApprovalExecutionMutation,
    target: ApprovalRequestState,
  ): Promise<never> {
    const latest = await this.fetchById(
      mutation.requestId,
      mutation.subjectUserId,
    );
    if (!latest) throw new ApprovalNotFoundError(mutation.requestId);
    logger.warn(
      `[ApprovalQueue] execution mutation conflict for ${mutation.requestId} attempt ${mutation.attemptId}`,
    );
    throw new ApprovalStateTransitionError(
      mutation.requestId,
      latest.state,
      target,
    );
  }

  /**
   * The CAS matched zero rows: either the row vanished or a concurrent
   * transition moved it first. Re-read and surface the loss as the same
   * typed errors callers already handle — a validated-then-lost race is an
   * invalid transition FROM the row's new state.
   */
  private async throwLostRace(
    id: string,
    subjectUserId: string,
    target: ApprovalRequestState,
  ): Promise<never> {
    const latest = await this.fetchById(id, subjectUserId);
    if (!latest) throw new ApprovalNotFoundError(id);
    logger.warn(
      `[ApprovalQueue] lost transition race: ${id} moved to ${latest.state} before -> ${target} committed`,
    );
    throw new ApprovalStateTransitionError(id, latest.state, target);
  }
}

export function createApprovalQueue(
  runtime: IAgentRuntime,
  options: ApprovalQueueOptions,
): ApprovalQueue {
  return new PgApprovalQueue(runtime, options);
}
