/** Synthetic source lifecycle for browser form acceptance; persistence, ACL and extraction are tested separately against the real runtime. */
import type { FamilyIntakeAdapter } from "../../src/components/family-operations/intake-adapter.js";
import type {
  FamilyIntakeFact,
  FamilyIntakeReview,
} from "../../src/lifeops/family-coordination/intake-review.js";

import type { FamilyIntakeReviewDetails } from "../../src/lifeops/family-coordination/intake-service.js";

export function createFamilyIntakeFixture(): FamilyIntakeAdapter {
  let current: FamilyIntakeReview | null = null;
  let answerSource: FamilyIntakeReviewDetails | null = null;
  let firstAnswer: string | null = null;
  let firstDecision: string | null = null;
  let title = "";
  let sourceText = "";
  let firstImportId: string | null = null;
  let proposals: FamilyIntakeFact[] = [];
  function requireReview(id: string, revision: number): FamilyIntakeReview {
    if (!current || current.id !== id || current.revision !== revision) {
      throw new Error("Source review changed. Reload before saving.");
    }
    return current;
  }
  return {
    async decideRequest(id, revision, decision) {
      if (
        !answerSource ||
        answerSource.review.id !== id ||
        answerSource.review.revision !== revision
      )
        throw new Error("Request source changed. Reload before saving.");
      if (firstDecision === null) {
        firstDecision = JSON.stringify(decision);
        throw new Error(
          "Synthetic resolution save interrupted. Retry your reason.",
        );
      }
      if (
        decision.state === "resolved" &&
        JSON.stringify(decision) !== firstDecision
      )
        throw new Error("Resolution retry changed its identity or reason.");
      const facts = answerSource.review.facts.map((fact) =>
        fact.id === decision.factId
          ? { ...fact, unanswered: decision.state === "open" }
          : fact,
      );
      const decisionFact = facts.find((fact) => fact.id === decision.factId);
      if (!decisionFact) throw new Error("Unknown request fact");
      answerSource = {
        ...answerSource,
        review: {
          ...answerSource.review,
          revision: revision + 1,
          facts,
          requestDecision: decision,
        },
        factsForReview: facts,
        requestHistory: [
          ...answerSource.requestHistory,
          {
            ...decision,
            revision: revision + 1,
            recordedAt: "2026-09-11T12:00:00.000Z",
            recordedBy: "fixture-owner",
            statement: decisionFact.statement,
          },
        ],
      };
      return structuredClone(answerSource.review);
    },
    async answerInterview(input) {
      const payload = JSON.stringify(input);
      if (firstAnswer === null) {
        firstAnswer = payload;
        throw new Error(
          "Synthetic answer save interrupted. Retry your answer.",
        );
      }
      if (firstAnswer !== payload)
        throw new Error(
          "Answer retry changed its operation identity or content.",
        );
      const statement =
        input.answer.kind === "update"
          ? input.answer.text
          : "No additional updates in this synthetic answer.";
      const fact: FamilyIntakeFact = {
        id: input.id,
        section: input.section,
        statement,
        sourceQuote: statement,
        dates: [],
        requests: [],
        commitments: [],
        accountability: [],
        urgency: null,
        unanswered: input.answer.kind === "update" && input.answer.unanswered,
        recipientEntityIds: input.recipientEntityIds,
      };
      const review: FamilyIntakeReview = {
        id: input.id,
        periodKey: input.periodKey,
        selectedByEntityId: "fixture-owner",
        source: {
          documentId: "fixture-answer-document",
          contentSha256: "b".repeat(64),
        },
        revision: 3,
        status: "reviewed",
        facts: [fact],
        reviewedByEntityId: "fixture-owner",
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:00:00.000Z",
      };
      answerSource = {
        review,
        title: "Owner interview answer",
        sourceStatus: { state: "ready" },
        factsForReview: [fact],
        requestHistory: [],
        excludedFactIds: [],
      };
      return structuredClone(review);
    },
    async list(period) {
      const answers =
        answerSource?.review.periodKey === period
          ? [structuredClone(answerSource)]
          : [];
      if (!current || current.periodKey !== period) return answers;
      const review = structuredClone(current);
      return [
        ...answers,
        {
          review,
          title,
          sourceStatus: { state: "ready" },
          factsForReview: proposals.map(
            (fact) =>
              review.facts.find((saved) => saved.id === fact.id) ??
              structuredClone(fact),
          ),
          requestHistory: [],
          excludedFactIds:
            review.status === "reviewed"
              ? proposals
                  .filter(
                    (fact) =>
                      !review.facts.some((saved) => saved.id === fact.id),
                  )
                  .map((fact) => fact.id)
              : [],
        },
      ];
    },
    async importSource(input) {
      if (firstImportId === null) {
        firstImportId = input.id;
        throw new Error("Synthetic connection interrupted. Retry this source.");
      }
      if (firstImportId !== input.id)
        throw new Error("Retry changed the import identity.");
      title = input.title;
      sourceText = input.text;
      current = {
        id: input.id,
        periodKey: input.periodKey,
        selectedByEntityId: "fixture-owner",
        source: {
          documentId: "fixture-document",
          contentSha256: "a".repeat(64),
        },
        revision: 1,
        status: "selected",
        facts: [],
        reviewedByEntityId: null,
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:00:00.000Z",
      };
      return structuredClone(current);
    },
    async change(id, operation, revision) {
      const previous = requireReview(id, revision);
      if (operation === "extract") {
        proposals = [
          {
            id: "fixture-fact",
            section: "unanswered",
            statement: "Confirm Friday pickup.",
            sourceQuote: sourceText,
            dates: [],
            requests: ["Confirm pickup"],
            commitments: [],
            accountability: [],
            urgency: null,
            unanswered: true,
            recipientEntityIds: [],
          },
        ];
      } else if (operation === "reselect") proposals = [];
      current = {
        ...previous,
        revision: revision + 1,
        status:
          operation === "extract"
            ? "proposed"
            : operation === "withdraw"
              ? "withdrawn"
              : "selected",
        facts: operation === "extract" ? structuredClone(proposals) : [],
        reviewedByEntityId: null,
      };
      return structuredClone(current);
    },
    async review(id, revision, facts) {
      const previous = requireReview(id, revision);
      current = {
        ...previous,
        revision: revision + 1,
        status: "reviewed",
        reviewedByEntityId: previous.selectedByEntityId,
        facts: structuredClone([...facts]),
      };
      return structuredClone(current);
    },
  };
}
