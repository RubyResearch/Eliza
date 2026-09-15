/**
 * Keyword matching backs i18n action routing. Normalization (NFKC + lowercase +
 * whitespace collapse), ASCII word-boundary matching (so "cat" doesn't match
 * "category"), and longest-term-first selection must all hold — a loose match
 * here fires the wrong action.
 */
import { describe, expect, it } from "vitest";
import {
  collectKeywordTermMatches,
  collectPreparedKeywordTermMatches,
  findKeywordTermMatch,
  hasPreparedKeywordTermMatch,
  normalizeKeywordMatchText,
  prepareKeywordTerms,
  splitKeywordDoc,
  textIncludesKeywordTerm,
} from "./keyword-matching";

describe("normalizeKeywordMatchText", () => {
  it("lowercases, collapses whitespace, trims", () => {
    expect(normalizeKeywordMatchText("  Hello   World  ")).toBe("hello world");
  });
});

describe("splitKeywordDoc", () => {
  it("splits on newlines, trims, de-duplicates (normalized)", () => {
    expect(splitKeywordDoc("Hello\n hello \n\nWorld")).toEqual([
      "Hello",
      "World",
    ]);
    expect(splitKeywordDoc(undefined)).toEqual([]);
  });
});

describe("textIncludesKeywordTerm", () => {
  it("matches whole ASCII words on boundaries, not substrings", () => {
    expect(textIncludesKeywordTerm("I have a cat", "cat")).toBe(true);
    expect(textIncludesKeywordTerm("browse the category", "cat")).toBe(false);
    expect(textIncludesKeywordTerm("please send money now", "send money")).toBe(
      true,
    );
    expect(textIncludesKeywordTerm("", "cat")).toBe(false);
  });
});

describe("collectKeywordTermMatches / findKeywordTermMatch", () => {
  it("collects every matching term across texts", () => {
    const matches = collectKeywordTermMatches(
      ["delete the file", "send a message"],
      ["delete", "send", "archive"],
    );
    expect([...matches].sort()).toEqual(["delete", "send"]);
  });

  it("findKeywordTermMatch prefers the longest matching term", () => {
    expect(
      findKeywordTermMatch("please send money to bob", ["send", "send money"]),
    ).toBe("send money");
    expect(
      findKeywordTermMatch("nothing matches", ["foo", "bar"]),
    ).toBeUndefined();
  });
});

describe("prepared keyword terms", () => {
  it("returns the same matches, in the same order, as the unprepared form", () => {
    const terms = [
      "find contact",
      "contacto",
      "kontakt",
      "find contact",
      "who is",
    ];
    const texts = [
      "Wer ist der Kontakt?",
      "please find contact Alice",
      "unrelated",
    ];
    const prepared = prepareKeywordTerms(terms);
    expect(prepared.map((entry) => entry.term)).toEqual([
      "find contact",
      "contacto",
      "kontakt",
      "who is",
    ]);
    expect([...collectPreparedKeywordTermMatches(texts, prepared)]).toEqual([
      ...collectKeywordTermMatches(texts, terms),
    ]);
    expect([...collectPreparedKeywordTermMatches(texts, prepared)]).toEqual([
      "kontakt",
      "find contact",
    ]);
    expect(collectPreparedKeywordTermMatches(["weather"], prepared).size).toBe(
      0,
    );
    expect(collectPreparedKeywordTermMatches([], prepared).size).toBe(0);
  });
});

describe("prepared keyword existence", () => {
  it.each([
    { texts: [], terms: ["contact"], expected: false },
    { texts: ["contact"], terms: [], expected: false },
    {
      texts: ["", "  ", "category", "gmail"],
      terms: ["cat", "mail"],
      expected: false,
    },
    { texts: ["Who is Alice?"], terms: ["who is", "contact"], expected: true },
    { texts: ["  ＣＯＮＴＡＣＴ  "], terms: ["contact"], expected: true },
    { texts: ["请查看邮件"], terms: ["邮件"], expected: true },
    { texts: ["meine Kontakte"], terms: ["kontakt"], expected: false },
    { texts: ["CAFÉ au lait"], terms: ["café"], expected: true },
    {
      texts: [
        ...Array.from({ length: 2000 }, () => "ordinary unrelated line"),
        "late contact",
      ],
      terms: ["contact"],
      expected: true,
    },
  ])(
    "preserves the complete predicate for $texts.length source texts",
    ({ texts, terms, expected }) => {
      const original = [...texts];
      const prepared = prepareKeywordTerms(terms);
      expect(hasPreparedKeywordTermMatch(texts, prepared)).toBe(expected);
      expect(hasPreparedKeywordTermMatch(texts, prepared)).toBe(
        collectPreparedKeywordTermMatches(texts, prepared).size > 0,
      );
      expect(texts).toEqual(original);
    },
  );

  it("does not evaluate further patterns after existence is established", () => {
    let checks = 0;
    const prepared = prepareKeywordTerms(["contact", "calendar", "mail"]).map(
      (entry) => ({
        ...entry,
        matches: (...args: Parameters<typeof entry.matches>) => {
          checks++;
          return entry.matches(...args);
        },
      }),
    );
    const texts = [
      "contact",
      ...Array.from({ length: 2000 }, () => "ordinary unrelated line"),
    ];
    expect(hasPreparedKeywordTermMatch(texts, prepared)).toBe(true);
    expect(checks).toBe(1);
    expect([...collectPreparedKeywordTermMatches(texts, prepared)]).toEqual([
      "contact",
    ]);
  });
});
