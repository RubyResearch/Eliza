/**
 * Advances a saved owner review through one recoverable account-switch checkpoint.
 * Domain services own side effects and replay keys; callers refresh the record
 * after a lost response instead of supplying new account or recipient choices.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffDataDisposition } from "./account-handoff-data-disposition.js";
import { AccountHandoffDisconnect } from "./account-handoff-disconnect.js";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import { AccountHandoffResume } from "./account-handoff-resume.js";
import { AccountHandoffSourceSelection } from "./account-handoff-source-selection.js";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
  handoffReadSourceReviewSchema,
} from "./account-handoff-store.js";
import { AccountHandoffVerification } from "./account-handoff-verification.js";
import type { LifeOpsService } from "./service.js";

export class AccountHandoffExecution {
  private readonly store: AccountHandoffStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: CalendarService,
    private readonly accounts: LifeOpsService,
    private readonly google: Pick<
      IGoogleWorkspaceService,
      "listCalendars" | "getGmailHistoryId"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
  }

  async advance(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record || record.revision !== expectedRevision)
      throw new ElizaError(
        "The saved account switch changed. Refresh its progress before continuing.",
        { code: "ACCOUNT_HANDOFF_CONFLICT" },
      );
    if (record.phase === "completed") return record;
    if (record.phase === "cancelled")
      throw new ElizaError(
        "This account switch was cancelled. Create a new review to continue.",
        { code: "ACCOUNT_HANDOFF_CANCELLED" },
      );
    const unverifiedChannels = record.review.messageDestinations.filter(
      (destination) => destination.channel !== "email",
    );
    if (unverifiedChannels.length)
      throw new ElizaError(
        "The selected messaging destinations require account verification before this switch can continue.",
        {
          code: "ACCOUNT_HANDOFF_CHANNEL_VERIFICATION_REQUIRED",
          context: {
            channels: unverifiedChannels.map(
              (destination) => destination.channel,
            ),
          },
        },
      );
    const admission = new AccountHandoffAdmission(
      this.runtime,
      this.ownerEntityId,
      this.calendar,
      this.requestUrl,
    );
    switch (record.phase) {
      case "reviewed":
        handoffReadSourceReviewSchema.parse(record.receipt.readSourceReview);
        // A known permission or provider failure must not first interrupt active work.
        // This preflight does not replace verification under the later pause fence.
        await verifyAccountHandoffGoogle(
          this.runtime.agentId,
          this.requestUrl,
          record.review,
          this.accounts,
          this.google,
        );
        await new AccountHandoffRecipients(
          this.runtime,
          this.ownerEntityId,
        ).verify(operationId, expectedRevision);
        return admission.begin(operationId, expectedRevision);
      case "pausing":
        return admission.pause(operationId, expectedRevision);
      case "draining":
        return admission.drain(operationId, expectedRevision);
      case "retiring_approvals":
        return admission.retireApprovals(operationId, expectedRevision);
      case "applying_mappings":
        return new AccountHandoffCalendarMappings(
          this.runtime,
          this.ownerEntityId,
          this.calendar,
          this.requestUrl,
        ).applyNext(operationId, expectedRevision);
      case "verifying_replacement": {
        const sources = await new AccountHandoffSourceSelection(
          this.runtime,
          this.ownerEntityId,
          this.calendar,
          this.requestUrl,
        ).applyNext(operationId, expectedRevision);
        if (!sources.complete) return sources.handoff;
        if (!record.receipt.googleVerification)
          return new AccountHandoffVerification(
            this.runtime,
            this.ownerEntityId,
            this.calendar,
            this.accounts,
            this.google,
            this.requestUrl,
          ).verifyGoogle(operationId, expectedRevision);
        await new AccountHandoffRecipients(
          this.runtime,
          this.ownerEntityId,
        ).verify(operationId, expectedRevision);
        return this.store.advance({
          operationId,
          expectedRevision,
          expectedPhase: "verifying_replacement",
          phase: "disconnecting_previous",
          receipt: {},
        });
      }
      case "disconnecting_previous":
        return new AccountHandoffDisconnect(
          this.runtime,
          this.ownerEntityId,
          this.calendar,
          this.accounts,
          this.google,
          this.requestUrl,
        ).apply(operationId, expectedRevision);
      case "disposing_imports":
        return new AccountHandoffDataDisposition(
          this.runtime,
          this.ownerEntityId,
          this.calendar,
          this.accounts,
          this.requestUrl,
        ).apply(operationId, expectedRevision);
      case "resuming":
        return new AccountHandoffResume(
          this.runtime,
          this.ownerEntityId,
          this.calendar,
          this.accounts,
          this.google,
          this.requestUrl,
        ).apply(operationId, expectedRevision);
    }
  }
}
