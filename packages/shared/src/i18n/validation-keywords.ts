/**
 * Validation keywords — barrel re-export.
 *
 * Keyword DATA is generated from JSON: keywords/*.keywords.json
 *   → generated/validation-keyword-data.ts  (codegen, do not edit)
 *
 * Matching UTILITIES are hand-written: keyword-matching.ts
 *
 * To add/edit keywords, edit the JSON files and run:
 *   node scripts/generate-keywords.mjs
 */
export {
  collectKeywordTermMatches,
  collectPreparedKeywordTermMatches,
  findKeywordTermMatch,
  getValidationKeywordLocaleTerms,
  getValidationKeywordTerms,
  hasPreparedKeywordTermMatch,
  normalizeKeywordMatchText,
  type PreparedKeywordTerm,
  prepareKeywordTerms,
  splitKeywordDoc,
  textIncludesKeywordTerm,
  VALIDATION_KEYWORD_DOCS,
} from "./keyword-matching.js";
