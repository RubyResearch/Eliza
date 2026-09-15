/**
 * Persists an owner's exact account-handoff review and ordered checkpoints.
 * Conditional writes prevent stale tabs from replacing an active review or
 * advancing a step twice. Saved receipt values cannot be overwritten by later
 * steps. Receipts survive process restarts; connector effects
 * must be verified by the coordinator before it advances their checkpoint.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  executeRawSql,
  type LifeOpsDatabaseContext,
  sqlJson,
  sqlText,
} from "./sql.js";

const identity = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !value.includes("\0"));
const googleAccount = z
  .object({
    grantId: identity,
    connectorAccountId: identity,
    email: z.email(),
  })
  .strict();
const calendar = z
  .object({
    grantId: identity,
    connectorAccountId: identity,
    calendarId: identity,
  })
  .strict();

export const accountHandoffReviewSchema = z
  .object({
    previous: googleAccount,
    replacement: googleAccount,
    readCalendars: z.array(calendar),
    writeCalendar: calendar.nullable(),
    calendarLinks: z
      .array(
        z
          .object({
            linkId: identity,
            expectedUpdatedAt: z.iso.datetime({ offset: true }),
            expectedLocalRevision: z.number().int().nonnegative(),
            disposition: z.enum(["retain_local", "copy_to_replacement"]),
          })
          .strict(),
      )
      .refine(
        (links) =>
          new Set(links.map((link) => link.linkId)).size === links.length,
        "Review each calendar link only once",
      ),
    messageDestinations: z.array(
      z
        .object({
          channel: z.enum(["imessage", "telegram", "discord", "email"]),
          connectorAccountId: identity,
          recipientId: identity,
        })
        .strict(),
    ),
    importedData: z.enum(["retain", "remove_previous_account_imports"]),
    retireApprovalIds: z.array(identity),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      !review.writeCalendar &&
      review.calendarLinks.some(
        (link) => link.disposition === "copy_to_replacement",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Select a writable replacement calendar before copying linked events",
      });
    }

    if (
      review.previous.grantId === review.replacement.grantId ||
      review.previous.connectorAccountId ===
        review.replacement.connectorAccountId ||
      review.previous.email.toLowerCase() ===
        review.replacement.email.toLowerCase()
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose different previous and replacement accounts",
      });
    }
    for (const selected of [
      ...review.readCalendars,
      ...(review.writeCalendar ? [review.writeCalendar] : []),
    ]) {
      if (
        selected.grantId !== review.replacement.grantId ||
        selected.connectorAccountId !== review.replacement.connectorAccountId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Reviewed calendars must belong to the replacement account",
        });
      }
    }
  });

const phaseSchema = z.enum([
  "reviewed",
  "pausing",
  "draining",
  "retiring_approvals",
  "applying_mappings",
  "verifying_replacement",
  "disconnecting_previous",
  "disposing_imports",
  "resuming",
  "completed",
  "cancelled",
]);
export type AccountHandoffReview = z.infer<typeof accountHandoffReviewSchema>;
export type AccountHandoffPhase = z.infer<typeof phaseSchema>;
const receiptSchema = z.record(z.string(), z.json());
type AccountHandoffReceipt = z.infer<typeof receiptSchema>;

export interface AccountHandoffRecord {
  operationId: string;
  revision: number;
  phase: AccountHandoffPhase;
  review: AccountHandoffReview;
  receipt: AccountHandoffReceipt;
}
const nextPhase: Partial<Record<AccountHandoffPhase, AccountHandoffPhase>> = {
  reviewed: "pausing",
  pausing: "draining",
  draining: "retiring_approvals",
  retiring_approvals: "applying_mappings",
  applying_mappings: "verifying_replacement",
  verifying_replacement: "disconnecting_previous",
  disconnecting_previous: "disposing_imports",
  disposing_imports: "resuming",
  resuming: "completed",
};

function decode(row: Record<string, unknown>): AccountHandoffRecord {
  return {
    operationId: identity.parse(row.operation_id),
    revision: z.number().int().nonnegative().parse(row.revision),
    phase: phaseSchema.parse(row.phase),
    review: accountHandoffReviewSchema.parse(
      JSON.parse(z.string().parse(row.review_json)),
    ),
    receipt: receiptSchema.parse(
      JSON.parse(z.string().parse(row.receipt_json)),
    ),
  };
}

const mappingReceiptSchema = z
  .object({
    linkId: identity,
    disposition: z.enum(["retain_local", "copy_to_replacement"]),
    operationKey: identity,
    controlRevision: z.number().int().nonnegative(),
  })
  .strict();
type HandoffCheckpointMutation = {
  operationId: string;
  expectedRevision: number;
  expectedPhase: AccountHandoffPhase;
  phase: AccountHandoffPhase;
  receipt: AccountHandoffReceipt;
};

export const handoffReadSourceReviewSchema = z
  .array(
    z
      .object({
        calendarId: identity,
        expectedVersion: z.number().int().nonnegative(),
        initiallyIncluded: z.boolean(),
        included: z.boolean(),
      })
      .strict(),
  )
  .refine(
    (sources) =>
      new Set(sources.map((source) => source.calendarId)).size ===
      sources.length,
  );

export const handoffRecipientBindingsSchema = z.array(
  accountHandoffReviewSchema.shape.messageDestinations.element
    .extend({
      recipientEntityId: identity,
      identityPlatform: identity,
      identityHandle: identity,
      identityConnectorAccountId: identity,
    })
    .strict(),
);

export class AccountHandoffStore {
  constructor(
    private readonly db: LifeOpsDatabaseContext,
    private readonly ownerEntityId: string,
  ) {
    identity.parse(ownerEntityId);
  }

  private scope(): string {
    return `agent_id = ${sqlText(this.db.agentId)} AND owner_entity_id = ${sqlText(this.ownerEntityId)}`;
  }

  async read(operationId: string): Promise<AccountHandoffRecord | null> {
    const rows = await executeRawSql(
      this.db,
      `SELECT * FROM app_lifeops.life_account_handoffs
      WHERE ${this.scope()} AND operation_id = ${sqlText(identity.parse(operationId))}`,
    );
    return rows.length ? decode(rows[0]) : null;
  }

  async active(): Promise<AccountHandoffRecord | null> {
    const rows = await executeRawSql(
      this.db,
      `SELECT * FROM app_lifeops.life_account_handoffs
      WHERE ${this.scope()} AND phase NOT IN ('completed', 'cancelled')`,
    );
    return rows.length ? decode(rows[0]) : null;
  }

  async review(
    operationId: string,
    input: AccountHandoffReview,
  ): Promise<AccountHandoffRecord> {
    identity.parse(operationId);
    const review = accountHandoffReviewSchema.parse(input);
    const rows = await executeRawSql(
      this.db,
      `INSERT INTO app_lifeops.life_account_handoffs
      (agent_id, owner_entity_id, operation_id, review_json)
      VALUES (${sqlText(this.db.agentId)}, ${sqlText(this.ownerEntityId)}, ${sqlText(operationId)}, ${sqlJson(review)})
      ON CONFLICT DO NOTHING RETURNING *`,
    );
    if (rows.length) return decode(rows[0]);
    const existing = await this.read(operationId);
    if (existing && JSON.stringify(existing.review) === JSON.stringify(review))
      return existing;
    throw this.conflict();
  }

  async cancelReviewed(
    operationId: string,
    expectedRevision: number,
  ): Promise<AccountHandoffRecord> {
    const record = await this.read(operationId);
    if (
      record?.phase === "cancelled" &&
      record.revision === expectedRevision + 1
    )
      return record;
    return this.advance({
      operationId,
      expectedRevision,
      expectedPhase: "reviewed",
      phase: "cancelled",
      receipt: {},
    });
  }

  async advance(
    input: HandoffCheckpointMutation,
  ): Promise<AccountHandoffRecord> {
    identity.parse(input.operationId);
    z.number().int().min(0).max(2_147_483_646).parse(input.expectedRevision);
    if (
      nextPhase[input.expectedPhase] !== input.phase &&
      !(input.expectedPhase === "reviewed" && input.phase === "cancelled")
    ) {
      throw new ElizaError("Account handoff steps must complete in order", {
        code: "ACCOUNT_HANDOFF_STEP_INVALID",
      });
    }
    if (
      input.expectedPhase === "applying_mappings" &&
      input.phase === "verifying_replacement"
    ) {
      const record = await this.read(input.operationId);
      if (
        !record ||
        record.revision !== input.expectedRevision ||
        record.phase !== input.expectedPhase
      )
        throw this.conflict();
      for (const link of record.review.calendarLinks) {
        const parsed = mappingReceiptSchema.safeParse(
          record.receipt[`mapping:${link.linkId}`],
        );
        if (
          !parsed.success ||
          parsed.data.linkId !== link.linkId ||
          parsed.data.disposition !== link.disposition
        )
          throw new ElizaError(
            "Finish every reviewed calendar mapping before verifying the replacement",
            { code: "ACCOUNT_HANDOFF_MAPPINGS_INCOMPLETE" },
          );
      }
    }
    return this.writeCheckpoint(input);
  }

  async checkpointGoogleVerification(input: {
    operationId: string;
    expectedRevision: number;
    receipt: {
      connectorAccountId: string;
      grantId: string;
      email: string;
      calendarIds: string[];
      writableCalendarId: string | null;
      gmailHistoryId: string | null;
      checkedAt: string;
    };
  }): Promise<AccountHandoffRecord> {
    const receipt = z
      .object({
        connectorAccountId: identity,
        grantId: identity,
        email: z.email(),
        calendarIds: z.array(identity),
        writableCalendarId: identity.nullable(),
        gmailHistoryId: identity.nullable(),
        checkedAt: z.iso.datetime(),
      })
      .strict()
      .parse(input.receipt);
    const record = await this.read(input.operationId);
    if (
      !record ||
      record.revision !== input.expectedRevision ||
      record.phase !== "verifying_replacement"
    )
      throw this.conflict();
    const selected = new Set([
      ...record.review.readCalendars.map((calendar) => calendar.calendarId),
      ...(record.review.writeCalendar
        ? [record.review.writeCalendar.calendarId]
        : []),
    ]);
    if (
      receipt.connectorAccountId !==
        record.review.replacement.connectorAccountId ||
      receipt.grantId !== record.review.replacement.grantId ||
      receipt.email.toLowerCase() !==
        record.review.replacement.email.toLowerCase() ||
      receipt.writableCalendarId !==
        (record.review.writeCalendar?.calendarId ?? null) ||
      selected.size !== receipt.calendarIds.length ||
      receipt.calendarIds.some((id) => !selected.has(id)) ||
      new Set(receipt.calendarIds).size !== receipt.calendarIds.length ||
      (record.review.messageDestinations.some(
        (destination) => destination.channel === "email",
      ) &&
        !receipt.gmailHistoryId)
    )
      throw this.conflict();
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "verifying_replacement",
      phase: "verifying_replacement",
      receipt: { googleVerification: receipt },
    });
  }

  async checkpointRecipientReview(input: {
    operationId: string;
    expectedRevision: number;
    bindings: z.infer<typeof handoffRecipientBindingsSchema>;
  }): Promise<AccountHandoffRecord> {
    const bindings = handoffRecipientBindingsSchema.parse(input.bindings);
    const record = await this.read(input.operationId);
    if (!record) throw this.conflict();
    if (
      record.phase !== "reviewed" ||
      record.revision !== input.expectedRevision ||
      bindings.length !== record.review.messageDestinations.length
    )
      throw this.conflict();
    for (const [index, binding] of bindings.entries()) {
      const destination = record.review.messageDestinations[index];
      if (
        !destination ||
        binding.channel !== destination.channel ||
        binding.connectorAccountId !== destination.connectorAccountId ||
        binding.recipientId !== destination.recipientId
      )
        throw this.conflict();
    }
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "reviewed",
      phase: "reviewed",
      receipt: { recipientReview: bindings },
    });
  }

  async checkpointReadSourceReview(input: {
    operationId: string;
    expectedRevision: number;
    sources: z.infer<typeof handoffReadSourceReviewSchema>;
  }): Promise<AccountHandoffRecord> {
    const sources = handoffReadSourceReviewSchema.parse(input.sources);
    const record = await this.read(input.operationId);
    if (!record) throw this.conflict();
    if (
      record.phase !== "reviewed" ||
      record.revision !== input.expectedRevision
    )
      throw this.conflict();
    const selected = new Set(
      record.review.readCalendars.map((source) => source.calendarId),
    );
    const included = sources.filter((source) => source.included);
    if (
      included.length !== selected.size ||
      included.some((source) => !selected.has(source.calendarId))
    )
      throw this.conflict();
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "reviewed",
      phase: "reviewed",
      receipt: { readSourceReview: sources },
    });
  }

  async checkpointReadSourceSelection(input: {
    operationId: string;
    expectedRevision: number;
    calendarId: string;
    verifiedVersion: number;
  }): Promise<AccountHandoffRecord> {
    const calendarId = identity.parse(input.calendarId);
    const verifiedVersion = z
      .number()
      .int()
      .nonnegative()
      .parse(input.verifiedVersion);
    const record = await this.read(input.operationId);
    if (!record) throw this.conflict();
    if (
      record.phase !== "verifying_replacement" ||
      record.revision !== input.expectedRevision
    )
      throw this.conflict();
    const sources = handoffReadSourceReviewSchema.parse(
      record.receipt.readSourceReview,
    );
    const source = sources.find((entry) => entry.calendarId === calendarId);
    if (
      !source ||
      verifiedVersion !==
        source.expectedVersion +
          (source.initiallyIncluded === source.included ? 0 : 1)
    )
      throw this.conflict();
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "verifying_replacement",
      phase: "verifying_replacement",
      receipt: {
        [`readSource:${calendarId}`]: {
          included: source.included,
          verifiedVersion,
        },
      },
    });
  }

  async checkpointMappingDestination(input: {
    operationId: string;
    expectedRevision: number;
    receipt: { controlRevision: number; operationKey: string };
  }): Promise<AccountHandoffRecord> {
    const receipt = z
      .object({
        controlRevision: z.number().int().nonnegative(),
        operationKey: identity,
      })
      .strict()
      .parse(input.receipt);
    const record = await this.read(input.operationId);
    if (
      !record ||
      record.revision !== input.expectedRevision ||
      record.phase !== "applying_mappings"
    )
      throw this.conflict();
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "applying_mappings",
      phase: "applying_mappings",
      receipt: { mappingDestination: receipt },
    });
  }

  async checkpointMapping(input: {
    operationId: string;
    expectedRevision: number;
    receipt: z.infer<typeof mappingReceiptSchema>;
  }): Promise<AccountHandoffRecord> {
    const receipt = mappingReceiptSchema.parse(input.receipt);
    const record = await this.read(input.operationId);
    if (
      !record ||
      record.revision !== input.expectedRevision ||
      record.phase !== "applying_mappings"
    )
      throw this.conflict();
    const reviewed = record.review.calendarLinks.find(
      (link) => link.linkId === receipt.linkId,
    );
    if (!reviewed || reviewed.disposition !== receipt.disposition)
      throw new ElizaError(
        "This calendar mapping was not part of the saved review",
        { code: "ACCOUNT_HANDOFF_MAPPING_NOT_REVIEWED" },
      );
    return this.writeCheckpoint({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedPhase: "applying_mappings",
      phase: "applying_mappings",
      receipt: { [`mapping:${receipt.linkId}`]: receipt },
    });
  }

  private async writeCheckpoint(
    input: HandoffCheckpointMutation,
  ): Promise<AccountHandoffRecord> {
    identity.parse(input.operationId);
    z.number().int().min(0).max(2_147_483_646).parse(input.expectedRevision);
    const rows = await executeRawSql(
      this.db,
      `UPDATE app_lifeops.life_account_handoffs
      SET phase = ${sqlText(input.phase)}, revision = revision + 1,
        receipt_json = (receipt_json::jsonb || ${sqlJson(receiptSchema.parse(input.receipt))}::jsonb)::text, updated_at = NOW()
      WHERE ${this.scope()} AND operation_id = ${sqlText(input.operationId)}
        AND revision = ${input.expectedRevision} AND phase = ${sqlText(input.expectedPhase)}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(${sqlJson(receiptSchema.parse(input.receipt))}::jsonb) AS incoming
          JOIN jsonb_each(receipt_json::jsonb) AS saved USING (key)
          WHERE incoming.value IS DISTINCT FROM saved.value
        ) RETURNING *`,
    );
    if (rows.length) return decode(rows[0]);
    throw this.conflict();
  }

  private conflict(): ElizaError {
    return new ElizaError(
      "An account handoff changed or is already active. Reload its saved review before continuing.",
      {
        code: "ACCOUNT_HANDOFF_CONFLICT",
      },
    );
  }
}
