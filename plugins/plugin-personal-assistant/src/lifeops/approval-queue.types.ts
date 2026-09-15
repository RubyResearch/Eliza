/** Types for the owner-approval queue: request states, action kinds, and payload shapes. */

import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  ApprovalIdempotencyConflictError as RuntimeApprovalIdempotencyConflictError,
  ApprovalNotFoundError as RuntimeApprovalNotFoundError,
  ApprovalStateTransitionError as RuntimeApprovalStateTransitionError,
} from "@elizaos/agent";
import type { CalendarCardSenderBinding } from "./calendar-card-sender.js";
import type { TransactionalDb } from "./sql.js";
import type { TravelBookingPayloadFields } from "./travel-booking.types.js";

export const SCHEDULING_APPROVAL_MESSAGE_KINDS = [
  "opening",
  "proposal",
  "confirmation",
  "cancellation",
] as const;
export type SchedulingApprovalMessageKind =
  (typeof SCHEDULING_APPROVAL_MESSAGE_KINDS)[number];

export const SCHEDULING_APPROVAL_TRANSPORT_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
  "sms",
] as const;
export type SchedulingApprovalTransportChannel =
  (typeof SCHEDULING_APPROVAL_TRANSPORT_CHANNELS)[number];

/**
 * Binds an approval row to one immutable scheduling draft. The hash covers
 * the transport envelope and exact message bytes, so a later executor can
 * refuse altered content rather than treating approval as open-ended consent.
 */
export interface SchedulingApprovalCorrelation {
  readonly kind: "scheduling_message";
  readonly negotiationId: string;
  readonly proposalId: string | null;
  readonly messageKind: SchedulingApprovalMessageKind;
  readonly transportChannel: SchedulingApprovalTransportChannel;
  readonly sourceUpdatedAt: string;
  readonly counterpartyEntityId: string;
  readonly counterpartyEntityUpdatedAt: string;
  readonly draftVersion: 1;
  readonly contentSha256: string;
}

/** Immutable bytes and capability identity approved for one calendar card. */
interface CalendarCardApprovalContent {
  readonly kind: "calendar_card";
  readonly cardId: string;
  readonly recipientEntityId: string;
  readonly date: string;
  readonly timeZone: string;
  readonly privacyMode: "full" | "times_only" | "busy_only";
  readonly textSha256: string;
  readonly htmlSha256: string;
  readonly envelopeSha256: string;
}

/** Legacy cards remain iMessage-only; new reviews bind the transport and destination. */
export type CalendarCardApprovalCorrelation = CalendarCardApprovalContent &
  (
    | { readonly version: 1 }
    | {
        readonly version: 2;
        readonly channel: "imessage" | "telegram" | "discord";
        readonly recipient: string;
        readonly deliverySha256: string;
      }
    | {
        readonly version: 3;
        readonly channel: "imessage" | "telegram" | "discord";
        readonly recipient: string;
        readonly ownerEntityId: string;
        readonly deliverySha256: string;
      }
    | {
        readonly version: 4;
        readonly channel: "imessage" | "telegram" | "discord";
        readonly recipient: string;
        readonly ownerEntityId: string;
        readonly deliverySha256: string;
        readonly sender: CalendarCardSenderBinding;
      }
  );

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
  | "retryable"
  | "reconciliation_required"
  | "done"
  | "rejected"
  | "expired";

export type ApprovalAction =
  | "send_message"
  | "send_email"
  | "schedule_event"
  | "modify_event"
  | "cancel_event"
  | "book_travel"
  | "make_call"
  | "sign_document"
  | "execute_workflow"
  | "spend_money";

export type ApprovalChannel =
  | "telegram"
  | "discord"
  | "whatsapp"
  | "slack"
  | "imessage"
  | "sms"
  | "x_dm"
  | "email"
  | "google_calendar"
  | "microsoft_calendar"
  | "apple_calendar"
  | "ics_calendar"
  | "browser"
  | "phone"
  | "internal";

export interface ApprovalExecution {
  readonly attemptId: string;
  readonly provider: string;
  readonly providerIdempotencyKey: string;
  readonly claimedAt: Date;
  readonly dispatchStartedAt: Date | null;
  readonly providerReceipt: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly reconciledAt: Date | null;
  readonly reconciledBy: string | null;
  readonly reconciliationReason: string | null;
}

export type CalendarMutationRecurrenceScope =
  | "instance"
  | "this_and_following"
  | "series";

export type CalendarCancellationMode =
  | "organizer_cancel"
  | "decline_invitation"
  | "remove_private_copy";

export interface CalendarApprovalAttendee {
  readonly email: string;
  readonly displayName?: string | null;
  readonly optional?: boolean;
}

export interface CalendarApprovalAllDayRange {
  readonly startDate: string;
  readonly endDateExclusive: string;
}

/** String entries remain readable for approvals persisted before attendee metadata was retained. */
export type CalendarApprovalAttendeeInput = string | CalendarApprovalAttendee;

export interface CalendarSeriesMasterBinding {
  readonly externalId: string;
  readonly startAtMs: number;
  readonly updatedAt: string;
  readonly etag: string;
}

/**
 * A mutable calendar source must be named explicitly once more than one
 * account can expose the same provider calendar id. Optionality preserves
 * persisted single-account create approvals; update/delete execution requires
 * all target-version fields and fails closed for older unbound approvals.
 */
export type CalendarMutationSourceBinding = {
  readonly grantId?: string | null;
  readonly side?: "owner" | "agent" | null;
};

export type ApprovalPayload =
  | {
      action: "send_message";
      /** Requires family draft authorization immediately before delivery. */
      familyPacketId?: string;
      recipient: string;
      body: string;
      replyToMessageId: string | null;
      scheduling?: SchedulingApprovalCorrelation;
      calendarCard?: CalendarCardApprovalCorrelation;
    }
  | {
      action: "send_email";
      /** Requires family draft authorization immediately before delivery. */
      familyPacketId?: string;
      /** Binds a reviewed send to one account; legacy approvals may omit it. */
      grantId?: string;
      to: ReadonlyArray<string>;
      cc: ReadonlyArray<string>;
      bcc: ReadonlyArray<string>;
      subject: string;
      body: string;
      threadId: string | null;
      replyToMessageId?: string | null;
      scheduling?: SchedulingApprovalCorrelation;
    }
  | ({
      action: "schedule_event";
      calendarId: string;
      title: string;
      startsAtMs: number;
      endsAtMs: number;
      allDay?: CalendarApprovalAllDayRange | null;
      timeZone?: string | null;
      durationMinutes?: number | null;
      windowPreset?:
        | "tomorrow_morning"
        | "tomorrow_afternoon"
        | "tomorrow_evening"
        | null;
      attendees: ReadonlyArray<CalendarApprovalAttendeeInput>;
      location: string | null;
      description: string | null;
      recurrence?: ReadonlyArray<string> | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
      travelBuffer?: {
        readonly bufferMinutes: number;
        readonly method: string;
        readonly originAddress: string | null;
        readonly destinationAddress: string | null;
      } | null;
    } & CalendarMutationSourceBinding)
  | ({
      action: "modify_event";
      calendarId: string;
      eventId: string;
      expectedProvider?:
        | "google"
        | "microsoft"
        | "apple_calendar"
        | "ics"
        | "eliza"
        | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      expectedProviderVersion?: string | null;
      recurrenceScope?: CalendarMutationRecurrenceScope | null;
      seriesMaster?: CalendarSeriesMasterBinding | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
      patch: {
        title: string | null;
        startsAtMs: number | null;
        endsAtMs: number | null;
        allDay?: CalendarApprovalAllDayRange | null;
        timeZone?: string | null;
        attendees: ReadonlyArray<CalendarApprovalAttendeeInput> | null;
        location: string | null;
        description: string | null;
        recurrence?: ReadonlyArray<string> | null;
      };
    } & CalendarMutationSourceBinding)
  | ({
      action: "cancel_event";
      calendarId: string;
      eventId: string;
      notifyAttendees: boolean;
      expectedProvider?:
        | "google"
        | "microsoft"
        | "apple_calendar"
        | "ics"
        | "eliza"
        | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      expectedProviderVersion?: string | null;
      recurrenceScope?: CalendarMutationRecurrenceScope | null;
      seriesMaster?: CalendarSeriesMasterBinding | null;
      cancellationMode?: CalendarCancellationMode | null;
      editorRequestSha256?: string;
    } & CalendarMutationSourceBinding)
  | {
      action: "book_travel";
      kind: TravelBookingPayloadFields["kind"];
      provider: string;
      itineraryRef: string;
      totalCents: number;
      currency: string;
      offerId?: string | null;
      offerRequestId?: string | null;
      orderType?: "hold" | "instant" | null;
      search?: TravelBookingPayloadFields["search"];
      passengers?: TravelBookingPayloadFields["passengers"];
      calendarSync?: TravelBookingPayloadFields["calendarSync"];
      summary?: string | null;
      /** Server-side cost breakdown surfaced to the user alongside any
       *  payment-required prompt. Mirrors `DuffelCallCost`; held as a
       *  loose record here so the approval-queue type doesn't have to
       *  depend on the travel-adapter package. */
      cost?: {
        readonly totalUsd: number;
        readonly creatorMarkupUsd: number;
        readonly platformFeeUsd: number;
        readonly markupPercent: number | null;
      } | null;
      /** Set when an x402 PaymentRequiredError fired before the booking
       *  could be quoted. The user sees both the booking intent and the
       *  top-up prompt in a single approval entry. */
      paymentRequired?: {
        readonly amount: string;
        readonly asset: string;
        readonly network: string;
        readonly payTo: string;
        readonly scheme: string;
        readonly expiresAt: string | null;
        readonly description: string | null;
      } | null;
    }
  | {
      action: "make_call";
      to: string;
      script: string;
      maxDurationSeconds: number;
    }
  | {
      action: "sign_document";
      documentId: string;
      documentName: string;
      signatureUrl: string;
      deadline: string;
    }
  | {
      action: "execute_workflow";
      workflowId: string;
      input: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      action: "spend_money";
      vendor: string;
      amountCents: number;
      currency: string;
      memo: string;
    };

/** Persisted approval request. */
export interface ApprovalRequest {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly state: ApprovalRequestState;
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: ApprovalAction;
  readonly payload: ApprovalPayload;
  readonly channel: ApprovalChannel;
  readonly reason: string;
  readonly idempotencyKey: string | null;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly execution: ApprovalExecution | null;
}

/**
 * Atomic enqueue outcome. `reused` comes from the idempotency-constrained
 * insert itself; consumers must not reconstruct it from row state or time.
 */
export interface ApprovalEnqueueResult {
  readonly request: ApprovalRequest;
  readonly reused: boolean;
}

/** Input to `enqueue` — server fills in id, timestamps, and initial state. */
export interface ApprovalEnqueueInput {
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: ApprovalAction;
  readonly payload: ApprovalPayload;
  readonly channel: ApprovalChannel;
  readonly reason: string;
  /**
   * Permanently binds one caller-defined intent to its immutable request,
   * including terminal rejection. Reconsideration requires an explicit fresh
   * revision/nonce key; implementations never resurrect a rejected row.
   */
  readonly idempotencyKey?: string | null;
  readonly expiresAt: Date;
}

/**
 * A reused idempotency key must describe the same immutable approval. Thrown
 * by the runtime store, so LifeOps re-exports that class rather than declaring
 * a look-alike `instanceof` would not match.
 */
export {
  RuntimeApprovalIdempotencyConflictError as ApprovalIdempotencyConflictError,
};

/** Filter for `list`. All fields combine with AND. */
export interface ApprovalListFilter {
  readonly subjectUserId: string | null;
  readonly state: ApprovalRequestState | null;
  readonly action: ApprovalAction | null;
  /** Optional caller-requested page size; omit or pass null for the complete set. */
  readonly limit?: number | null;
}

/** Resolution input for `approve` / `reject`. */
export interface ApprovalResolution {
  readonly resolvedBy: string;
  readonly resolutionReason: string;
}

export interface ApprovalExecutionClaim {
  readonly requestId: string;
  readonly subjectUserId: string;
  readonly provider: string;
  readonly providerIdempotencyKey: string;
}

export interface ApprovalExecutionMutation {
  readonly requestId: string;
  readonly subjectUserId: string;
  readonly attemptId: string;
}

export interface ApprovalExecutionFailure extends ApprovalExecutionMutation {
  readonly error: string;
  readonly providerReceipt?: Readonly<Record<string, unknown>>;
}

export interface ApprovalExecutionCompletion extends ApprovalExecutionMutation {
  readonly providerReceipt: Readonly<Record<string, unknown>>;
}

export interface ApprovalExecutionReconciliation
  extends ApprovalExecutionMutation {
  readonly outcome: "delivered" | "not_delivered";
  readonly reconciledBy: string;
  readonly reconciliationReason: string;
  readonly providerReceipt?: Readonly<Record<string, unknown>>;
}

/** Thrown when a state transition is invalid. */
export {
  RuntimeApprovalNotFoundError as ApprovalNotFoundError,
  RuntimeApprovalStateTransitionError as ApprovalStateTransitionError,
};

/**
 * Thrown when a compare-and-swap state transition loses a concurrent race:
 * the row's state changed between the read and the guarded write (e.g. an
 * in-flight `approve` racing `purgeExpired`). `from` is the state the row
 * actually holds after the lost race. Subclasses
 * `ApprovalStateTransitionError` so existing invalid-transition handling
 * still applies; callers may match this class first to surface the conflict
 * distinctly.
 */
export class ApprovalTransitionConflictError extends RuntimeApprovalStateTransitionError {
  constructor(
    requestId: string,
    actualState: ApprovalRequestState,
    to: ApprovalRequestState,
  ) {
    super(requestId, actualState, to);
    this.name = "ApprovalTransitionConflictError";
    this.message = `[ApprovalQueue] transition conflict for request ${requestId}: state is now ${actualState}, refusing ${actualState} -> ${to}`;
  }
}

/** Thrown before resolution when a registered queue predates required methods. */
export class ApprovalQueueCompatibilityError extends Error {
  public readonly actualCapability: unknown;
  public readonly actualVersion: unknown;

  constructor(actualCapability: unknown, actualVersion: unknown) {
    super(
      `[ApprovalQueue] registered capability is incompatible; expected ${APPROVAL_EXECUTION_CAPABILITY}@${APPROVAL_EXECUTION_PROTOCOL_VERSION}`,
    );
    this.name = "ApprovalQueueCompatibilityError";
    this.actualCapability = actualCapability;
    this.actualVersion = actualVersion;
  }
}

/**
 * The subject-scoped approval state machine. `@elizaos/agent` owns the only
 * SQL implementation; LifeOps re-declares the contract here because its
 * payload/channel unions are richer than the runtime's structural ones.
 *
 * Implementations must:
 *  - Reject invalid state transitions by throwing `ApprovalStateTransitionError`.
 *  - Reject unknown ids by throwing `ApprovalNotFoundError`.
 *  - Use the structured logger only (no `console.*`).
 *  - Treat `purgeExpired` as idempotent.
 */
export interface ApprovalExecutionCapability {
  readonly capability: typeof APPROVAL_EXECUTION_CAPABILITY;
  readonly protocolVersion: typeof APPROVAL_EXECUTION_PROTOCOL_VERSION;
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest>;
  enqueueWithResult(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult>;
  /**
   * Persist an already-confirmed owner gesture without emitting a second
   * approval prompt. The same immutable queue and transition rules apply.
   */
  enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  /**
   * Insert or reuse an approval inside the caller's transaction so a domain
   * mutation and its owner gate commit together. Owner-facing side channels
   * run after the commit via {@link ApprovalQueue.surfaceEnqueuedApproval}.
   */
  enqueueTransactional(
    input: ApprovalEnqueueInput,
    tx: TransactionalDb,
  ): Promise<ApprovalEnqueueResult>;
  list(filter: ApprovalListFilter): Promise<ReadonlyArray<ApprovalRequest>>;
  byId(id: string, subjectUserId: string): Promise<ApprovalRequest | null>;
  byIdempotencyKey(
    idempotencyKey: string,
    subjectUserId: string,
  ): Promise<ApprovalRequest | null>;
  approve(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  reject(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  claimExecution(claim: ApprovalExecutionClaim): Promise<ApprovalRequest>;
  markDispatchStarted(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest>;
  markDone(completion: ApprovalExecutionCompletion): Promise<ApprovalRequest>;
  markRetryableFailure(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest>;
  markReconciliationRequired(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest>;
  recoverUnstartedExecution(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest>;
  reconcileExecution(
    reconciliation: ApprovalExecutionReconciliation,
  ): Promise<ApprovalRequest>;
  /**
   * Retire pending, approved, or confirmed-undelivered retryable requests.
   * Executing and uncertain deliveries require reconciliation, not expiry.
   */
  markExpired(id: string, subjectUserId: string): Promise<ApprovalRequest>;
  removePending(id: string, subjectUserId: string): Promise<void>;
  purgeExpired(now: Date): Promise<ReadonlyArray<string>>;
}

/**
 * What LifeOps consumers hold: the runtime capability plus the owner-facing
 * surfacing the runtime cannot do (a scheduled approval task, the chat choice
 * event, and the notification rail).
 */
export interface ApprovalQueue extends ApprovalExecutionCapability {
  /**
   * Raise the owner prompt for a row that is already committed. Separate from
   * enqueue so a transactional caller surfaces only after its commit.
   */
  surfaceEnqueuedApproval(request: ApprovalRequest): Promise<void>;
}
