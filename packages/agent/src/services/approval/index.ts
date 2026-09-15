/**
 * Runtime owner-approval queue: enqueue/list/resolve outbound-action approvals
 * over the `approval_requests` table (owned by `@elizaos/plugin-sql`, public
 * schema), surfaced through the registered {@link ApprovalService}.
 */

export {
  type ApprovalDispatchControl,
  type ApprovalDispatchControlMutation,
  ApprovalDispatchControlStore,
  approvalDispatchAdmissionCte,
} from "./dispatch-control.ts";
export {
  APPROVAL_SERVICE,
  ApprovalService,
  resolveApprovalService,
} from "./service.ts";
export { createApprovalQueue, PgApprovalQueue } from "./store.ts";
export {
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
  type ApprovalTravelCalendarSync,
  type ApprovalTravelPassenger,
} from "./types.ts";
