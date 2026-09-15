/**
 * Keyword matching utilities for i18n validation keywords.
 *
 * These functions operate on keyword terms (individual words/phrases) that are
 * loaded from the generated keyword data. They handle Unicode normalization,
 * word boundary detection, and greedy matching across message history.
 *
 * The keyword data itself lives in generated/validation-keyword-data.js
 * at runtime (codegen'd from keywords/*.keywords.json).
 */

// Import from the data-free language module (not character-presets.js) so the
// i18n keyword matcher — which is on the eager renderer path via the shared
// barrel — does not pull the ~49KB CHARACTER_DEFINITIONS preset data.
import { normalizeCharacterLanguage } from "../character-language.js";
import type { CharacterLanguage } from "../contracts/first-run-options.js";
import { VALIDATION_KEYWORD_DOCS } from "./generated/validation-keyword-data.js";

// Re-export the generated data so existing consumers can still reach it
export { VALIDATION_KEYWORD_DOCS };

type ValidationKeywordDoc = {
  base?: string;
  locales?: Partial<Record<CharacterLanguage, string>>;
};

function isValidationKeywordDoc(value: unknown): value is ValidationKeywordDoc {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return "base" in record || "locales" in record;
}

function lookupValidationKeywordDoc(key: string): ValidationKeywordDoc {
  let current: unknown = VALIDATION_KEYWORD_DOCS;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object") {
      throw new Error(`Unknown validation keyword key: ${key}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (!isValidationKeywordDoc(current)) {
    throw new Error(`Unknown validation keyword key: ${key}`);
  }

  return current;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeKeywordMatchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function usesAsciiWordBoundaries(term: string): boolean {
  return /^[a-z0-9][a-z0-9' -]*$/i.test(term);
}

export function splitKeywordDoc(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of value.split(/\n+/)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeKeywordMatchText(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(trimmed);
  }
  return terms;
}

function compileKeywordTerm(term: string) {
  const normalizedTerm = normalizeKeywordMatchText(term);
  const pattern = usesAsciiWordBoundaries(normalizedTerm)
    ? new RegExp(
        `\\b${escapePattern(normalizedTerm).replace(/\\ /g, "\\s+")}\\b`,
        "i",
      )
    : null;
  return (
    text: string,
    normalizedText: string,
    hasNonAsciiText: boolean,
  ): boolean => {
    if (!normalizedText || !normalizedTerm) {
      return false;
    }
    if (pattern) {
      return (
        pattern.test(text) ||
        (hasNonAsciiText && normalizedText.includes(normalizedTerm))
      );
    }
    return normalizedText.includes(normalizedTerm);
  };
}

function textHasNonAscii(text: string): boolean {
  return /[^\p{ASCII}]/u.test(text);
}

export function textIncludesKeywordTerm(text: string, term: string): boolean {
  return compileKeywordTerm(term)(
    text,
    normalizeKeywordMatchText(text),
    textHasNonAscii(text),
  );
}

/**
 * A keyword term with its per-term work (normalization, word-boundary
 * pattern) done once. `term` is the raw string exactly as supplied because
 * match sets are keyed by the raw term. Prepared terms hold catalog
 * vocabulary only, never conversation text, so callers may retain them
 * across turns (live 2026-09-06: CONTACT's validate recompiled every
 * all-locale term on each of seven promoted children, ~3.5 s per memory
 * turn).
 */
export interface PreparedKeywordTerm {
  term: string;
  matches: (
    text: string,
    normalizedText: string,
    hasNonAsciiText: boolean,
  ) => boolean;
}

export function prepareKeywordTerms(
  terms: readonly string[],
): PreparedKeywordTerm[] {
  const seen = new Set<string>();
  const prepared: PreparedKeywordTerm[] = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    prepared.push({ term, matches: compileKeywordTerm(term) });
  }
  return prepared;
}

/**
 * {@link collectKeywordTermMatches} over already-prepared terms: each text is
 * normalized once, each term's pattern was compiled once, and a term already
 * matched by an earlier text is not re-tested against later texts. Returns
 * the same set, in the same text-first insertion order, as the unprepared
 * form.
 */
export function collectPreparedKeywordTermMatches(
  texts: readonly string[],
  prepared: readonly PreparedKeywordTerm[],
): Set<string> {
  const matches = new Set<string>();
  if (texts.length === 0 || prepared.length === 0) return matches;
  let remaining = prepared;
  for (const text of texts) {
    if (remaining.length === 0) break;
    const normalizedText = normalizeKeywordMatchText(text);
    if (!normalizedText) continue;
    const hasNonAsciiText = textHasNonAscii(text);
    const unmatched: PreparedKeywordTerm[] = [];
    for (const entry of remaining) {
      if (entry.matches(text, normalizedText, hasNonAsciiText)) {
        matches.add(entry.term);
      } else {
        unmatched.push(entry);
      }
    }
    remaining = unmatched;
  }
  return matches;
}

/** Same matching rules as the complete collector, but stops after the first match when only existence is needed. */
export function hasPreparedKeywordTermMatch(
  texts: readonly string[],
  prepared: readonly PreparedKeywordTerm[],
): boolean {
  if (prepared.length === 0) return false;
  for (const text of texts) {
    const normalizedText = normalizeKeywordMatchText(text);
    if (!normalizedText) continue;
    const hasNonAsciiText = textHasNonAscii(text);
    for (const entry of prepared) {
      if (entry.matches(text, normalizedText, hasNonAsciiText)) return true;
    }
  }
  return false;
}

export function collectKeywordTermMatches(
  texts: readonly string[],
  terms: readonly string[],
): Set<string> {
  return collectPreparedKeywordTermMatches(texts, prepareKeywordTerms(terms));
}

export function findKeywordTermMatch(
  text: string,
  terms: readonly string[],
): string | undefined {
  const sorted = [...terms].sort((left, right) => right.length - left.length);
  return sorted.find((term) => textIncludesKeywordTerm(text, term));
}

export function getValidationKeywordTerms(
  key: string,
  options?: {
    includeAllLocales?: boolean;
    locale?: unknown;
  },
): string[] {
  const doc = lookupValidationKeywordDoc(key);
  if (options?.includeAllLocales) {
    return splitKeywordDoc(
      [doc.base, ...Object.values(doc.locales ?? {})]
        .filter((value): value is string => typeof value === "string")
        .join("\n"),
    );
  }

  const locale = normalizeCharacterLanguage(options?.locale);
  return splitKeywordDoc(`${doc.base ?? ""}\n${doc.locales?.[locale] ?? ""}`);
}

export function getValidationKeywordLocaleTerms(
  key: string,
  locale: unknown,
): string[] {
  const doc = lookupValidationKeywordDoc(key);
  const normalizedLocale = normalizeCharacterLanguage(locale);
  return splitKeywordDoc(doc.locales?.[normalizedLocale] ?? "");
}
