/**
 * Records Google verification only while the reviewed handoff still owns its
 * paused controls. The checkpoint is historical evidence; disconnection must
 * revalidate current accounts and remaining channel requirements separately.
 */
import { ApprovalDispatchControlStore } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { z } from "zod";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

export class AccountHandoffVerification {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      "getLinkedCalendarControl"
    >,
    private readonly accounts: Pick<
      LifeOpsGoogleService,
      "getGoogleConnectorStatus"
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

  async verifyGoogle(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (
      record.phase !== "verifying_replacement" ||
      record.revision !== expectedRevision
    )
      throw this.changed();
    const admission = z
      .object({ approvalRevision: z.number().int().nonnegative() })
      .parse(record.receipt.admissionPaused);
    const mappings = z
      .object({ controlRevision: z.number().int().nonnegative() })
      .parse(record.receipt.mappingsComplete);
    const assertPaused = async () => {
      const approval = await this.approvals.read(this.ownerEntityId);
      const calendar = await this.calendar.getLinkedCalendarControl();
      if (
        !approval.paused ||
        approval.revision !== admission.approvalRevision ||
        !calendar.paused ||
        calendar.pendingDispatch ||
        calendar.revision !== mappings.controlRevision
      )
        throw this.changed();
    };
    await assertPaused();
    if (record.receipt.googleVerification) return record;
    const receipt = await verifyAccountHandoffGoogle(
      this.runtime.agentId,
      this.requestUrl,
      record.review,
      this.accounts,
      this.google,
    );
    await assertPaused();
    return this.store.checkpointGoogleVerification({
      operationId,
      expectedRevision,
      receipt,
    });
  }

  private changed(): ElizaError {
    return new ElizaError(
      "The handoff or its pause ownership changed. Reload the saved review before verifying accounts.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
