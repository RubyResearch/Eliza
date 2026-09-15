/**
 * Captures calendar source versions for the owner review and applies one saved
 * choice per checkpoint using CalendarService's canonical compare-and-set path.
 * Readback recovers a lost checkpoint; later source or pause changes are conflicts.
 */
import { ApprovalDispatchControlStore } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import { z } from "zod";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
  handoffReadSourceReviewSchema,
} from "./account-handoff-store.js";

export class AccountHandoffSourceSelection {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  constructor(
    runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      "listCalendars" | "setCalendarIncluded" | "getLinkedCalendarControl"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
    this.approvals = new ApprovalDispatchControlStore(runtime);
  }

  async capture(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (record.phase !== "reviewed" || record.revision !== expectedRevision)
      throw this.changed();
    if (record.receipt.readSourceReview) return record;
    const sources = await this.list(record);
    const selected = new Set(
      record.review.readCalendars.map((source) => source.calendarId),
    );
    if (
      [...selected].some(
        (id) => !sources.some((source) => source.calendarId === id),
      )
    )
      throw this.changed();
    return this.store.checkpointReadSourceReview({
      operationId,
      expectedRevision,
      sources: sources.map((source) => ({
        calendarId: source.calendarId,
        expectedVersion: source.selectionVersion,
        initiallyIncluded: source.includeInFeed,
        included: selected.has(source.calendarId),
      })),
    });
  }

  async applyNext(
    operationId: string,
    expectedRevision: number,
  ): Promise<{ handoff: AccountHandoffRecord; complete: boolean }> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (
      record.phase !== "verifying_replacement" ||
      record.revision !== expectedRevision
    )
      throw this.changed();
    const reviewed = handoffReadSourceReviewSchema.safeParse(
      record.receipt.readSourceReview,
    );
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
    if (!reviewed.success || !controls.success) throw this.changed();
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
    const sources = await this.list(record);
    if (sources.length !== reviewed.data.length) throw this.changed();
    for (const source of reviewed.data) {
      const current = sources.find(
        (entry) => entry.calendarId === source.calendarId,
      );
      if (!current) throw this.changed();
      const afterVersion =
        source.expectedVersion +
        (source.initiallyIncluded === source.included ? 0 : 1);
      const saved = record.receipt[`readSource:${source.calendarId}`];
      if (saved) {
        const receipt = z
          .object({
            included: z.boolean(),
            verifiedVersion: z.number().int().nonnegative(),
          })
          .safeParse(saved);
        if (
          !receipt.success ||
          receipt.data.included !== source.included ||
          receipt.data.verifiedVersion !== afterVersion ||
          current.selectionVersion !== afterVersion ||
          current.includeInFeed !== source.included
        )
          throw this.changed();
      } else if (
        !(
          current.selectionVersion === source.expectedVersion &&
          current.includeInFeed === source.initiallyIncluded
        ) &&
        !(
          current.selectionVersion === afterVersion &&
          current.includeInFeed === source.included
        )
      ) {
        throw this.changed();
      }
    }
    const next = reviewed.data.find(
      (source) => !record.receipt[`readSource:${source.calendarId}`],
    );
    if (!next) {
      await assertPaused();
      return { handoff: record, complete: true };
    }
    const current = sources.find(
      (source) => source.calendarId === next.calendarId,
    );
    if (!current) throw this.changed();
    await assertPaused();
    if (current.includeInFeed !== next.included) {
      await this.calendar.setCalendarIncluded(this.requestUrl, {
        provider: "google",
        mode: "local",
        side: "owner",
        grantId: record.review.replacement.grantId,
        connectorAccountId: record.review.replacement.connectorAccountId,
        calendarId: next.calendarId,
        expectedVersion: next.expectedVersion,
        includeInFeed: next.included,
      });
    }
    const verified = (await this.list(record)).find(
      (source) => source.calendarId === next.calendarId,
    );
    const verifiedVersion =
      next.expectedVersion + (next.initiallyIncluded === next.included ? 0 : 1);
    if (
      !verified ||
      verified.includeInFeed !== next.included ||
      verified.selectionVersion !== verifiedVersion
    )
      throw this.changed();
    await assertPaused();
    return {
      handoff: await this.store.checkpointReadSourceSelection({
        operationId,
        expectedRevision,
        calendarId: next.calendarId,
        verifiedVersion,
      }),
      complete: false,
    };
  }

  private async list(record: AccountHandoffRecord) {
    const sources = await this.calendar.listCalendars(this.requestUrl, {
      mode: "local",
      side: "owner",
      grantId: record.review.replacement.grantId,
    });
    if (
      sources.some(
        (source) =>
          source.provider !== "google" ||
          source.side !== "owner" ||
          source.grantId !== record.review.replacement.grantId ||
          source.connectorAccountId !==
            record.review.replacement.connectorAccountId,
      ) ||
      new Set(sources.map((source) => source.calendarId)).size !==
        sources.length
    )
      throw this.changed();
    return sources;
  }

  private changed(): ElizaError {
    return new ElizaError(
      "Calendar choices or handoff ownership changed. Reload the saved review before continuing.",
      {
        code: "ACCOUNT_HANDOFF_SOURCE_SELECTION_CONFLICT",
      },
    );
  }
}
