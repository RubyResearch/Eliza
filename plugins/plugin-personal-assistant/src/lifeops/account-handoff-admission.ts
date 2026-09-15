/**
 * Coordinates the admission stages of an owner-reviewed account handoff using
 * the canonical approval queue and calendar control. Original pause ownership
 * is checkpointed before mutation so retries preserve pre-existing pauses.
 */
import {
  ApprovalDispatchControlStore,
  createApprovalQueue,
} from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import { z } from "zod";
import { assertGoogleHandoffApprovalSelection } from "./account-handoff-approval-inventory.js";
import { accountHandoffOperationKey } from "./account-handoff-operation-key.js";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";

const baselineSchema = z.object({
  approval: z.object({
    revision: z.number().int().nonnegative(),
    paused: z.boolean(),
    operationId: z.string().nullable(),
  }),
  calendar: z.object({
    revision: z.number().int().nonnegative(),
    paused: z.boolean(),
  }),
});
const pausedSchema = z.object({
  approvalRevision: z.number().int().nonnegative(),
  calendarRevision: z.number().int().nonnegative(),
});

export class AccountHandoffAdmission {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      "getLinkedCalendarControl" | "executeLinkedCalendarControl"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
    this.approvals = new ApprovalDispatchControlStore(runtime);
  }

  async begin(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.requirePhase(
      operationId,
      expectedRevision,
      "reviewed",
    );
    const approval = await this.approvals.read(this.ownerEntityId);
    const calendar = await this.calendar.getLinkedCalendarControl();
    return this.store.advance({
      operationId,
      expectedRevision: record.revision,
      expectedPhase: "reviewed",
      phase: "pausing",
      receipt: {
        admissionBaseline: {
          approval: { ...approval },
          calendar: { revision: calendar.revision, paused: calendar.paused },
        },
      },
    });
  }

  async pause(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.requirePhase(
      operationId,
      expectedRevision,
      "pausing",
    );
    const baseline = baselineSchema.parse(record.receipt.admissionBaseline);
    const approval = baseline.approval.paused
      ? await this.approvals.read(this.ownerEntityId)
      : await this.approvals.pause({
          subjectUserId: this.ownerEntityId,
          operationId: this.operationKey(operationId),
          expectedRevision: baseline.approval.revision,
        });
    if (
      baseline.approval.paused &&
      (!approval.paused ||
        approval.revision !== baseline.approval.revision ||
        approval.operationId !== baseline.approval.operationId)
    )
      throw this.changed();
    const calendar = baseline.calendar.paused
      ? await this.calendar.getLinkedCalendarControl()
      : await this.calendar.executeLinkedCalendarControl(this.requestUrl, {
          operation: "pause",
          expectedRevision: baseline.calendar.revision,
          idempotencyKey: this.operationKey(operationId),
        });
    if (
      !calendar.paused ||
      (baseline.calendar.paused &&
        calendar.revision !== baseline.calendar.revision)
    )
      throw this.changed();
    return this.store.advance({
      operationId,
      expectedRevision: record.revision,
      expectedPhase: "pausing",
      phase: "draining",
      receipt: {
        admissionPaused: {
          approvalRevision: approval.revision,
          calendarRevision: calendar.revision,
        },
      },
    });
  }

  /** Later account mutations must compare these control revisions at their own commit boundary. */
  async drain(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.requirePhase(
      operationId,
      expectedRevision,
      "draining",
    );
    const paused = pausedSchema.parse(record.receipt.admissionPaused);
    const approval = await this.approvals.read(this.ownerEntityId);
    const calendar = await this.calendar.getLinkedCalendarControl();
    if (
      !approval.paused ||
      approval.revision !== paused.approvalRevision ||
      !calendar.paused ||
      calendar.revision !== paused.calendarRevision
    )
      throw this.changed();
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const requests = await queue.list({
      subjectUserId: this.ownerEntityId,
      state: null,
      action: null,
    });
    const unresolved = requests.filter(
      (request) =>
        request.state === "executing" ||
        request.state === "reconciliation_required",
    );
    if (unresolved.length || calendar.pendingDispatch) {
      throw new ElizaError(
        "Wait for active deliveries and reconcile uncertain outcomes before replacing accounts",
        {
          code: "ACCOUNT_HANDOFF_DRAIN_REQUIRED",
          context: {
            requests: unresolved.map(({ id, state }) => ({ id, state })),
            calendarDispatch: calendar.pendingDispatch,
          },
        },
      );
    }
    return this.store.advance({
      operationId,
      expectedRevision: record.revision,
      expectedPhase: "draining",
      phase: "retiring_approvals",
      receipt: {
        admissionDrained: {
          approvalRevision: approval.revision,
          calendarRevision: calendar.revision,
        },
      },
    });
  }

  async retireApprovals(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.requirePhase(
      operationId,
      expectedRevision,
      "retiring_approvals",
    );
    const paused = pausedSchema.parse(record.receipt.admissionPaused);
    const assertPaused = async () => {
      const approval = await this.approvals.read(this.ownerEntityId);
      const calendar = await this.calendar.getLinkedCalendarControl();
      if (
        !approval.paused ||
        approval.revision !== paused.approvalRevision ||
        !calendar.paused ||
        calendar.revision !== paused.calendarRevision ||
        calendar.pendingDispatch
      )
        throw this.changed();
    };
    await assertPaused();
    const control = await this.approvals.read(this.ownerEntityId);
    if (!control.operationId) throw this.changed();
    await this.approvals.fenceGoogleAccount({
      subjectUserId: this.ownerEntityId,
      operationId: control.operationId,
      expectedRevision: paused.approvalRevision,
      grantId: record.review.previous.grantId,
    });
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const assertSelectionComplete = async () =>
      assertGoogleHandoffApprovalSelection(
        await queue.list({
          subjectUserId: this.ownerEntityId,
          state: null,
          action: null,
        }),
        record.review.previous.grantId,
        record.review.retireApprovalIds,
      );
    await assertSelectionComplete();
    const selected = [];
    for (const requestId of new Set(record.review.retireApprovalIds)) {
      const request = await queue.byId(requestId, this.ownerEntityId);
      if (!request)
        throw new ElizaError(
          "A reviewed approval is unavailable to this owner. Refresh the handoff review.",
          { code: "ACCOUNT_HANDOFF_APPROVAL_UNAVAILABLE" },
        );
      if (
        request.state === "executing" ||
        request.state === "reconciliation_required"
      )
        throw new ElizaError(
          "Reconcile the reviewed delivery before retiring its approval",
          { code: "ACCOUNT_HANDOFF_DRAIN_REQUIRED" },
        );
      selected.push(request);
    }
    const outcomes = [];
    for (const request of selected) {
      await assertPaused();
      const retired =
        request.state === "pending" ||
        request.state === "approved" ||
        request.state === "retryable"
          ? await queue.markExpired(request.id, this.ownerEntityId)
          : request;
      outcomes.push({ requestId: retired.id, state: retired.state });
    }
    await assertPaused();
    await assertSelectionComplete();
    return this.store.advance({
      operationId,
      expectedRevision: record.revision,
      expectedPhase: "retiring_approvals",
      phase: "applying_mappings",
      receipt: { retiredApprovals: outcomes },
    });
  }

  private async requirePhase(
    operationId: string,
    revision: number,
    phase: AccountHandoffRecord["phase"],
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record || record.revision !== revision || record.phase !== phase)
      throw this.changed();
    return record;
  }

  private operationKey(operationId: string): string {
    return accountHandoffOperationKey(
      this.runtime.agentId,
      this.ownerEntityId,
      operationId,
      "pause",
    );
  }

  private changed(): ElizaError {
    return new ElizaError(
      "Handoff or pause ownership changed. Reload the saved handoff before continuing.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
