/** Browser transport for private correspondence intake and immutable owner reviews. */
import type {
  FamilyIntakeFact,
  FamilyIntakeReview,
} from "../../lifeops/family-coordination/intake-review.js";
import type { FamilyIntakeReviewDetails } from "../../lifeops/family-coordination/intake-service.js";
import type { FamilyInterviewAnswer } from "../../lifeops/family-coordination/interview.js";
import { familyOperationsRequest } from "./adapter.js";

export interface FamilyIntakeAdapter {
  decideRequest(
    id: string,
    expectedRevision: number,
    decision: NonNullable<FamilyIntakeReview["requestDecision"]>,
  ): Promise<FamilyIntakeReview>;
  answerInterview(input: FamilyInterviewAnswer): Promise<FamilyIntakeReview>;
  list(period: string): Promise<FamilyIntakeReviewDetails[]>;
  importSource(input: {
    id: string;
    periodKey: string;
    title: string;
    text: string;
  }): Promise<FamilyIntakeReview>;
  change(
    id: string,
    operation: "extract" | "withdraw" | "reselect",
    expectedRevision: number,
  ): Promise<FamilyIntakeReview>;
  review(
    id: string,
    expectedRevision: number,
    facts: readonly FamilyIntakeFact[],
  ): Promise<FamilyIntakeReview>;
}
const root = "/api/lifeops/family-workflows/intake";
async function post(path: string, body: object): Promise<FamilyIntakeReview> {
  const result = await familyOperationsRequest<{ review: FamilyIntakeReview }>(
    path,
    { method: "POST", body: JSON.stringify(body) },
  );
  return result.review;
}
export const defaultFamilyIntakeAdapter: FamilyIntakeAdapter = {
  decideRequest: (id, expectedRevision, decision) =>
    post(`${root}/${encodeURIComponent(id)}/request-decision`, {
      expectedRevision,
      decision,
    }),
  async list(period) {
    const result = await familyOperationsRequest<{
      sources: FamilyIntakeReviewDetails[];
    }>(`${root}?period=${encodeURIComponent(period)}`);
    return result.sources;
  },
  answerInterview: (input) => post(`${root}/interview`, input),
  importSource: (input) => post(`${root}/import`, input),
  change: (id, operation, expectedRevision) =>
    post(`${root}/${encodeURIComponent(id)}/${operation}`, {
      expectedRevision,
    }),
  review: (id, expectedRevision, facts) =>
    post(`${root}/${encodeURIComponent(id)}/review`, {
      expectedRevision,
      facts,
    }),
};
