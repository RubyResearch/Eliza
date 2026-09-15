/**
 * Removes only the reviewed old Google account after handoff verification.
 * Provider/account readback precedes the durable checkpoint so an interrupted
 * removal can resume without resolving credentials that were already deleted.
 * This phase retains imported data and keeps both dispatch controls paused.
 */
import { ApprovalDispatchControlStore } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google-workspace";
import { z } from "zod";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import { verifyAccountHandoffReadSources } from "./account-handoff-read-sources.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

export class AccountHandoffDisconnect {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      "getLinkedCalendarControl" | "listCalendars"
    >,
    private readonly accounts: Pick<
      LifeOpsGoogleService,
      | "getGoogleConnectorStatus"
      | "getGoogleConnectorAccounts"
      | "disconnectGoogleConnector"
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
    if (
      record.phase !== "disconnecting_previous" ||
      record.revision !== expectedRevision ||
      !record.receipt.googleVerification
    )
      throw this.changed();
    const controls = z
      .object({
        admission: z.object({
          approvalRevision: z.number().int().nonnegative(),
        }),
        mappings: z.object({ controlRevision: z.number().int().nonnegative() }),
      })
      .safeParse({
        admission: record.receipt.admissionPaused,
        mappings: record.receipt.mappingsComplete,
      });
    if (!controls.success) throw this.changed();
    const assertPaused = async () => {
      const approval = await this.approvals.read(this.ownerEntityId);
      const calendar = await this.calendar.getLinkedCalendarControl();
      if (
        !approval.paused ||
        approval.revision !== controls.data.admission.approvalRevision ||
        !calendar.paused ||
        calendar.pendingDispatch ||
        calendar.revision !== controls.data.mappings.controlRevision
      )
        throw this.changed();
    };
    await assertPaused();
    const previous = record.review.previous;
    const accounts = await this.accounts.getGoogleConnectorAccounts(
      this.requestUrl,
      "owner",
    );
    const matches = accounts.filter(
      ({ grant }) =>
        grant &&
        (grant.id === previous.grantId ||
          grant.connectorAccountId === previous.connectorAccountId),
    );
    if (matches.length > 1) throw this.changed();
    const old = matches[0]?.grant;
    if (
      old &&
      (old.agentId !== this.runtime.agentId ||
        old.provider !== "google" ||
        old.mode !== "local" ||
        old.side !== "owner" ||
        old.id !== previous.grantId ||
        old.connectorAccountId !== previous.connectorAccountId ||
        old.identityEmail?.toLowerCase() !== previous.email.toLowerCase())
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
    await assertPaused();
    await new AccountHandoffRecipients(this.runtime, this.ownerEntityId).verify(
      operationId,
      expectedRevision,
    );
    if (old) {
      await this.accounts.disconnectGoogleConnector(
        {
          mode: "local",
          side: "owner",
          grantId: previous.grantId,
          purgeImportedData: false,
        },
        this.requestUrl,
      );
    }
    const remaining = await this.accounts.getGoogleConnectorAccounts(
      this.requestUrl,
      "owner",
    );
    if (
      remaining.some(
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
    await assertPaused();
    return this.store.advance({
      operationId,
      expectedRevision,
      expectedPhase: "disconnecting_previous",
      phase: "disposing_imports",
      receipt: { previousDisconnected: { ...previous } },
    });
  }

  private changed(): ElizaError {
    return new ElizaError(
      "The reviewed handoff, account identity or pause changed. Reload the handoff before disconnecting an account.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
