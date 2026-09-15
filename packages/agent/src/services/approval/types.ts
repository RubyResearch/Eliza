/**
 * Approval-queue transport types — the runtime contract for the
 * `approval_requests` table (owned by `@elizaos/plugin-sql`, public schema).
 *
 * These are agent-private (no plugin dependency): the `book_travel` payload's
 * travel sub-shapes are declared structurally here rather than importing the
 * Duffel/travel types from `@elizaos/plugin-personal-assistant` — the runtime
 * state machine + SQL + validation only need the structural shape. PA keeps its
 * own precisely-typed `approval-queue.types.ts` for the travel/Duffel domain
 * reads; the structural overlap means PA's precise payloads remain assignable
 * to this contract when enqueuing through the runtime {@link ApprovalQueue}.
 */

import type { TransactionalDb } from "./sql.ts";

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
  | "retryable"
  | "reconciliation_required"
  | "done"
  | "rejected"
  | "expired";

export const APPROVAL_EXECUTION_CAPABILITY = "eliza.approval-execution";
export const APPROVAL_EXECUTION_PROTOCOL_VERSION = 2 as const;

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

/** Travel passenger record — structural shape; see module docstring. */
export interface ApprovalTravelPassenger {
  readonly offerPassengerId?: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly bornOn: string;
  readonly email?: string | null;
  readonly phoneNumber?: string | null;
  readonly title?: string | null;
  readonly gender?: string | null;
}

/** Travel calendar-sync plan — structural shape; see module docstring. */
export interface ApprovalTravelCalendarSync {
  readonly enabled: boolean;
  readonly calendarId?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly timeZone?: string | null;
}

/** Calendar invitee metadata preserved from the authenticated editor. */
export interface ApprovalCalendarAttendee {
  readonly email: string;
  readonly displayName?: string | null;
  readonly optional?: boolean;
}

/** String entries remain readable for approvals persisted before metadata support. */
export type ApprovalCalendarAttendeeInput = string | ApprovalCalendarAttendee;

type ApprovalCalendarSourceBinding = {
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
    }
  | ({
      action: "schedule_event";
      calendarId: string;
      title: string;
      startsAtMs: number;
      endsAtMs: number;
      attendees: ReadonlyArray<ApprovalCalendarAttendeeInput>;
      location: string | null;
      description: string | null;
      timeZone?: string | null;
      durationMinutes?: number | null;
      windowPreset?:
        | "tomorrow_morning"
        | "tomorrow_afternoon"
        | "tomorrow_evening"
        | null;
      recurrence?: ReadonlyArray<string> | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
    } & ApprovalCalendarSourceBinding)
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
      expectedProviderVersion?: string | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      seriesMaster?: {
        readonly externalId: string;
        readonly startAtMs: number;
        readonly updatedAt: string;
        readonly etag: string;
      } | null;
      recurrenceScope?: "instance" | "this_and_following" | "series" | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
      patch: {
        title: string | null;
        startsAtMs: number | null;
        endsAtMs: number | null;
        attendees: ReadonlyArray<ApprovalCalendarAttendeeInput> | null;
        location: string | null;
        description: string | null;
        timeZone?: string | null;
        recurrence?: ReadonlyArray<string> | null;
      };
    } & ApprovalCalendarSourceBinding)
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
      expectedProviderVersion?: string | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      seriesMaster?: {
        readonly externalId: string;
        readonly startAtMs: number;
        readonly updatedAt: string;
        readonly etag: string;
      } | null;
      recurrenceScope?: "instance" | "this_and_following" | "series" | null;
      cancellationMode?:
        | "organizer_cancel"
        | "decline_invitation"
        | "remove_private_copy"
        | null;
      editorRequestSha256?: string;
    } & ApprovalCalendarSourceBinding)
  | {
      action: "book_travel";
      kind: "flight" | "hotel" | "ground";
      provider: string;
      itineraryRef: string;
      totalCents: number;
      currency: string;
      offerId?: string | null;
      offerRequestId?: string | null;
      orderType?: "hold" | "instant" | null;
      /** Opaque flight-search context (Duffel `SearchFlightsRequest` in PA). */
      search?: Readonly<Record<string, unknown>> | null;
      passengers?: ReadonlyArray<ApprovalTravelPassenger>;
      calendarSync?: ApprovalTravelCalendarSync | null;
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
 * Atomic enqueue outcome. `reused` is decided by the same insert that owns the
 * idempotency constraint, so callers never infer replay from request state or
 * timestamps.
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

/** A reused idempotency key must describe the same immutable approval. */
export class ApprovalIdempotencyConflictError extends Error {
  public readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      `[ApprovalQueue] idempotency key ${idempotencyKey} already identifies a different approval request`,
    );
    this.name = "ApprovalIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

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
export class ApprovalStateTransitionError extends Error {
  public readonly requestId: string;
  public readonly from: ApprovalRequestState;
  public readonly to: ApprovalRequestState;

  constructor(
    requestId: string,
    from: ApprovalRequestState,
    to: ApprovalRequestState,
  ) {
    super(
      `[ApprovalQueue] invalid transition for request ${requestId}: ${from} -> ${to}`,
    );
    this.name = "ApprovalStateTransitionError";
    this.requestId = requestId;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when an operation references an unknown request id. */
export class ApprovalNotFoundError extends Error {
  public readonly requestId: string;

  constructor(requestId: string) {
    super(`[ApprovalQueue] request not found: ${requestId}`);
    this.name = "ApprovalNotFoundError";
    this.requestId = requestId;
  }
}

/**
 * Queue interface. Implementations must:
 *  - Reject invalid state transitions by throwing `ApprovalStateTransitionError`.
 *  - Reject unknown ids by throwing `ApprovalNotFoundError`.
 *  - Use the structured logger only (no `console.*`).
 *  - Treat `purgeExpired` as idempotent.
 */
export interface ApprovalQueue {
  readonly capability: typeof APPROVAL_EXECUTION_CAPABILITY;
  readonly protocolVersion: typeof APPROVAL_EXECUTION_PROTOCOL_VERSION;
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest>;
  enqueueWithResult(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult>;
  /**
   * Enqueue and await the owner-notification projection. Exact seed/import
   * workflows use this seam so no background persistence can escape their
   * receipt and compensation boundary.
   */
  enqueueWithResultAndNotification?(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult>;
  /**
   * Persist an owner gesture that is already confirmed at an authenticated
   * boundary. Implementations must not emit a redundant approval prompt.
   */
  enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  /**
   * Insert (or reuse, under an idempotency key) inside the caller's
   * transaction so a domain mutation and its owner gate commit together.
   * Owner-facing side channels must run only after that commit.
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

export interface ApprovalQueueOptions {
  readonly agentId: string;
}
