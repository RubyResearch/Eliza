/**
 * Records explicit owner interview answers as canonical private sources and
 * reviewed facts. Durable intake revisions make interrupted retries resumable;
 * answers cannot authorize agreement obligations or silently resolve old requests.
 */
import { isDeepStrictEqual } from "node:util";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import { importFamilyCorrespondence } from "./intake-import.js";
import {
  type FamilyIntakeFact,
  type FamilyIntakeReview,
  familyIntakeIdSchema,
  familyRecipientEntityIdSchema,
} from "./intake-review.js";
import { getFamilyIntakeService } from "./intake-service.js";

const nonempty = z.string().refine((value) => value.trim().length > 0);
export const familyInterviewAnswerSchema = z.strictObject({
  id: familyIntakeIdSchema,
  periodKey: z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/u),
  section: z.enum([
    "custody_calendar",
    "school",
    "travel_consent_health",
    "unanswered",
  ]),
  answer: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("update"),
      text: nonempty,
      unanswered: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("no_additional_updates") }),
  ]),
  recipientEntityIds: z
    .array(familyRecipientEntityIdSchema)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Recipient identities must be unique",
    ),
});

export type FamilyInterviewAnswer = z.infer<typeof familyInterviewAnswerSchema>;

const topics = {
  custody_calendar: "parenting schedule",
  school: "school or extracurricular activities",
  travel_consent_health: "travel, consent, or health",
  unanswered: "unanswered requests",
} as const;

export async function recordFamilyInterviewAnswer(
  runtime: IAgentRuntime,
  input: z.infer<typeof familyInterviewAnswerSchema>,
): Promise<FamilyIntakeReview> {
  const parsed = familyInterviewAnswerSchema.parse(input);
  const topic = topics[parsed.section];
  const statement =
    parsed.answer.kind === "update"
      ? parsed.answer.text
      : `I have no additional updates about ${topic} to add for ${parsed.periodKey}.`;
  // Bind the complete operation, including sharing choices, to immutable source
  // text. The factual quote is separate from these private operation details.
  const text = `Owner interview response\n${JSON.stringify(parsed)}\n\nOwner statement:\n${statement}`;
  let review = await importFamilyCorrespondence(runtime, {
    id: parsed.id,
    periodKey: parsed.periodKey,
    title: `Owner response: ${topic} (${parsed.periodKey})`,
    text,
  });
  if (review.status === "withdrawn")
    throw new ElizaError(
      "This answer was withdrawn; use a new answer identity to record another response",
      { code: "FAMILY_INTAKE_REVIEW_CONFLICT" },
    );
  const fact: FamilyIntakeFact = {
    id: parsed.id,
    section: parsed.section,
    statement,
    sourceQuote: statement,
    dates: [],
    requests: [],
    commitments: [],
    accountability: [],
    urgency: null,
    unanswered: parsed.answer.kind === "update" && parsed.answer.unanswered,
    recipientEntityIds: [],
  };
  const intake = getFamilyIntakeService(runtime);
  if (review.status === "selected")
    review = await intake.propose({
      id: review.id,
      expectedRevision: review.revision,
      facts: [fact],
    });
  if (review.status === "proposed") {
    if (!isDeepStrictEqual(review.facts, [fact]))
      throw new ElizaError(
        "This answer's proposal changed; review it before continuing",
        { code: "FAMILY_INTAKE_REVIEW_CONFLICT" },
      );
    review = await intake.review({
      id: review.id,
      expectedRevision: review.revision,
      facts: [{ ...fact, recipientEntityIds: parsed.recipientEntityIds }],
    });
  }
  // A completed retry returns the latest review, preserving any later owner edit.
  // Source authorization and content are checked again, including on retries.
  await intake.validateReviewedSource(review.id, review.revision);
  return review;
}
