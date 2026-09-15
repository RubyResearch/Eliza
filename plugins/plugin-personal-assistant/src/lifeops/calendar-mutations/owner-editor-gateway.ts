/**
 * Authenticated calendar-editor writes are converted into immutable,
 * pre-approved owner requests and executed through the same durable mutation
 * ledger as conversational approvals. A repeated HTTP operation key replays
 * the persisted receipt and never sends a second provider mutation.
 */
import { createHash } from "node:crypto";
import { type IAgentRuntime, Service, stableStringify } from "@elizaos/core";
import {
  CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
  type CalendarOwnerMutationGateway,
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import { resolveCalendarEventRange } from "@elizaos/plugin-calendar/internal/calendar-normalize";
import type {
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventCancellationResult,
} from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalPayload,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalResolution,
  CalendarSeriesMasterBinding,
} from "../approval-queue.types.js";
import { executeCalendarMutationApproval } from "./execution.js";
import { createLifeOpsCalendarMutationPort } from "./lifeops-port.js";
import type {
  CalendarMutationExecutionResult,
  CalendarMutationPort,
} from "./types.js";

type CalendarEditorPayload = Extract<
  ApprovalPayload,
  { action: "schedule_event" | "modify_event" | "cancel_event" }
>;

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

export interface OwnerCalendarMutationGatewayDeps {
  readonly calendar?: Pick<
    CalendarService,
    | "getConditionalCalendarMutationTarget"
    | "executeLinkedCalendarControl"
    | "executeLinkedCalendarLink"
    | "executeLinkedCalendarReconciliation"
    | "executeLinkedCalendarConflictResolution"
    | "executeLinkedCalendarDisconnect"
    | "executeLinkedCalendarRebind"
    | "executeLinkedCalendarProviderChanges"
  >;
  readonly port?: CalendarMutationPort;
  readonly approvalQueue?: ApprovalQueue;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function requireOperationKey(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 512) {
    throw new CalendarServiceError(
      428,
      "Calendar editor writes require a stable idempotencyKey of at most 512 characters.",
      "CALENDAR_EDITOR_IDEMPOTENCY_REQUIRED",
    );
  }
  return normalized;
}

function approvalKey(operation: string, operationKey: string): string {
  return `calendar-editor:v1:${operation}:${sha256(operationKey)}`;
}

function isApprovalIdempotencyConflict(
  error: unknown,
  idempotencyKey: string,
): boolean {
  return (
    error instanceof Error &&
    error.name === "ApprovalIdempotencyConflictError" &&
    "idempotencyKey" in error &&
    error.idempotencyKey === idempotencyKey
  );
}

function requireAbsoluteTimestamp(
  value: string | undefined,
  field: string,
): number {
  const timestamp =
    value && ABSOLUTE_RFC3339.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new CalendarServiceError(
      400,
      `${field} must be an RFC 3339 date-time with Z or an explicit UTC offset.`,
      "CALENDAR_EDITOR_TIMESTAMP_INVALID",
    );
  }
  return timestamp;
}

function resolveEditorCreateRange(
  request: CreateLifeOpsCalendarEventRequest,
): ReturnType<typeof resolveCalendarEventRange> {
  if (request.startAt !== undefined) {
    requireAbsoluteTimestamp(request.startAt, "startAt");
  }
  if (request.endAt !== undefined) {
    requireAbsoluteTimestamp(request.endAt, "endAt");
  }
  return resolveCalendarEventRange(request, new Date());
}

function providerVersion(event: LifeOpsCalendarEvent): string {
  const etag = event.metadata.etag;
  if (typeof etag !== "string" || !etag.trim()) {
    throw new CalendarServiceError(
      409,
      "The calendar provider did not return the ETag required for an atomic editor write.",
      "CALENDAR_PROVIDER_VERSION_MISSING",
    );
  }
  return etag.trim();
}

type EditorMutationRequest =
  | Parameters<CalendarOwnerMutationGateway["update"]>[1]
  | Parameters<CalendarOwnerMutationGateway["cancel"]>[1];

interface EditorMutationTargets {
  readonly visible: LifeOpsCalendarEvent;
  readonly seriesMaster: LifeOpsCalendarEvent | null;
}

async function resolveEditorMutationTargets(
  calendar: Pick<CalendarService, "getConditionalCalendarMutationTarget">,
  requestUrl: URL,
  request: EditorMutationRequest,
): Promise<EditorMutationTargets> {
  const targetRequest = {
    side: request.side ?? "owner",
    grantId: request.grantId,
    calendarId: request.calendarId,
    eventId: request.eventId,
  };
  const visible = await calendar.getConditionalCalendarMutationTarget(
    requestUrl,
    {
      ...targetRequest,
      recurrenceScope:
        request.recurrenceScope === "series" ||
        request.recurrenceScope === "this_and_following"
          ? "instance"
          : request.recurrenceScope,
    },
  );
  requireMatchingProviderVersion(visible, request.expectedProviderVersion);
  if (
    request.recurrenceScope !== "series" &&
    request.recurrenceScope !== "this_and_following"
  ) {
    return { visible, seriesMaster: null };
  }
  const seriesMaster = await calendar.getConditionalCalendarMutationTarget(
    requestUrl,
    {
      ...targetRequest,
      recurrenceScope: "series",
    },
  );
  if (
    seriesMaster.provider !== visible.provider ||
    seriesMaster.grantId !== visible.grantId ||
    seriesMaster.calendarId !== visible.calendarId
  ) {
    throw new CalendarServiceError(
      409,
      "The recurring-series master no longer belongs to the visible occurrence source.",
      "CALENDAR_MUTATION_TARGET_CHANGED",
    );
  }
  const visibleMasterId =
    typeof visible.recurringEventId === "string"
      ? visible.recurringEventId
      : typeof visible.metadata.recurringEventId === "string"
        ? visible.metadata.recurringEventId
        : null;
  if (visibleMasterId && visibleMasterId !== seriesMaster.externalId) {
    throw new CalendarServiceError(
      409,
      "The visible occurrence now belongs to a different recurring-series master.",
      "CALENDAR_MUTATION_TARGET_CHANGED",
    );
  }
  return { visible, seriesMaster };
}

function seriesMasterBinding(
  event: LifeOpsCalendarEvent | null,
): CalendarSeriesMasterBinding | null {
  if (!event) return null;
  const startAtMs = requireAbsoluteTimestamp(
    event.startAt,
    "seriesMaster.startAt",
  );
  requireAbsoluteTimestamp(event.updatedAt, "seriesMaster.updatedAt");
  return {
    externalId: event.externalId,
    startAtMs,
    updatedAt: new Date(event.updatedAt).toISOString(),
    etag: providerVersion(event),
  };
}

function requireMatchingProviderVersion(
  event: LifeOpsCalendarEvent,
  expected: string,
): void {
  if (providerVersion(event) !== expected.trim()) {
    throw new CalendarServiceError(
      412,
      "The calendar event changed after the editor loaded it. Refresh before saving.",
      "PROVIDER_PRECONDITION_FAILED",
    );
  }
}

function assertEditorApproval(
  request: ApprovalRequest,
  action: CalendarEditorPayload["action"],
  requestSha256: string,
): void {
  const payload = request.payload;
  if (
    request.action !== action ||
    payload.action !== action ||
    payload.editorRequestSha256 !== requestSha256
  ) {
    throw new CalendarServiceError(
      409,
      "The idempotencyKey is already bound to a different calendar editor request.",
      "CALENDAR_EDITOR_IDEMPOTENCY_CONFLICT",
    );
  }
  if (request.state === "rejected" || request.state === "expired") {
    throw new CalendarServiceError(
      409,
      `The bound calendar editor request is ${request.state} and cannot be replayed.`,
      "CALENDAR_EDITOR_APPROVAL_TERMINAL",
    );
  }
}

async function resolveConfirmedApproval(args: {
  queue: ApprovalQueue;
  action: CalendarEditorPayload["action"];
  payload: CalendarEditorPayload;
  reason: string;
  operationKey: string;
  requestSha256: string;
}): Promise<ApprovalRequest> {
  const idempotencyKey = approvalKey(args.action, args.operationKey);
  const input: ApprovalEnqueueInput = {
    requestedBy: "OWNER_CALENDAR_EDITOR",
    subjectUserId: SELF_ENTITY_ID,
    action: args.action,
    payload: args.payload,
    channel: "internal",
    reason: args.reason,
    idempotencyKey,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
  };
  const resolution: ApprovalResolution = {
    resolvedBy: SELF_ENTITY_ID,
    resolutionReason:
      "Authenticated owner explicitly confirmed the calendar editor action.",
  };
  const existing = await args.queue.byIdempotencyKey(
    idempotencyKey,
    SELF_ENTITY_ID,
  );
  if (existing) {
    return confirmExistingEditorApproval({
      queue: args.queue,
      existing,
      action: args.action,
      requestSha256: args.requestSha256,
      resolution,
    });
  }
  try {
    const request = await args.queue.enqueueConfirmed(input, resolution);
    assertEditorApproval(request, args.action, args.requestSha256);
    return request;
  } catch (error) {
    if (!isApprovalIdempotencyConflict(error, idempotencyKey)) throw error;
    const raced = await args.queue.byIdempotencyKey(
      idempotencyKey,
      SELF_ENTITY_ID,
    );
    if (!raced) throw error;
    return confirmExistingEditorApproval({
      queue: args.queue,
      existing: raced,
      action: args.action,
      requestSha256: args.requestSha256,
      resolution,
    });
  }
}

async function confirmExistingEditorApproval(args: {
  readonly queue: ApprovalQueue;
  readonly existing: ApprovalRequest;
  readonly action: CalendarEditorPayload["action"];
  readonly requestSha256: string;
  readonly resolution?: ApprovalResolution;
}): Promise<ApprovalRequest> {
  assertEditorApproval(args.existing, args.action, args.requestSha256);
  if (args.existing.state !== "pending") return args.existing;
  return args.queue.enqueueConfirmed(
    {
      requestedBy: args.existing.requestedBy,
      subjectUserId: args.existing.subjectUserId,
      action: args.existing.action,
      payload: args.existing.payload,
      channel: args.existing.channel,
      reason: args.existing.reason,
      idempotencyKey: args.existing.idempotencyKey,
      expiresAt: args.existing.expiresAt,
    },
    args.resolution ?? {
      resolvedBy: SELF_ENTITY_ID,
      resolutionReason:
        "Authenticated owner explicitly confirmed the calendar editor action.",
    },
  );
}

function requireReceiptEvent(
  result: Extract<CalendarMutationExecutionResult, { kind: "succeeded" }>,
): LifeOpsCalendarEvent {
  const event = result.receipt.eventSnapshot;
  if (!event) {
    throw new CalendarServiceError(
      500,
      "The durable provider receipt does not contain its readable event snapshot.",
      "CALENDAR_MUTATION_EVENT_SNAPSHOT_UNAVAILABLE",
    );
  }
  return event;
}

function throwExecutionFailure(result: CalendarMutationExecutionResult): never {
  if (result.kind === "succeeded") {
    throw new CalendarServiceError(
      500,
      "A successful calendar mutation reached the failure boundary.",
      "CALENDAR_MUTATION_RESULT_INVALID",
    );
  }
  if (result.kind === "blocked") {
    throw new CalendarServiceError(
      409,
      result.reason === "ambiguous"
        ? "The provider outcome is unknown. Automatic retry is disabled until the calendar is reconciled."
        : "The same calendar mutation is already executing.",
      result.reason === "ambiguous"
        ? "CALENDAR_MUTATION_OUTCOME_AMBIGUOUS"
        : "CALENDAR_MUTATION_IN_FLIGHT",
    );
  }
  throw new CalendarServiceError(
    result.kind === "retryable" ? 503 : 409,
    result.failure.message,
    result.failure.code,
  );
}

export class OwnerCalendarMutationGatewayService
  extends Service
  implements CalendarOwnerMutationGateway
{
  static override serviceType = CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE;
  capabilityDescription =
    "Authenticated owner calendar writes with immutable approvals, conditional provider mutations, and durable replay receipts.";

  constructor(
    runtime?: IAgentRuntime,
    private readonly deps: OwnerCalendarMutationGatewayDeps = {},
  ) {
    super(runtime);
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<OwnerCalendarMutationGatewayService> {
    return new OwnerCalendarMutationGatewayService(runtime);
  }

  override async stop(): Promise<void> {}

  private calendar(): Pick<
    CalendarService,
    | "getConditionalCalendarMutationTarget"
    | "executeLinkedCalendarControl"
    | "executeLinkedCalendarLink"
    | "executeLinkedCalendarReconciliation"
    | "executeLinkedCalendarConflictResolution"
    | "executeLinkedCalendarDisconnect"
    | "executeLinkedCalendarRebind"
    | "executeLinkedCalendarProviderChanges"
  > {
    if (this.deps.calendar) return this.deps.calendar;
    const service = this.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!service) {
      throw new CalendarServiceError(
        503,
        "Calendar service is unavailable.",
        "CALENDAR_SERVICE_UNAVAILABLE",
      );
    }
    return service;
  }

  private async execute(
    request: ApprovalRequest,
  ): Promise<CalendarMutationExecutionResult> {
    return executeCalendarMutationApproval({
      runtime: this.runtime,
      request,
      port: this.deps.port ?? createLifeOpsCalendarMutationPort(this.runtime),
    });
  }

  private approvalQueue(): ApprovalQueue {
    return (
      this.deps.approvalQueue ??
      createApprovalQueue(this.runtime, {
        agentId: this.runtime.agentId,
      })
    );
  }

  async create(
    _requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    const operationKey = requireOperationKey(request.idempotencyKey);
    const range = resolveEditorCreateRange(request);
    const startsAtMs = requireAbsoluteTimestamp(range.startAt, "startAt");
    const endsAtMs = requireAbsoluteTimestamp(range.endAt, "endAt");
    const requestSha256 = sha256({ operation: "create", request });
    const payload: CalendarEditorPayload = {
      action: "schedule_event",
      side: request.side ?? "owner",
      grantId: request.grantId ?? null,
      calendarId: request.calendarId ?? "primary",
      title: request.title,
      startsAtMs,
      endsAtMs,
      allDay:
        range.isAllDay && range.startDate && range.endDateExclusive
          ? {
              startDate: range.startDate,
              endDateExclusive: range.endDateExclusive,
            }
          : null,
      timeZone: range.timeZone,
      durationMinutes: request.durationMinutes ?? null,
      windowPreset: request.windowPreset ?? null,
      attendees:
        request.attendees?.map((attendee) => ({
          email: attendee.email,
          ...(attendee.displayName !== undefined
            ? { displayName: attendee.displayName }
            : {}),
          ...(attendee.optional !== undefined
            ? { optional: attendee.optional }
            : {}),
        })) ?? [],
      location: request.location ?? null,
      description: request.description ?? null,
      recurrence: request.recurrence ?? null,
      notifyAttendees: request.notifyAttendees === true,
      editorRequestSha256: requestSha256,
    };
    const approval = await resolveConfirmedApproval({
      queue: this.approvalQueue(),
      action: payload.action,
      payload,
      reason: `Create "${request.title.trim()}" from the authenticated owner calendar editor.`,
      operationKey,
      requestSha256,
    });
    const result = await this.execute(approval);
    if (result.kind !== "succeeded") throwExecutionFailure(result);
    if (!result.receipt.readBackAvailable) {
      return {
        outcome: "accepted_without_readback",
        event: null,
        writeOnlyReceipt: {
          provider: "apple_calendar",
          sourceId: result.receipt.sourceId,
          calendarId: result.receipt.calendarId,
          accessLevel: "write_only",
          destination: "default_calendar",
          providerEventId: null,
          readBackAvailable: false,
          acceptedAt: result.receipt.acceptedAt,
        },
      };
    }
    return {
      outcome: "event",
      event: requireReceiptEvent(result),
      writeOnlyReceipt: null,
    };
  }

  async update(
    requestUrl: URL,
    request: Parameters<CalendarOwnerMutationGateway["update"]>[1],
  ): Promise<LifeOpsCalendarEvent> {
    const operationKey = requireOperationKey(request.idempotencyKey);
    const requestSha256 = sha256({ operation: "update", request });
    const queue = this.approvalQueue();
    const existing = await queue.byIdempotencyKey(
      approvalKey("modify_event", operationKey),
      SELF_ENTITY_ID,
    );
    let approval: ApprovalRequest;
    if (existing) {
      approval = await confirmExistingEditorApproval({
        queue,
        existing,
        action: "modify_event",
        requestSha256,
      });
    } else {
      const targets = await resolveEditorMutationTargets(
        this.calendar(),
        requestUrl,
        request,
      );
      const target = targets.visible;
      const payload: CalendarEditorPayload = {
        action: "modify_event",
        side: request.side ?? "owner",
        grantId: request.grantId ?? target.grantId ?? null,
        calendarId: request.calendarId ?? target.calendarId,
        eventId: request.eventId,
        expectedProvider: target.provider,
        expectedProviderVersion: providerVersion(target),
        expectedEventUpdatedAt: target.updatedAt,
        expectedEventStartAtMs: requireAbsoluteTimestamp(
          target.startAt,
          "target.startAt",
        ),
        recurrenceScope: request.recurrenceScope ?? null,
        seriesMaster: seriesMasterBinding(targets.seriesMaster),
        notifyAttendees: request.notifyAttendees === true,
        editorRequestSha256: requestSha256,
        patch: {
          title: request.title ?? null,
          startsAtMs:
            request.startAt !== undefined
              ? requireAbsoluteTimestamp(request.startAt, "startAt")
              : null,
          endsAtMs:
            request.endAt !== undefined
              ? requireAbsoluteTimestamp(request.endAt, "endAt")
              : null,
          allDay: request.allDay ?? null,
          timeZone: request.timeZone ?? null,
          attendees:
            request.attendees?.map((attendee) => ({
              email: attendee.email,
              ...(attendee.displayName !== undefined
                ? { displayName: attendee.displayName }
                : {}),
              ...(attendee.optional !== undefined
                ? { optional: attendee.optional }
                : {}),
            })) ?? null,
          location: request.location ?? null,
          description: request.description ?? null,
          recurrence: request.recurrence ?? null,
        },
      };
      approval = await resolveConfirmedApproval({
        queue,
        action: payload.action,
        payload,
        reason:
          request.recurrenceScope === "this_and_following"
            ? `Update "${target.title}" from this occurrence forward by splitting the recurring series. Later per-occurrence exceptions will reset${request.notifyAttendees ? ", and attendees may receive both split update notifications" : ""}.`
            : `Update "${target.title}" from the authenticated owner calendar editor.`,
        operationKey,
        requestSha256,
      });
    }
    const result = await this.execute(approval);
    if (result.kind !== "succeeded") throwExecutionFailure(result);
    return requireReceiptEvent(result);
  }

  async cancel(
    requestUrl: URL,
    request: Parameters<CalendarOwnerMutationGateway["cancel"]>[1],
  ): Promise<LifeOpsCalendarEventCancellationResult> {
    const operationKey = requireOperationKey(request.idempotencyKey);
    const requestSha256 = sha256({ operation: "cancel", request });
    const queue = this.approvalQueue();
    const existing = await queue.byIdempotencyKey(
      approvalKey("cancel_event", operationKey),
      SELF_ENTITY_ID,
    );
    let approval: ApprovalRequest;
    if (existing) {
      approval = await confirmExistingEditorApproval({
        queue,
        existing,
        action: "cancel_event",
        requestSha256,
      });
    } else {
      const targets = await resolveEditorMutationTargets(
        this.calendar(),
        requestUrl,
        request,
      );
      const target = targets.visible;
      const payload: CalendarEditorPayload = {
        action: "cancel_event",
        side: request.side ?? "owner",
        grantId: request.grantId ?? target.grantId ?? null,
        calendarId: request.calendarId ?? target.calendarId,
        eventId: request.eventId,
        expectedProvider: target.provider,
        expectedProviderVersion: providerVersion(target),
        expectedEventUpdatedAt: target.updatedAt,
        expectedEventStartAtMs: requireAbsoluteTimestamp(
          target.startAt,
          "target.startAt",
        ),
        recurrenceScope: request.recurrenceScope ?? null,
        seriesMaster: seriesMasterBinding(targets.seriesMaster),
        cancellationMode: request.cancellationMode,
        notifyAttendees: request.notifyAttendees,
        editorRequestSha256: requestSha256,
      };
      approval = await resolveConfirmedApproval({
        queue,
        action: payload.action,
        payload,
        reason:
          request.recurrenceScope === "this_and_following"
            ? `Apply ${request.cancellationMode} to "${target.title}" from this occurrence forward by truncating the recurring series; every later occurrence and exception will be removed${request.notifyAttendees ? ", and attendees will be notified" : ""}.`
            : `Apply ${request.cancellationMode} to "${target.title}" from the authenticated owner calendar editor.`,
        operationKey,
        requestSha256,
      });
    }
    const result = await this.execute(approval);
    if (result.kind !== "succeeded") throwExecutionFailure(result);
    if (request.cancellationMode === "decline_invitation") {
      return {
        outcome: "invitation_declined",
        cancellationMode: "decline_invitation",
        event: requireReceiptEvent(result),
      };
    }
    return {
      outcome: "deleted",
      cancellationMode: request.cancellationMode,
      event: null,
    };
  }

  async linkCalendar(
    _requestUrl: URL,
    request: Parameters<CalendarOwnerMutationGateway["linkCalendar"]>[1],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarLink(request);
  }

  async updateLinkedCalendarControl(
    requestUrl: URL,
    request: Parameters<
      CalendarOwnerMutationGateway["updateLinkedCalendarControl"]
    >[1],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarControl(requestUrl, request);
  }

  async reconcileLinkedCalendar(
    _requestUrl: URL,
    linkId: string,
    request: Parameters<
      CalendarOwnerMutationGateway["reconcileLinkedCalendar"]
    >[2],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarReconciliation(
      requireOperationKey(linkId),
      request,
    );
  }

  async resolveLinkedCalendarConflict(
    _requestUrl: URL,
    linkId: string,
    request: Parameters<
      CalendarOwnerMutationGateway["resolveLinkedCalendarConflict"]
    >[2],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarConflictResolution(
      requireOperationKey(linkId),
      request,
    );
  }

  async rebindLinkedCalendar(
    requestUrl: URL,
    linkId: string,
    request: Parameters<
      CalendarOwnerMutationGateway["rebindLinkedCalendar"]
    >[2],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarRebind(
      requestUrl,
      requireOperationKey(linkId),
      request,
    );
  }

  async disconnectLinkedCalendar(
    _requestUrl: URL,
    linkId: string,
    request: Parameters<
      CalendarOwnerMutationGateway["disconnectLinkedCalendar"]
    >[2],
  ) {
    requireOperationKey(request.idempotencyKey);
    return this.calendar().executeLinkedCalendarDisconnect(
      requireOperationKey(linkId),
      request,
    );
  }

  async reconcileLinkedCalendarProviderChanges(
    _requestUrl: URL,
    providerEventIds: readonly string[],
  ): Promise<void> {
    await this.calendar().executeLinkedCalendarProviderChanges(
      providerEventIds,
    );
  }
}
