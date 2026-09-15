/**
 * Runs one durable approval execution attempt around an external provider.
 * The queue claim precedes dispatch, dispatch-start is persisted immediately
 * before the call, and every observed provider outcome is committed without
 * making ambiguous attempts automatically retriable.
 */

import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../../lifeops/approval-queue.types.js";
import {
  ConnectorDeliveryEvidenceError,
  ConnectorSenderChangedError,
} from "../../lifeops/messaging/connector-delivery-evidence.js";
import { ApprovalAmbiguousDeliveryError } from "./approval-delivery-errors.js";

export { ApprovalAmbiguousDeliveryError } from "./approval-delivery-errors.js";

import { ApprovalKnownNonDeliveryError } from "./messaging-helpers.js";

export interface PreparedApprovalDispatch<T> {
  readonly provider: string;
  dispatch(providerIdempotencyKey: string): Promise<{
    readonly value: T;
    readonly receipt: Readonly<Record<string, unknown>>;
  }>;
}

export type ApprovalDispatchOutcome<T> =
  | {
      readonly kind: "delivered";
      readonly value: T;
      readonly request: ApprovalRequest;
    }
  | {
      readonly kind: "known_failure";
      readonly error: Error;
      readonly request: ApprovalRequest;
    }
  | {
      readonly kind: "reconciliation_required";
      readonly error: Error;
      readonly request: ApprovalRequest;
    };

function executionMutation(
  request: ApprovalRequest,
  subjectUserId: string,
): {
  requestId: string;
  subjectUserId: string;
  attemptId: string;
} {
  if (!request.execution) {
    throw new Error(
      `[approval] claimed request ${request.id} has no execution metadata`,
    );
  }
  return {
    requestId: request.id,
    subjectUserId,
    attemptId: request.execution.attemptId,
  };
}

export async function runApprovalDispatch<T>(args: {
  queue: ApprovalQueue;
  request: ApprovalRequest;
  subjectUserId: string;
  prepared: PreparedApprovalDispatch<T>;
}): Promise<ApprovalDispatchOutcome<T>> {
  const providerIdempotencyKey = `approval:${args.request.id}:${args.prepared.provider}`;
  const claimed = await args.queue.claimExecution({
    requestId: args.request.id,
    subjectUserId: args.subjectUserId,
    provider: args.prepared.provider,
    providerIdempotencyKey,
  });
  const mutation = executionMutation(claimed, args.subjectUserId);
  await args.queue.markDispatchStarted(mutation);

  let delivered: {
    readonly value: T;
    readonly receipt: Readonly<Record<string, unknown>>;
  };
  try {
    delivered = await args.prepared.dispatch(providerIdempotencyKey);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (
      error instanceof ApprovalKnownNonDeliveryError ||
      error instanceof ConnectorSenderChangedError
    ) {
      const request = await args.queue.markRetryableFailure({
        ...mutation,
        error: error.message,
      });
      return { kind: "known_failure", error, request };
    }
    const request = await args.queue.markReconciliationRequired({
      ...mutation,
      error: error.message,
      ...(error instanceof ApprovalAmbiguousDeliveryError ||
      error instanceof ConnectorDeliveryEvidenceError
        ? { providerReceipt: error.providerReceipt }
        : {}),
    });
    return { kind: "reconciliation_required", error, request };
  }

  const request = await args.queue.markDone({
    ...mutation,
    providerReceipt: delivered.receipt,
  });
  return {
    kind: "delivered",
    value: delivered.value,
    request,
  };
}

export async function recoverInterruptedApproval(
  queue: ApprovalQueue,
  request: ApprovalRequest,
  subjectUserId: string,
): Promise<ApprovalRequest> {
  const mutation = executionMutation(request, subjectUserId);
  if (!request.execution?.dispatchStartedAt) {
    return queue.recoverUnstartedExecution(mutation);
  }
  return queue.markReconciliationRequired({
    ...mutation,
    error:
      request.execution.error ??
      "process stopped after dispatch start before recording provider outcome",
  });
}
