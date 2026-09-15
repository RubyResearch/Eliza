/**
 * Assembles an owner-selected account switch from current service facts before
 * saving its review. Recipient and source checkpoints are resumable; no account,
 * calendar preference, approval, or delivery control changes during review.
 */
import { createApprovalQueue } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import type {
  LifeOpsCalendarEvent,
  LifeOpsLinkedCalendarLink,
} from "@elizaos/shared";
import { z } from "zod";
import {
  type AccountHandoffRetirementCandidate,
  assertGoogleHandoffApprovalSelection,
  requiredGoogleHandoffApprovals,
} from "./account-handoff-approval-inventory.js";
import {
  accountHandoffGoogleChoicesSchema,
  deriveAccountHandoffGoogleReview,
} from "./account-handoff-google-review.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import { AccountHandoffSourceSelection } from "./account-handoff-source-selection.js";
import {
  AccountHandoffStore,
  accountHandoffReviewSchema,
} from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

const identity = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !value.includes("\0"));
export const accountHandoffChoicesSchema = accountHandoffGoogleChoicesSchema
  .extend({
    operationId: identity,
    messageDestinations: z
      .array(
        accountHandoffReviewSchema.shape.messageDestinations.element
          .extend({
            recipientEntityId: identity,
          })
          .strict(),
      )
      .refine(
        (destinations) =>
          new Set(
            destinations.map((destination) =>
              JSON.stringify([
                destination.channel,
                destination.connectorAccountId,
                destination.recipientId,
              ]),
            ),
          ).size === destinations.length,
      ),
    importedData: accountHandoffReviewSchema.shape.importedData,
    retireApprovalIds: z
      .array(z.uuid())
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export type AccountHandoffChoices = z.infer<typeof accountHandoffChoicesSchema>;

export interface AccountHandoffCalendarEntry {
  link: LifeOpsLinkedCalendarLink;
  /** Null marks a missing local event; it must not appear as an empty healthy event. */
  event: LifeOpsCalendarEvent | null;
}

export class AccountHandoffReviewService {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly accounts: Pick<
      LifeOpsGoogleService,
      "getGoogleConnectorAccounts"
    >,
    private readonly calendar: Pick<
      CalendarService,
      | "listCalendars"
      | "listLinkedCalendarEvents"
      | "setCalendarIncluded"
      | "getLinkedCalendarControl"
      | "getCalendarEventById"
    >,
    private readonly requestUrl: URL,
  ) {}

  async retirementCandidates(
    previousGrantId: string,
  ): Promise<AccountHandoffRetirementCandidate[]> {
    const account = await this.previousAccount(previousGrantId);
    const grantId = account.id;
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const requests = await queue.list({
      subjectUserId: this.ownerEntityId,
      state: null,
      action: null,
    });
    return requiredGoogleHandoffApprovals(requests, grantId).map((request) => ({
      id: request.id,
      action: request.action,
      payload: request.payload,
      channel: request.channel,
      state: request.state,
      reason: request.reason,
      expiresAt: request.expiresAt.toISOString(),
    }));
  }

  async calendarEntries(
    previousGrantId: string,
  ): Promise<AccountHandoffCalendarEntry[]> {
    const account = await this.previousAccount(previousGrantId);
    const links = await this.calendar.listLinkedCalendarEvents();
    return Promise.all(
      links
        .filter(
          (link) => link.connectorAccountId === account.connectorAccountId,
        )
        .map(async (link) => ({
          link,
          event: await this.calendar.getCalendarEventById(link.localEventId),
        })),
    );
  }

  private async previousAccount(previousGrantId: string) {
    const grantId = identity.parse(previousGrantId);
    const accounts = await this.accounts.getGoogleConnectorAccounts(
      this.requestUrl,
      "owner",
    );
    const matches = accounts.filter((account) => account.grant?.id === grantId);
    const account = matches[0];
    if (
      matches.length !== 1 ||
      !account?.connected ||
      account.mode !== "local" ||
      account.side !== "owner" ||
      account.grant?.agentId !== this.runtime.agentId ||
      account.grant.provider !== "google" ||
      !account.grant.connectorAccountId ||
      account.grant.side !== "owner" ||
      account.grant.mode !== "local"
    ) {
      throw new ElizaError(
        "Choose an available owner Google account before reviewing the account switch.",
        {
          code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
        },
      );
    }
    return account.grant;
  }

  async create(input: z.infer<typeof accountHandoffChoicesSchema>) {
    const choices = accountHandoffChoicesSchema.parse(input);
    const google = await deriveAccountHandoffGoogleReview(
      this.runtime.agentId,
      this.requestUrl,
      {
        previousGrantId: choices.previousGrantId,
        replacementGrantId: choices.replacementGrantId,
        readCalendarIds: choices.readCalendarIds,
        writeCalendarId: choices.writeCalendarId,
        calendarLinks: choices.calendarLinks,
      },
      this.accounts,
      this.calendar,
    );
    const destinations = choices.messageDestinations.map(
      ({ recipientEntityId: _entity, ...destination }) => destination,
    );
    if (
      destinations.some(
        (destination) =>
          destination.channel === "email" &&
          destination.connectorAccountId !==
            google.replacement.connectorAccountId,
      )
    ) {
      throw new ElizaError(
        "Choose the replacement account for reviewed email delivery.",
        {
          code: "ACCOUNT_HANDOFF_REVIEW_CHANGED",
        },
      );
    }
    const recipients = new AccountHandoffRecipients(
      this.runtime,
      this.ownerEntityId,
    );
    const entityIds = choices.messageDestinations.map(
      (destination) => destination.recipientEntityId,
    );
    await recipients.resolve(destinations, entityIds);
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    assertGoogleHandoffApprovalSelection(
      await queue.list({
        subjectUserId: this.ownerEntityId,
        state: null,
        action: null,
      }),
      google.previous.grantId,
      choices.retireApprovalIds,
    );
    for (const id of choices.retireApprovalIds) {
      const approval = await queue.byId(id, this.ownerEntityId);
      if (
        !approval ||
        approval.state === "executing" ||
        approval.state === "reconciliation_required"
      ) {
        throw new ElizaError(
          "A selected approval is unavailable or has an unresolved delivery. Refresh the review.",
          {
            code: "ACCOUNT_HANDOFF_APPROVAL_UNAVAILABLE",
          },
        );
      }
    }
    const store = new AccountHandoffStore(this.runtime, this.ownerEntityId);
    let record = await store.review(choices.operationId, {
      ...google,
      messageDestinations: destinations,
      importedData: choices.importedData,
      retireApprovalIds: choices.retireApprovalIds,
    });
    record = await recipients.capture(
      record.operationId,
      record.revision,
      entityIds,
    );
    return new AccountHandoffSourceSelection(
      this.runtime,
      this.ownerEntityId,
      this.calendar,
      this.requestUrl,
    ).capture(record.operationId, record.revision);
  }
}
