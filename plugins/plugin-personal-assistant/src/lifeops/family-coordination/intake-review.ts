/**
 * Persists versioned owner review of selected correspondence for a family packet.
 * Source bytes remain in the canonical document store. Each proposal and review
 * retains the selected document hash; consumers must revalidate that source and
 * this review revision before including a fact in an external draft or dispatch.
 */
import { ElizaError, validateUuid } from "@elizaos/core";
import { z } from "zod";
import { normalizeHouseholdIdentifier } from "../household/types.js";
import {
  executeRawSql,
  type LifeOpsDatabaseContext,
  parseJsonValue,
  sqlQuote,
} from "../sql.js";
import type { FamilyPacketSection } from "./monthly-packet.js";

/** Core-generated identities need not carry an RFC UUID version nibble. */
export const familyIntakeIdSchema = z
  .string()
  .refine(
    (value) => validateUuid(value) !== null,
    "Invalid entity or document identifier",
  );

/** Graph contacts use opaque identities, including owner-confirmed email IDs. */
export const familyRecipientEntityIdSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return normalizeHouseholdIdentifier(value, "recipientEntityId");
    } catch {
      // error-policy:J3 Reject malformed identifiers without inventing a recipient.
      ctx.addIssue({
        code: "custom",
        message: "Select a valid recipient identity",
      });
      return z.NEVER;
    }
  });

const sections = [
  "custody_calendar",
  "school",
  "travel_consent_health",
  "unanswered",
] as const satisfies readonly FamilyPacketSection[];
const nonempty = z.string().refine((value) => value.trim().length > 0);
export const familyRequestDecisionSchema = z.strictObject({
  operationId: familyIntakeIdSchema,
  factId: familyIntakeIdSchema,
  state: z.enum(["resolved", "open"]),
  reason: nonempty,
});
const sourceSchema = z.strictObject({
  documentId: familyIntakeIdSchema,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const factSchema = z.strictObject({
  id: familyIntakeIdSchema,
  section: z.enum(sections),
  statement: nonempty,
  sourceQuote: nonempty,
  dates: z.array(nonempty),
  requests: z.array(nonempty),
  commitments: z.array(nonempty),
  accountability: z.array(nonempty),
  urgency: nonempty.nullable(),
  unanswered: z.boolean(),
  recipientEntityIds: z.array(familyRecipientEntityIdSchema),
});
export const familyIntakeExtractionSchema = z.strictObject({
  facts: z.array(factSchema.omit({ id: true, recipientEntityIds: true })),
});
export const familyIntakeFactsSchema = z
  .array(factSchema)
  .superRefine((facts, ctx) => {
    if (new Set(facts.map((fact) => fact.id)).size !== facts.length)
      ctx.addIssue({
        code: "custom",
        message: "Fact identities must be unique",
      });
    for (const fact of facts) {
      if (
        new Set(fact.recipientEntityIds).size !== fact.recipientEntityIds.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Recipient identities must be unique",
        });
    }
  });
const selectionSchema = z.strictObject({
  id: familyIntakeIdSchema,
  periodKey: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  selectedByEntityId: familyIntakeIdSchema,
  source: sourceSchema,
});
// Approved agreement obligations are owned by AgreementKnowledgeService;
// selecting correspondence cannot create that authority.
const recordSchema = selectionSchema
  .extend({
    revision: z.number().int().positive(),
    status: z.enum(["selected", "proposed", "reviewed", "withdrawn"]),
    facts: familyIntakeFactsSchema,
    reviewedByEntityId: familyIntakeIdSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    requestDecision: familyRequestDecisionSchema.optional(),
  })
  .superRefine((review, ctx) => {
    const reviewer = review.reviewedByEntityId;
    if (
      (review.status === "selected" && review.facts.length > 0) ||
      ((review.status === "selected" || review.status === "proposed") &&
        reviewer !== null) ||
      (review.status === "proposed" &&
        review.facts.some((fact) => fact.recipientEntityIds.length > 0)) ||
      (review.status === "reviewed" &&
        reviewer !== review.selectedByEntityId) ||
      (reviewer !== null && reviewer !== review.selectedByEntityId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Review state and disclosure authority are inconsistent",
      });
    }
  });

export type FamilyIntakeSelection = z.infer<typeof selectionSchema>;
export type FamilyIntakeFact = z.infer<typeof factSchema>;
export type FamilyIntakeReview = z.infer<typeof recordSchema>;

function invalidInput(cause: z.ZodError): never {
  throw new ElizaError("The selected source or reviewed facts are invalid", {
    code: "FAMILY_INTAKE_INPUT_INVALID",
    cause,
  });
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function readRecord(row: Record<string, unknown>): FamilyIntakeReview {
  const result = recordSchema.safeParse(parseJsonValue(row.review_json, null));
  if (!result.success)
    throw new ElizaError("Stored family intake review is invalid", {
      code: "FAMILY_INTAKE_STORAGE_INVALID",
      cause: result.error,
    });
  return result.data;
}

/** One tenant-scoped selection per document and target month, with CAS edits. */
export class FamilyIntakeReviewStore {
  private initialized = false;

  constructor(
    private readonly runtime: LifeOpsDatabaseContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await executeRawSql(
      this.runtime,
      "CREATE SCHEMA IF NOT EXISTS app_lifeops",
    );
    await executeRawSql(
      this.runtime,
      `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_intake_reviews (
      agent_id TEXT NOT NULL, id TEXT NOT NULL, period_key TEXT NOT NULL,
      document_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL, review_json JSONB NOT NULL,
      PRIMARY KEY (agent_id,id,revision), UNIQUE (agent_id,period_key,document_id,revision)
    )`,
    );
    this.initialized = true;
  }

  async read(id: string): Promise<FamilyIntakeReview | null> {
    parseInput(familyIntakeIdSchema, id);
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT review_json FROM app_lifeops.life_family_intake_reviews
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND id=${sqlQuote(id)} ORDER BY revision DESC LIMIT 1`,
    );
    return rows[0] ? readRecord(rows[0]) : null;
  }

  async history(id: string): Promise<FamilyIntakeReview[]> {
    parseInput(familyIntakeIdSchema, id);
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT review_json FROM app_lifeops.life_family_intake_reviews
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND id=${sqlQuote(id)}
       ORDER BY revision ASC`,
    );
    return rows.map(readRecord);
  }

  async list(periodKey: string): Promise<FamilyIntakeReview[]> {
    return this.listForPeriod(periodKey, false);
  }

  /** Current source decisions through a packet month, including unresolved older facts. */
  async listThrough(periodKey: string): Promise<FamilyIntakeReview[]> {
    return this.listForPeriod(periodKey, true);
  }

  private async listForPeriod(
    periodKey: string,
    includeEarlier: boolean,
  ): Promise<FamilyIntakeReview[]> {
    parseInput(selectionSchema.shape.periodKey, periodKey);
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT DISTINCT ON (id) review_json FROM app_lifeops.life_family_intake_reviews
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key${includeEarlier ? "<=" : "="}${sqlQuote(periodKey)}
       ORDER BY id, revision DESC`,
    );
    return rows.map(readRecord);
  }

  async select(input: FamilyIntakeSelection): Promise<FamilyIntakeReview> {
    const selection = parseInput(selectionSchema, input);
    await this.ensureSchema();
    const now = this.now().toISOString();
    const review: FamilyIntakeReview = {
      ...selection,
      revision: 1,
      status: "selected",
      facts: [],
      reviewedByEntityId: null,
      createdAt: now,
      updatedAt: now,
    };
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_intake_reviews
       (agent_id,id,period_key,document_id,revision,status,review_json)
       VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(selection.id)},${sqlQuote(selection.periodKey)},${sqlQuote(selection.source.documentId)},1,'selected',${sqlQuote(JSON.stringify(review))}::jsonb)
       ON CONFLICT DO NOTHING RETURNING review_json`,
    );
    if (rows[0]) return readRecord(rows[0]);
    const existing = await this.read(selection.id);
    if (
      existing &&
      existing.periodKey === selection.periodKey &&
      existing.selectedByEntityId === selection.selectedByEntityId &&
      existing.source.documentId === selection.source.documentId &&
      existing.source.contentSha256 === selection.source.contentSha256
    )
      return existing;
    throw new ElizaError(
      "This source was already selected or the selection identity was reused; reload the current review",
      {
        code: "FAMILY_INTAKE_SELECTION_CONFLICT",
        context: { selectionId: selection.id },
      },
    );
  }

  async propose(args: {
    id: string;
    expectedRevision: number;
    sourceSha256: string;
    facts: readonly FamilyIntakeFact[];
  }): Promise<FamilyIntakeReview> {
    const facts = parseInput(familyIntakeFactsSchema, args.facts);
    const current = await this.requireCurrent(args.id, args.expectedRevision);
    if (
      current.status !== "selected" ||
      current.source.contentSha256 !== args.sourceSha256
    )
      this.conflict(args.id);
    // Extraction cannot grant recipients; only the subsequent owner review can.
    if (facts.some((fact) => fact.recipientEntityIds.length > 0))
      throw new ElizaError(
        "Extracted facts must remain private until owner review",
        {
          code: "FAMILY_INTAKE_PROPOSAL_DISCLOSURE_INVALID",
        },
      );
    return this.replace(current, { ...current, status: "proposed", facts });
  }

  async review(args: {
    id: string;
    expectedRevision: number;
    reviewerEntityId: string;
    facts: readonly FamilyIntakeFact[];
  }): Promise<FamilyIntakeReview> {
    const facts = parseInput(familyIntakeFactsSchema, args.facts);
    const reviewer = parseInput(familyIntakeIdSchema, args.reviewerEntityId);
    const current = await this.requireCurrent(args.id, args.expectedRevision);
    if (current.status !== "proposed" && current.status !== "reviewed")
      this.conflict(args.id);
    if (reviewer !== current.selectedByEntityId)
      throw new ElizaError("Only the selecting owner can review this source", {
        code: "FAMILY_INTAKE_REVIEWER_MISMATCH",
      });
    const history = await this.history(args.id);
    const proposal = [...history]
      .reverse()
      .find(
        (revision) =>
          revision.status === "proposed" &&
          revision.revision <= current.revision,
      );
    if (!proposal) this.conflict(args.id);
    if (
      current.status === "reviewed" &&
      facts.some((fact) => {
        const prior = [...history]
          .reverse()
          .filter(
            (version) =>
              version.status === "reviewed" &&
              version.revision > proposal.revision,
          )
          .flatMap((version) => version.facts)
          .find((value) => value.id === fact.id);
        return prior && prior.unanswered !== fact.unanswered;
      })
    )
      throw new ElizaError(
        "Resolve or reopen this request with an explicit reason",
        {
          code: "FAMILY_INTAKE_REQUEST_DECISION_REQUIRED",
        },
      );
    const proposals = new Map(proposal.facts.map((fact) => [fact.id, fact]));
    if (
      facts.some(
        (fact) => proposals.get(fact.id)?.sourceQuote !== fact.sourceQuote,
      )
    )
      throw new ElizaError(
        "Review cannot introduce a fact without a selected source proposal",
        {
          code: "FAMILY_INTAKE_UNPROPOSED_FACT",
        },
      );
    return this.replace(current, {
      ...current,
      status: "reviewed",
      facts,
      reviewedByEntityId: reviewer,
    });
  }

  async withdraw(
    id: string,
    expectedRevision: number,
  ): Promise<FamilyIntakeReview> {
    const current = await this.requireCurrent(id, expectedRevision);
    if (current.status === "withdrawn") return current;
    return this.replace(current, { ...current, status: "withdrawn" });
  }

  async decideRequest(args: {
    id: string;
    expectedRevision: number;
    reviewerEntityId: string;
    decision: z.infer<typeof familyRequestDecisionSchema>;
  }): Promise<FamilyIntakeReview> {
    const decision = parseInput(familyRequestDecisionSchema, args.decision);
    const reviewer = parseInput(familyIntakeIdSchema, args.reviewerEntityId);
    parseInput(z.number().int().positive(), args.expectedRevision);
    const current = await this.read(args.id);
    if (!current || current.status !== "reviewed") this.conflict(args.id);
    if (current.selectedByEntityId !== reviewer)
      throw new ElizaError(
        "Only the selecting owner can resolve this request",
        {
          code: "FAMILY_INTAKE_REVIEWER_MISMATCH",
        },
      );
    if (
      current.revision === args.expectedRevision + 1 &&
      current.requestDecision &&
      JSON.stringify(current.requestDecision) === JSON.stringify(decision)
    )
      return current;
    if (current.revision !== args.expectedRevision) this.conflict(args.id);
    if (
      (await this.history(args.id)).some(
        (revision) =>
          revision.requestDecision?.operationId === decision.operationId,
      )
    )
      this.conflict(args.id);
    const fact = current.facts.find((value) => value.id === decision.factId);
    if (!fact || fact.unanswered === (decision.state === "open"))
      this.conflict(args.id);
    return this.replace(
      current,
      {
        ...current,
        facts: current.facts.map((value) =>
          value.id === decision.factId
            ? { ...value, unanswered: decision.state === "open" }
            : value,
        ),
        reviewedByEntityId: reviewer,
      },
      decision,
    );
  }

  async reselect(args: {
    id: string;
    expectedRevision: number;
    sourceSha256: string;
  }): Promise<FamilyIntakeReview> {
    const digest = parseInput(
      sourceSchema.shape.contentSha256,
      args.sourceSha256,
    );
    const current = await this.requireCurrent(args.id, args.expectedRevision);
    if (current.status !== "withdrawn") this.conflict(args.id);
    return this.replace(current, {
      ...current,
      source: { ...current.source, contentSha256: digest },
      status: "selected",
      facts: [],
      reviewedByEntityId: null,
    });
  }

  private conflict(id: string): never {
    throw new ElizaError(
      "The intake review changed; reload it before continuing",
      {
        code: "FAMILY_INTAKE_REVIEW_CONFLICT",
        context: { selectionId: id },
      },
    );
  }

  private async requireCurrent(
    id: string,
    expectedRevision: number,
  ): Promise<FamilyIntakeReview> {
    parseInput(z.number().int().positive(), expectedRevision);
    const current = await this.read(id);
    if (!current || current.revision !== expectedRevision) this.conflict(id);
    return current;
  }

  private async replace(
    current: FamilyIntakeReview,
    next: FamilyIntakeReview,
    decision?: z.infer<typeof familyRequestDecisionSchema>,
  ): Promise<FamilyIntakeReview> {
    const value = parseInput(recordSchema, {
      ...next,
      requestDecision: decision,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    // Immutable revisions retain the original proposal and owner decisions. The
    // unique next-revision key arbitrates concurrent inserts, including across
    // PostgreSQL processes; a losing edit cannot append or overwrite history.
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_intake_reviews
       (agent_id,id,period_key,document_id,revision,status,review_json)
       SELECT ${sqlQuote(this.runtime.agentId)},${sqlQuote(value.id)},${sqlQuote(value.periodKey)},${sqlQuote(value.source.documentId)},${value.revision},${sqlQuote(value.status)},${sqlQuote(JSON.stringify(value))}::jsonb
       WHERE (SELECT MAX(revision) FROM app_lifeops.life_family_intake_reviews
         WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND id=${sqlQuote(current.id)})=${current.revision}
       ON CONFLICT DO NOTHING RETURNING review_json`,
    );
    if (!rows[0]) this.conflict(current.id);
    return readRecord(rows[0]);
  }
}
