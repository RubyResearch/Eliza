/** Exercises the model-output boundary against complete page evidence, including fabricated and mislocated citations. */
import { describe, expect, it } from "vitest";
import {
  type AgreementReviewSource,
  parseAgreementReview,
} from "./agreement-review.js";

function source(): AgreementReviewSource {
  const texts = [
    "Each parent must share school notices within 24 hours.",
    "Travel requests remain unresolved until answered. Silence is not consent.",
  ];
  return {
    artifactId: "synthetic-agreement",
    sourceSha256: "a".repeat(64),
    extractionSha256: "b".repeat(64),
    extraction: {
      complete: true,
      pageCount: texts.length,
      text: texts.join("\n"),
      pages: texts.map((text, index) => ({
        pageNumber: index + 1,
        width: 612,
        height: 792,
        method: "native",
        nativeText: text,
        nativePositionedText: [],
        ocrText: null,
        visionText: null,
        text,
        hasVisualContent: false,
      })),
    },
  };
}

function proposal() {
  return {
    title: "Travel consent",
    obligationText: "An unanswered request is unresolved, not approved.",
    citationText:
      "Travel requests remain unresolved until answered. Silence is not consent.",
    pageStart: 2,
    pageEnd: 2,
  };
}
function response(overrides = {}) {
  return JSON.stringify({
    complete: true,
    reviewedPages: [1, 2],
    explanation: "Synthetic review requiring owner decisions.",
    proposals: [proposal()],
    ...overrides,
  });
}

describe("agreement review model output", () => {
  it("preserves a cited conditional rule and permits only whitespace normalization", () => {
    const input = {
      ...proposal(),
      citationText:
        "Travel requests remain unresolved\n until answered.  Silence is not consent.",
    };
    const result = parseAgreementReview(
      response({ proposals: [input] }),
      source(),
    );
    expect(result.proposals[0]).toEqual(input);
  });

  it.each([
    { $schema: "https://json-schema.org/draft/2020-12/schema" },
    { complete: false },
    { reviewedPages: [1] },
    { reviewedPages: [2, 1] },
    { reviewedPages: [1, 1] },
    { reviewedPages: [1, 2, 3] },
    { explanation: "" },
    { proposals: [proposal(), proposal()] },
  ])("rejects incomplete or contradictory review metadata: %j", (overrides) => {
    expect(() => parseAgreementReview(response(overrides), source())).toThrow(
      expect.objectContaining({ code: "AGREEMENT_REVIEW_INVALID" }),
    );
  });

  it.each([
    { citationText: "Silence is consent." },
    { pageStart: 1, pageEnd: 1 },
    { pageStart: 2, pageEnd: 3 },
    { pageStart: 2, pageEnd: 1 },
  ])(
    "rejects invented text and citations to the wrong pages: %j",
    (overrides) => {
      expect(() =>
        parseAgreementReview(
          response({ proposals: [{ ...proposal(), ...overrides }] }),
          source(),
        ),
      ).toThrow(
        expect.objectContaining({ code: "AGREEMENT_REVIEW_CITATION_INVALID" }),
      );
    },
  );

  it("does not turn an interrupted provider response into an empty review", () => {
    expect(() =>
      parseAgreementReview('{"complete":true,"proposals":[', source()),
    ).toThrow(expect.objectContaining({ code: "AGREEMENT_REVIEW_INVALID" }));
    expect(
      parseAgreementReview(response({ proposals: [] }), source()).proposals,
    ).toEqual([]);
  });
});
