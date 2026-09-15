/**
 * Releases only pauses acquired by this handoff after imported-data disposition.
 * Canonical control replay recovers an interrupted release. Existing pauses and
 * an explicit local-only calendar choice remain paused; later user changes are
 * conflicts rather than state to overwrite.
 */
import {
  ApprovalDispatchControlStore,
  createApprovalQueue,
} from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { z } from "zod";
import { assertGoogleHandoffApprovalSelection } from "./account-handoff-approval-inventory.js";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import { accountHandoffOperationKey } from "./account-handoff-operation-key.js";
import { verifyAccountHandoffReadSources } from "./account-handoff-read-sources.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

const receiptsSchema = z.object({
  baseline: z.object({
    approval: z.object({
      paused: z.boolean(),
      operationId: z.string().nullable(),
    }),
    calendar: z.object({ paused: z.boolean() }),
  }),
  admission: z.object({ approvalRevision: z.number().int().nonnegative() }),
  mappings: z.object({ controlRevision: z.number().int().nonnegative() }),
  disposition: z.object({
    disposition: z.enum(["retain", "remove_previous_account_imports"]),
    grantId: z.string(),
    connectorAccountId: z.string(),
    providerMutation: z.literal(false),
  }),
});

export class AccountHandoffResume {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      | "getLinkedCalendarControl"
      | "executeLinkedCalendarControl"
      | "listCalendars"
    >,
    private readonly accounts: Pick<
      LifeOpsGoogleService,
      "getGoogleConnectorAccounts" | "getGoogleConnectorStatus"
    >,
    private readonly google: Pick<
      IGoogleWorkspaceService,
      "listCalendars" | "getGmailHistoryId"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
    this.approvals = new ApprovalDispatchControlStore(runtime);
  }

  async apply(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (record.phase !== "resuming" || record.revision !== expectedRevision)
      throw this.changed();
    const parsed = receiptsSchema.safeParse({
      baseline: record.receipt.admissionBaseline,
      admission: record.receipt.admissionPaused,
      mappings: record.receipt.mappingsComplete,
      disposition: record.receipt.importedDataDisposition,
    });
    if (!parsed.success) throw this.changed();
    const { baseline, admission, mappings, disposition } = parsed.data;
    const previous = record.review.previous;
    if (
      disposition.disposition !== record.review.importedData ||
      disposition.grantId !== previous.grantId ||
      disposition.connectorAccountId !== previous.connectorAccountId
    )
      throw this.changed();
    const pauseKey = accountHandoffOperationKey(
      this.runtime.agentId,
      this.ownerEntityId,
      operationId,
      "pause",
    );
    const assertApprovalOwnership = async () => {
      const current = await this.approvals.read(this.ownerEntityId);
      if (baseline.approval.paused) {
        if (
          !current.paused ||
          current.revision !== admission.approvalRevision ||
          current.operationId !== baseline.approval.operationId
        )
          throw this.changed();
      } else if (
        current.operationId !== pauseKey ||
        current.revision !==
          admission.approvalRevision + (current.paused ? 0 : 1)
      )
        throw this.changed();
      return current;
    };
    await assertApprovalOwnership();
    const accounts = await this.accounts.getGoogleConnectorAccounts(
      this.requestUrl,
      "owner",
    );
    if (
      accounts.some(
        ({ grant }) =>
          grant &&
          (grant.id === previous.grantId ||
            grant.connectorAccountId === previous.connectorAccountId),
      )
    )
      throw this.changed();
    await verifyAccountHandoffGoogle(
      this.runtime.agentId,
      this.requestUrl,
      record.review,
      this.accounts,
      this.google,
    );
    await verifyAccountHandoffReadSources(
      this.calendar,
      this.requestUrl,
      record.review,
    );
    await assertApprovalOwnership();
    await new AccountHandoffRecipients(this.runtime, this.ownerEntityId).verify(
      operationId,
      expectedRevision,
    );
    // Older in-progress operations may have crossed retirement before the fence
    // columns existed. Establish it under the admission lock before inventory.
    const ownedApproval = await assertApprovalOwnership();
    if (!ownedApproval.operationId) throw this.changed();
    const fence = {
      subjectUserId: this.ownerEntityId,
      operationId: ownedApproval.operationId,
      expectedRevision: admission.approvalRevision,
      grantId: previous.grantId,
    };
    if (ownedApproval.paused) await this.approvals.fenceGoogleAccount(fence);
    else await this.approvals.requireReleasedGoogleAccountFence(fence);
    const requests = await createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    }).list({
      subjectUserId: this.ownerEntityId,
      state: null,
      action: null,
    });
    assertGoogleHandoffApprovalSelection(requests, previous.grantId, []);
    const current = await this.calendar.getLinkedCalendarControl();
    const selected = record.review.writeCalendar;
    if (
      selected
        ? current.destination?.connectorAccountId !==
            selected.connectorAccountId ||
          current.destination.providerCalendarId !== selected.calendarId
        : current.destination !== null
    )
      throw this.changed();
    const releaseCalendar = !baseline.calendar.paused && selected !== null;
    const calendar = releaseCalendar
      ? await this.calendar.executeLinkedCalendarControl(this.requestUrl, {
          operation: "resume",
          expectedRevision: mappings.controlRevision,
          idempotencyKey: accountHandoffOperationKey(
            this.runtime.agentId,
            this.ownerEntityId,
            operationId,
            "resume_calendar",
          ),
        })
      : current;
    if (
      !releaseCalendar &&
      (!calendar.paused ||
        calendar.revision !== mappings.controlRevision ||
        calendar.pendingDispatch)
    )
      throw this.changed();
    const approval = baseline.approval.paused
      ? await assertApprovalOwnership()
      : await this.approvals.resume({
          subjectUserId: this.ownerEntityId,
          operationId: pauseKey,
          expectedRevision: admission.approvalRevision,
        });
    const finalCalendar = await this.calendar.getLinkedCalendarControl();
    const finalApproval = await this.approvals.read(this.ownerEntityId);
    if (
      finalCalendar.revision !== calendar.revision ||
      finalCalendar.paused !== calendar.paused ||
      finalApproval.revision !== approval.revision ||
      finalApproval.paused !== approval.paused ||
      finalApproval.operationId !== approval.operationId
    )
      throw this.changed();
    return this.store.advance({
      operationId,
      expectedRevision,
      expectedPhase: "resuming",
      phase: "completed",
      receipt: {
        resumed: {
          approvalRevision: approval.revision,
          approvalPaused: approval.paused,
          calendarRevision: calendar.revision,
          calendarPaused: calendar.paused,
          calendarPauseReason: releaseCalendar
            ? null
            : baseline.calendar.paused
              ? "pre_existing_pause"
              : "no_write_destination",
        },
      },
    });
  }

  private changed(): ElizaError {
    return new ElizaError(
      "The handoff or pause ownership changed. Refresh the reviewed account switch before resuming work.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
