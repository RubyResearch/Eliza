/**
 * Applies one owner-reviewed calendar mapping per durable handoff checkpoint.
 * Stable operation keys recover a committed mapping after an interrupted receipt
 * write; completed mappings are never replayed after later control revisions.
 */
import { createHash } from "node:crypto";
import { ApprovalDispatchControlStore } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import { z } from "zod";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
} from "./account-handoff-store.js";

const controlReceipt = z.object({
  controlRevision: z.number().int().nonnegative(),
  operationKey: z.string().min(1),
});
const admissionReceipt = z.object({
  approvalRevision: z.number().int().nonnegative(),
  calendarRevision: z.number().int().nonnegative(),
});

export class AccountHandoffCalendarMappings {
  private readonly store: AccountHandoffStore;
  private readonly approvals: ApprovalDispatchControlStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly ownerEntityId: string,
    private readonly calendar: Pick<
      CalendarService,
      | "getLinkedCalendarControl"
      | "executeLinkedCalendarControl"
      | "executeLinkedCalendarRebind"
      | "executeLinkedCalendarRetainLocal"
    >,
    private readonly requestUrl: URL,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
    this.approvals = new ApprovalDispatchControlStore(runtime);
  }

  async applyNext(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (
      record.phase !== "applying_mappings" ||
      record.revision !== expectedRevision
    )
      throw this.changed();
    const admission = admissionReceipt.parse(record.receipt.admissionPaused);
    const assertApprovalPaused = async () => {
      const current = await this.approvals.read(this.ownerEntityId);
      if (!current.paused || current.revision !== admission.approvalRevision)
        throw this.changed();
    };
    await assertApprovalPaused();
    const destination = record.review.writeCalendar;
    if (!record.receipt.mappingDestination) {
      const operationKey = this.key(operationId, "destination", "");
      const selected = await this.calendar.executeLinkedCalendarControl(
        this.requestUrl,
        {
          operation: "select",
          expectedRevision: admission.calendarRevision,
          idempotencyKey: operationKey,
          destination: destination
            ? {
                connectorAccountId: destination.connectorAccountId,
                providerCalendarId: destination.calendarId,
              }
            : null,
        },
      );
      await assertApprovalPaused();
      return this.store.checkpointMappingDestination({
        operationId,
        expectedRevision,
        receipt: { controlRevision: selected.revision, operationKey },
      });
    }
    let expectedControlRevision = controlReceipt.parse(
      record.receipt.mappingDestination,
    ).controlRevision;
    for (const reviewed of record.review.calendarLinks) {
      const saved = record.receipt[`mapping:${reviewed.linkId}`];
      if (saved) {
        expectedControlRevision = controlReceipt.parse(saved).controlRevision;
        continue;
      }
      const operationKey = this.key(operationId, "link", reviewed.linkId);
      const input = {
        expectedUpdatedAt: reviewed.expectedUpdatedAt,
        expectedLocalRevision: reviewed.expectedLocalRevision,
        expectedControlRevision,
        idempotencyKey: operationKey,
        retainPreviousProviderEvent: true as const,
      };
      let controlRevision: number;
      if (reviewed.disposition === "retain_local") {
        const retained = await this.calendar.executeLinkedCalendarRetainLocal(
          reviewed.linkId,
          input,
        );
        controlRevision = retained.controlRevision;
      } else {
        if (!destination) throw this.changed();
        const rebound = await this.calendar.executeLinkedCalendarRebind(
          this.requestUrl,
          reviewed.linkId,
          {
            ...input,
            connectorAccountId: destination.connectorAccountId,
            providerCalendarId: destination.calendarId,
          },
        );
        controlRevision = rebound.controlRevision;
      }
      await assertApprovalPaused();
      return this.store.checkpointMapping({
        operationId,
        expectedRevision,
        receipt: {
          linkId: reviewed.linkId,
          disposition: reviewed.disposition,
          operationKey,
          controlRevision,
        },
      });
    }
    const control = await this.calendar.getLinkedCalendarControl();
    if (
      !control.paused ||
      control.pendingDispatch ||
      control.revision !== expectedControlRevision
    )
      throw this.changed();
    await assertApprovalPaused();
    return this.store.advance({
      operationId,
      expectedRevision,
      expectedPhase: "applying_mappings",
      phase: "verifying_replacement",
      receipt: { mappingsComplete: { controlRevision: control.revision } },
    });
  }

  private key(
    operationId: string,
    kind: "destination" | "link",
    item: string,
  ): string {
    return `account-handoff:mapping:${createHash("sha256")
      .update(
        JSON.stringify([
          this.runtime.agentId,
          this.ownerEntityId,
          operationId,
          kind,
          item,
        ]),
      )
      .digest("hex")}`;
  }
  private changed(): ElizaError {
    return new ElizaError(
      "The reviewed handoff or its pause ownership changed. Reload before continuing.",
      { code: "ACCOUNT_HANDOFF_CONFLICT" },
    );
  }
}
