/**
 * Applies the saved imported-data decision after the reviewed old account is
 * disconnected. Cleanup uses domain-owned, account-scoped local projections;
 * retries need no credentials and never delete events from a provider.
 */
import { ApprovalDispatchControlStore } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import { z } from "zod";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";
import { LifeOpsRepository } from "./repository.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

const disconnectedReceipt = z.object({
  connectorAccountId: z.string().min(1),
  grantId: z.string().min(1),
  email: z.email(),
});

export class AccountHandoffDataDisposition {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  private readonly repository: LifeOpsRepository;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      "getLinkedCalendarControl" | "purgeImportedCalendarData"
    >,
    private readonly accounts: Pick<
      LifeOpsGoogleService,
      "getGoogleConnectorAccounts"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
    this.approvals = new ApprovalDispatchControlStore(runtime);
    this.repository = new LifeOpsRepository(runtime);
  }

  async apply(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (
      record.phase !== "disposing_imports" ||
      record.revision !== expectedRevision
    )
      throw this.changed();
    const previous = record.review.previous;
    const receipt = disconnectedReceipt.safeParse(
      record.receipt.previousDisconnected,
    );
    if (
      !receipt.success ||
      receipt.data.connectorAccountId !== previous.connectorAccountId ||
      receipt.data.grantId !== previous.grantId ||
      receipt.data.email.toLowerCase() !== previous.email.toLowerCase()
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
    const replacement = record.review.replacement;
    const current = accounts.find(
      ({ grant }) => grant?.id === replacement.grantId,
    );
    if (
      !current?.connected ||
      current.side !== "owner" ||
      !current.grant ||
      current.grant.agentId !== this.runtime.agentId ||
      current.grant.mode !== "local" ||
      current.grant.provider !== "google" ||
      current.grant.side !== "owner" ||
      current.grant.connectorAccountId !== replacement.connectorAccountId ||
      current.grant.identityEmail?.toLowerCase() !==
        replacement.email.toLowerCase()
    )
      throw this.changed();
    await assertPaused();
    if (record.review.importedData === "remove_previous_account_imports") {
      await this.calendar.purgeImportedCalendarData({
        provider: "google",
        side: "owner",
        grantId: previous.grantId,
        connectorAccountId: previous.connectorAccountId,
        confirmAction: true,
      });
      await this.repository.deleteGmailMessagesForProvider(
        this.runtime.agentId,
        "google",
        "owner",
        previous.grantId,
      );
      await this.repository.deleteGmailSpamReviewItemsForProvider(
        this.runtime.agentId,
        "google",
        "owner",
        previous.grantId,
      );
      await this.repository.deleteGmailSyncState(
        this.runtime.agentId,
        "google",
        previous.grantId,
        "owner",
      );
    }
    await assertPaused();
    return this.store.advance({
      operationId,
      expectedRevision,
      expectedPhase: "disposing_imports",
      phase: "resuming",
      receipt: {
        importedDataDisposition: {
          disposition: record.review.importedData,
          grantId: previous.grantId,
          connectorAccountId: previous.connectorAccountId,
          providerMutation: false,
        },
      },
    });
  }

  private changed(): ElizaError {
    return new ElizaError(
      "The reviewed accounts or handoff pause changed. Reload the handoff before removing imported data.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
