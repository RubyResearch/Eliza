/**
 * Binds family correspondence proposals and owner decisions to accessible source
 * documents. Every disclosure resolves the current review and source again;
 * cached facts never confer permission after withdrawal or a document change.
 * The authenticated owner boundary supplies the access context, never request JSON.
 */
import { createHash } from "node:crypto";
import {
  type AccessContext,
  DocumentService,
  ElizaError,
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import { z } from "zod";
import {
  type FamilyIntakeFact,
  type FamilyIntakeReview,
  FamilyIntakeReviewStore,
} from "./intake-review.js";

export interface FamilyIntakeFactBinding {
  reviewId: string;
  reviewRevision: number;
  factId: string;
}

export interface ReviewedFamilyIntakeFact {
  binding: FamilyIntakeFactBinding;
  source: FamilyIntakeReview["source"];
  reviewedAt: string;
  fact: FamilyIntakeFact;
}

export interface FamilyIntakeReviewDetails {
  review: FamilyIntakeReview;
  title: string | null;
  sourceStatus: { state: "ready" } | { state: "unavailable"; message: string };
  factsForReview: FamilyIntakeFact[];
  excludedFactIds: string[];
  requestHistory: Array<
    NonNullable<FamilyIntakeReview["requestDecision"]> & {
      revision: number;
      recordedAt: string;
      recordedBy: string | null;
      statement: string;
    }
  >;
}

type DocumentReader = Pick<DocumentService, "getDocumentByIdWithAccessContext">;

function fail(message: string, code: string): never {
  throw new ElizaError(message, { code });
}

/** Canonical-document reads and private proposal review for one authenticated owner. */
export class FamilyIntakeService {
  constructor(
    private readonly store: FamilyIntakeReviewStore,
    private readonly documents: DocumentReader,
    private readonly owner: AccessContext,
  ) {
    if (
      owner.role !== "OWNER" ||
      owner.isOwner !== true ||
      validateUuid(owner.requesterEntityId) === null
    )
      fail(
        "Family intake requires the authenticated owner",
        "FAMILY_INTAKE_OWNER_REQUIRED",
      );
  }

  private async source(documentId: string): Promise<{
    documentId: UUID;
    text: string;
    contentSha256: string;
    title: string | null;
  }> {
    const id = validateUuid(documentId);
    if (!id)
      fail("Select a valid document identifier", "FAMILY_INTAKE_INPUT_INVALID");
    const document = await this.documents.getDocumentByIdWithAccessContext(
      id,
      this.owner,
    );
    if (!document || document.id !== id)
      fail(
        "The selected document is unavailable to this owner",
        "FAMILY_INTAKE_SOURCE_UNAVAILABLE",
      );
    const metadata = z
      .object({
        ingestionState: z.literal("ready"),
        contentType: z.string(),
        title: z.string().optional(),
      })
      .safeParse(document.metadata);
    if (!metadata.success)
      fail(
        "Finish document ingestion before selecting correspondence",
        "FAMILY_INTAKE_SOURCE_NOT_READY",
      );
    // Binary document text can contain encoded bytes. Correspondence intake
    // requires the canonical complete text record, not a binary payload or fragments.
    if (metadata.data.contentType !== "text/plain")
      fail(
        "Select the complete plain-text correspondence document",
        "FAMILY_INTAKE_SOURCE_FORMAT_UNSUPPORTED",
      );
    const text = document.content.text;
    if (typeof text !== "string" || text.trim().length === 0)
      fail(
        "The selected document has no complete correspondence text",
        "FAMILY_INTAKE_SOURCE_EMPTY",
      );
    return {
      documentId: id,
      title: metadata.data.title ?? null,
      text,
      contentSha256: createHash("sha256").update(text).digest("hex"),
    };
  }

  async select(input: {
    id: string;
    periodKey: string;
    documentId: string;
  }): Promise<FamilyIntakeReview> {
    const source = await this.source(input.documentId);
    return this.store.select({
      id: input.id,
      periodKey: input.periodKey,
      selectedByEntityId: this.owner.requesterEntityId,
      source: {
        documentId: source.documentId,
        contentSha256: source.contentSha256,
      },
    });
  }

  async list(
    periodKey: string,
    includeEarlier = false,
  ): Promise<FamilyIntakeReview[]> {
    const reviews = includeEarlier
      ? await this.store.listThrough(periodKey)
      : await this.store.list(periodKey);
    if (
      reviews.some(
        (review) => review.selectedByEntityId !== this.owner.requesterEntityId,
      )
    )
      fail(
        "The selected correspondence belongs to another owner",
        "FAMILY_INTAKE_OWNER_REQUIRED",
      );
    return reviews;
  }

  async describe(periodKey: string): Promise<FamilyIntakeReviewDetails[]> {
    const reviews = await this.list(periodKey, true);
    const details = await Promise.all(
      reviews.map(async (review) => {
        const history = await this.store.history(review.id);
        // Keep older request sources accessible after resolution or withdrawal,
        // so owners can inspect or reopen them without finding an old packet.
        if (
          review.periodKey !== periodKey &&
          !history.some(
            (version) =>
              version.status === "reviewed" &&
              version.facts.some((fact) => fact.unanswered),
          )
        )
          return null;
        const selection = [...history]
          .reverse()
          .find(
            (version) =>
              version.status === "selected" &&
              version.revision <= review.revision,
          );
        if (!selection)
          fail(
            "The source selection history is invalid",
            "FAMILY_INTAKE_STORAGE_INVALID",
          );
        const proposal = [...history]
          .reverse()
          .find(
            (version) =>
              version.status === "proposed" &&
              version.revision > selection.revision &&
              version.revision <= review.revision,
          );
        const reviewedFacts = new Map(
          review.facts.map((fact) => [fact.id, fact]),
        );
        const factsForReview = (proposal?.facts ?? []).map((fact) => {
          const included = reviewedFacts.get(fact.id);
          if (included) return included;
          const prior = [...history]
            .reverse()
            .filter(
              (version) =>
                version.status === "reviewed" &&
                version.revision > selection.revision,
            )
            .flatMap((version) => version.facts)
            .find((value) => value.id === fact.id);
          // Restoring an excluded fact retains its explicit request state but
          // never restores an old recipient grant or silently reopens it.
          return {
            ...fact,
            unanswered: prior ? prior.unanswered : fact.unanswered,
            recipientEntityIds: [],
          };
        });
        const excludedFactIds =
          review.status === "reviewed"
            ? factsForReview
                .filter((fact) => !reviewedFacts.has(fact.id))
                .map((fact) => fact.id)
            : [];
        let title: string | null = null;
        let sourceStatus: FamilyIntakeReviewDetails["sourceStatus"] = {
          state: "ready",
        };
        try {
          const source = await this.source(review.source.documentId);
          title = source.title;
          if (source.contentSha256 !== review.source.contentSha256)
            fail(
              "The source changed. Withdraw this review and select the new version.",
              "FAMILY_INTAKE_SOURCE_CHANGED",
            );
        } catch (cause) {
          // error-policy:J4 Expected source failures retain withdrawal and review history with an explicit unavailable state.
          if (
            !(cause instanceof ElizaError) ||
            ![
              "FAMILY_INTAKE_SOURCE_UNAVAILABLE",
              "FAMILY_INTAKE_SOURCE_NOT_READY",
              "FAMILY_INTAKE_SOURCE_FORMAT_UNSUPPORTED",
              "FAMILY_INTAKE_SOURCE_EMPTY",
              "FAMILY_INTAKE_SOURCE_CHANGED",
            ].includes(cause.code)
          )
            throw cause;
          sourceStatus = { state: "unavailable", message: cause.message };
        }
        const requestHistory = history.flatMap((version) => {
          const decision = version.requestDecision;
          if (!decision) return [];
          const fact = version.facts.find(
            (value) => value.id === decision.factId,
          );
          if (!fact)
            fail(
              "Request history is missing its reviewed fact",
              "FAMILY_INTAKE_STORAGE_INVALID",
            );
          return [
            {
              ...decision,
              revision: version.revision,
              recordedAt: version.updatedAt,
              recordedBy: version.reviewedByEntityId,
              statement: fact.statement,
            },
          ];
        });
        return {
          review,
          title,
          sourceStatus,
          factsForReview,
          excludedFactIds,
          requestHistory,
        };
      }),
    );
    return details.filter((value) => value !== null);
  }

  private async current(
    id: string,
    revision: number,
    allowWithdrawn = false,
  ): Promise<FamilyIntakeReview> {
    const review = await this.store.read(id);
    if (
      !review ||
      review.revision !== revision ||
      (review.status === "withdrawn" && !allowWithdrawn)
    )
      fail(
        "The selected correspondence changed; review it again",
        "FAMILY_INTAKE_REVIEW_CONFLICT",
      );
    if (review.selectedByEntityId !== this.owner.requesterEntityId)
      fail(
        "The selected correspondence belongs to another owner",
        "FAMILY_INTAKE_OWNER_REQUIRED",
      );
    return review;
  }

  async withdraw(
    id: string,
    expectedRevision: number,
  ): Promise<FamilyIntakeReview> {
    const review = await this.current(id, expectedRevision, true);
    return this.store.withdraw(review.id, review.revision);
  }

  async reselect(
    id: string,
    expectedRevision: number,
  ): Promise<FamilyIntakeReview> {
    const review = await this.current(id, expectedRevision, true);
    if (review.status !== "withdrawn")
      fail(
        "Withdraw the old review before selecting a new source revision",
        "FAMILY_INTAKE_REVIEW_CONFLICT",
      );
    const source = await this.source(review.source.documentId);
    return this.store.reselect({
      id,
      expectedRevision,
      sourceSha256: source.contentSha256,
    });
  }

  private async validateSource(review: FamilyIntakeReview): Promise<string> {
    const source = await this.source(review.source.documentId);
    if (source.contentSha256 !== review.source.contentSha256)
      fail(
        "The source document changed; withdraw and select its new revision",
        "FAMILY_INTAKE_SOURCE_CHANGED",
      );
    return source.text;
  }

  /** Full source text for extraction; callers must not shorten model input. */
  async extractionInput(id: string, revision: number): Promise<string> {
    const review = await this.current(id, revision);
    if (review.status !== "selected")
      fail(
        "This selection already has a proposal",
        "FAMILY_INTAKE_REVIEW_CONFLICT",
      );
    return this.validateSource(review);
  }

  async propose(input: {
    id: string;
    expectedRevision: number;
    facts: readonly FamilyIntakeFact[];
  }): Promise<FamilyIntakeReview> {
    const review = await this.current(input.id, input.expectedRevision);
    const text = await this.validateSource(review);
    for (const fact of input.facts) {
      if (!text.includes(fact.sourceQuote))
        fail(
          "A proposed citation does not occur in the selected document",
          "FAMILY_INTAKE_CITATION_INVALID",
        );
    }
    return this.store.propose({
      ...input,
      sourceSha256: review.source.contentSha256,
    });
  }

  async review(input: {
    id: string;
    expectedRevision: number;
    facts: readonly FamilyIntakeFact[];
  }): Promise<FamilyIntakeReview> {
    const review = await this.current(input.id, input.expectedRevision);
    await this.validateSource(review);
    return this.store.review({
      ...input,
      reviewerEntityId: this.owner.requesterEntityId,
    });
  }

  async validateReviewedSource(id: string, revision: number): Promise<void> {
    const review = await this.current(id, revision);
    if (review.status !== "reviewed")
      fail(
        "Finish reviewing this source first",
        "FAMILY_INTAKE_REVIEW_CONFLICT",
      );
    await this.validateSource(review);
  }

  async decideRequest(
    input: Omit<
      Parameters<FamilyIntakeReviewStore["decideRequest"]>[0],
      "reviewerEntityId"
    >,
  ): Promise<FamilyIntakeReview> {
    const latest = await this.store.read(input.id);
    if (!latest)
      fail(
        "The selected source no longer exists",
        "FAMILY_INTAKE_REVIEW_CONFLICT",
      );
    const review = await this.current(input.id, latest.revision);
    await this.validateSource(review);
    return this.store.decideRequest({
      ...input,
      reviewerEntityId: this.owner.requesterEntityId,
    });
  }

  async reviewedFacts(periodKey: string): Promise<ReviewedFamilyIntakeFact[]> {
    const facts: ReviewedFamilyIntakeFact[] = [];
    for (const review of await this.store.listThrough(periodKey)) {
      if (review.status !== "reviewed") continue;
      const eligible = review.facts.filter(
        (fact) => review.periodKey === periodKey || fact.unanswered,
      );
      if (eligible.length === 0) continue;
      await this.current(review.id, review.revision);
      await this.validateSource(review);
      for (const fact of eligible)
        facts.push({
          binding: {
            reviewId: review.id,
            reviewRevision: review.revision,
            factId: fact.id,
          },
          source: review.source,
          reviewedAt: review.updatedAt,
          fact,
        });
    }
    return facts;
  }

  /** Revalidate immediately before external projection and canonical dispatch. */
  async validateDisclosure(
    binding: FamilyIntakeFactBinding,
    recipientEntityId: string,
  ): Promise<ReviewedFamilyIntakeFact> {
    const review = await this.current(binding.reviewId, binding.reviewRevision);
    if (review.status !== "reviewed")
      fail(
        "Correspondence has not been reviewed",
        "FAMILY_INTAKE_REVIEW_REQUIRED",
      );
    await this.validateSource(review);
    const fact = review.facts.find(
      (candidate) => candidate.id === binding.factId,
    );
    if (!fact?.recipientEntityIds.includes(recipientEntityId))
      fail(
        "This recipient is not authorized for the reviewed fact",
        "FAMILY_INTAKE_RECIPIENT_DENIED",
      );
    return {
      binding,
      source: review.source,
      reviewedAt: review.updatedAt,
      fact,
    };
  }
}

/** Resolve only for authenticated owner operations and canonical owner workers. */
export function getFamilyIntakeService(
  runtime: IAgentRuntime,
): FamilyIntakeService {
  return new FamilyIntakeService(
    new FamilyIntakeReviewStore(runtime),
    {
      async getDocumentByIdWithAccessContext(id, context) {
        const documents = runtime.getService<DocumentService>(
          DocumentService.serviceType,
        );
        if (
          !documents ||
          typeof documents.getDocumentByIdWithAccessContext !== "function"
        )
          fail(
            "The canonical document service is unavailable",
            "FAMILY_INTAKE_SOURCE_UNAVAILABLE",
          );
        return documents.getDocumentByIdWithAccessContext(id, context);
      },
    },
    {
      requesterEntityId: resolveOwnerEntityIdOrDefault(runtime),
      role: "OWNER",
      isOwner: true,
    },
  );
}
