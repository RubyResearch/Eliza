/**
 * @module builtins
 * @description Built-in control types for the Form Plugin
 *
 * ## Overview
 *
 * This module defines the standard control types that are available out of the box:
 * - text: Plain text strings
 * - number: Numeric values (integers or decimals)
 * - email: Email addresses with format validation
 * - boolean: Yes/no, true/false values
 * - select: Choice from predefined options
 * - date: Date values in various formats
 * - file: File uploads (handled specially)
 *
 * ## Why Built-in Types
 *
 * Built-in types provide:
 * 1. **Consistent validation** across all forms - same rules everywhere
 * 2. **Sensible defaults** for common field types - less configuration
 * 3. **LLM extraction hints** optimized for each type - better extraction
 * 4. **Override protection** to prevent accidental shadowing - safety first
 *
 * ## Architecture Decision: ControlType vs TypeHandler
 *
 * We use ControlType (not the legacy TypeHandler) because:
 * - ControlType is the shared interface for all type categories
 * - ControlType supports composite types (subcontrols)
 * - ControlType supports external types (activate/confirm)
 * - TypeHandler is legacy and maintained only for backwards compatibility
 *
 * ## Why These Specific Types
 *
 * | Type | Why Built-in |
 * |------|--------------|
 * | text | Most common field type, catch-all for strings |
 * | number | Second most common, needs special parsing (commas, $) |
 * | email | Critical for communication, has clear format rules |
 * | boolean | Binary choice, many natural language forms (yes/no/true/false) |
 * | select | Constrained choice, validation against options |
 * | date | Complex parsing (many formats), needs normalization |
 * | file | Special handling needed (size, type, storage) |
 *
 * ## Extending
 *
 * Plugins can register custom types via FormService.registerControlType().
 * Built-in types can be overridden with { allowOverride: true } option,
 * but this will log a warning.
 *
 * ## Usage
 *
 * Built-in types are automatically registered when FormService starts.
 * You don't need to call registerBuiltinTypes() manually.
 *
 * @example
 * ```typescript
 * // Check if a type is built-in before overriding
 * if (isBuiltinType('email')) {
 *   console.log('Warning: overriding built-in type');
 *   formService.registerControlType(myEmailType, { allowOverride: true });
 * }
 * ```
 */

import type { JsonValue } from "@elizaos/core";
import { formatCalendarDate, parseCalendarDate } from "./calendar-date";
import { basicEmailValid } from "./email";
import type { ControlType, FormControl, ValidationResult } from "./types";
import { testControlPattern } from "./validation";

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

// ============================================================================
// BUILT-IN CONTROL TYPES
// ============================================================================

/**
 * Text control type
 *
 * The default type for string input. Accepts any string value.
 * Validation is typically done via pattern/minLength/maxLength on the control.
 *
 * WHY text is the default:
 * - Most form fields are ultimately strings
 * - Pattern matching handles most custom validation needs
 * - Length limits catch data quality issues
 * - Unknown types fall back to text safely
 *
 * WHY validate inside the ControlType:
 * - Centralizes string validation logic
 * - Control-level rules (minLength, maxLength, pattern) are checked here
 * - Allows consistent error messages
 */
const textType: ControlType = {
  id: "text",
  builtin: true,

  validate: (value: JsonValue, control: FormControl): ValidationResult => {
    if (value === null || value === undefined) {
      return { valid: true }; // Empty is valid; required check is separate
    }

    const str = String(value);

    // Check minLength if specified
    if (control.minLength !== undefined && str.length < control.minLength) {
      return {
        valid: false,
        error: `Must be at least ${control.minLength} characters`,
      };
    }

    // Check maxLength if specified
    if (control.maxLength !== undefined && str.length > control.maxLength) {
      return {
        valid: false,
        error: `Must be at most ${control.maxLength} characters`,
      };
    }

    // Check pattern if specified. Goes through the shared agent-authored-regex
    // dialect, never a bare `new RegExp` on caller input; any refusal fails
    // the field closed.
    if (control.pattern) {
      const checked = testControlPattern(control.pattern, str);
      if (!checked.ok) {
        return { valid: false, error: "Invalid format" };
      }
    }

    // Check enum if specified
    if (control.enum && !control.enum.includes(str)) {
      return {
        valid: false,
        error: `Must be one of: ${control.enum.join(", ")}`,
      };
    }

    return { valid: true };
  },

  parse: (value: string): string => String(value).trim(),

  format: (value: JsonValue): string => String(value ?? ""),

  extractionPrompt: "a text string",
};

/**
 * Number control type
 *
 * Handles numeric values including integers and decimals.
 * Supports min/max validation for value range.
 *
 * WHY special number handling:
 * - Users type "1,234" or "$50" - we need to parse through formatting
 * - LLM might extract "fifty" which needs conversion
 * - Min/max validation is numeric, not string length
 *
 * WHY parse removes commas and currency symbols:
 * - International number formats use , as thousands separator
 * - Users often include currency prefix ($, €)
 * - Agent should handle natural input, not require clean numbers
 */
const numberType: ControlType = {
  id: "number",
  builtin: true,

  validate: (value: JsonValue, control: FormControl): ValidationResult => {
    if (value === null || value === undefined || value === "") {
      return { valid: true }; // Empty is valid; required check is separate
    }

    const num = typeof value === "number" ? value : parseFloat(String(value));

    if (!Number.isFinite(num)) {
      return { valid: false, error: "Must be a valid number" };
    }

    // Check min if specified
    if (control.min !== undefined && num < control.min) {
      return { valid: false, error: `Must be at least ${control.min}` };
    }

    // Check max if specified
    if (control.max !== undefined && num > control.max) {
      return { valid: false, error: `Must be at most ${control.max}` };
    }

    return { valid: true };
  },

  parse: (value: string): number => {
    const cleaned = value.replace(/[,$\s]/g, ""); // Remove common formatting
    return parseFloat(cleaned);
  },

  format: (value: JsonValue): string => {
    if (value === null || value === undefined) return "";
    const num = typeof value === "number" ? value : parseFloat(String(value));
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString();
  },

  extractionPrompt: "a number (integer or decimal)",
};

/**
 * Email control type
 *
 * Validates email format using a practical structural check.
 * Not RFC-compliant but catches common errors.
 *
 * WHY simple regex (not RFC 5322):
 * - RFC-compliant regex is 1000+ chars and still misses edge cases
 * - Simple pattern catches 99% of typos (missing @, missing domain)
 * - False positives are rare and harmless
 * - Real validation is done by sending confirmation email
 *
 * WHY lowercase normalization:
 * - Email local parts are technically case-sensitive (but rarely in practice)
 * - Domain is case-insensitive by standard
 * - Consistent lowercase prevents duplicate account issues
 */
const emailType: ControlType = {
  id: "email",
  builtin: true,

  validate: (value: JsonValue): ValidationResult => {
    if (value === null || value === undefined || value === "") {
      return { valid: true }; // Empty is valid; required check is separate
    }

    const str = String(value).trim().toLowerCase();

    if (!basicEmailValid(str)) {
      return { valid: false, error: "Invalid email format" };
    }

    return { valid: true };
  },

  parse: (value: string): string => value.trim().toLowerCase(),

  format: (value: JsonValue): string => String(value ?? "").toLowerCase(),

  extractionPrompt: "an email address (e.g., user@example.com)",
};

/**
 * Boolean control type
 *
 * Handles yes/no, true/false, on/off values.
 * LLM can normalize natural language to boolean.
 *
 * WHY accept many formats:
 * - Users say "yes", "yep", "sure", "absolutely"
 * - Different cultures prefer different affirmatives
 * - LLM normalizes to one of the accepted formats
 * - We just need to recognize the normalized output
 *
 * WHY display as "Yes"/"No":
 * - More human-readable than true/false
 * - Consistent with how agent should speak
 */
const booleanType: ControlType = {
  id: "boolean",
  builtin: true,

  validate: (value: JsonValue): ValidationResult => {
    if (value === null || value === undefined) {
      return { valid: true }; // Empty is valid; required check is separate
    }

    if (typeof value === "boolean") {
      return { valid: true };
    }

    const str = String(value).toLowerCase();
    const validValues = ["true", "false", "yes", "no", "1", "0", "on", "off"];

    if (!validValues.includes(str)) {
      return { valid: false, error: "Must be yes/no or true/false" };
    }

    return { valid: true };
  },

  parse: (value: string): boolean => {
    const str = value.toLowerCase();
    return ["true", "yes", "1", "on"].includes(str);
  },

  format: (value: JsonValue): string => {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return String(value ?? "");
  },

  extractionPrompt: "a yes/no or true/false value",
};

/**
 * Select control type
 *
 * Choice from predefined options. Options come from the control definition.
 * Validates that value matches one of the allowed options.
 *
 * WHY strict option matching:
 * - Select fields have defined, constrained values
 * - Invalid selections indicate extraction error, not user error
 * - Better to reject and re-ask than accept garbage
 *
 * WHY show option labels in error:
 * - User might not know the exact value needed
 * - Showing valid options helps them choose
 * - Agent can use this for more helpful prompts
 */
const selectType: ControlType = {
  id: "select",
  builtin: true,

  validate: (value: JsonValue, control: FormControl): ValidationResult => {
    if (value === null || value === undefined || value === "") {
      return { valid: true }; // Empty is valid; required check is separate
    }

    const str = String(value);

    // Check against options if defined
    if (control.options) {
      const validValues = control.options.map((o) => o.value);
      if (!validValues.includes(str)) {
        const labels = control.options.map((o) => o.label).join(", ");
        return { valid: false, error: `Must be one of: ${labels}` };
      }
    }

    // Check against enum if defined (fallback)
    if (control.enum && !control.options) {
      if (!control.enum.includes(str)) {
        return {
          valid: false,
          error: `Must be one of: ${control.enum.join(", ")}`,
        };
      }
    }

    return { valid: true };
  },

  parse: (value: string): string => value.trim(),

  format: (value: JsonValue): string => String(value ?? ""),

  // Note: extractionPrompt is typically customized per-field with option labels
  extractionPrompt: "one of the available options",
};

/**
 * Date control type
 *
 * Handles date values in ISO format (YYYY-MM-DD).
 * LLM normalizes various date formats to ISO.
 *
 * WHY ISO format as canonical:
 * - Unambiguous (no 01/02 confusion between US/EU)
 * - Sortable as strings
 * - Standard for data exchange
 *
 * WHY flexible parsing:
 * - Users say "tomorrow", "next Monday", "12/25/2024"
 * - LLM should normalize to ISO
 * - We accept anything Date() can parse as fallback
 *
 * WHY locale display:
 * - Agent should speak in user's date format
 * - toLocaleDateString() adapts automatically
 */
const dateType: ControlType = {
  id: "date",
  builtin: true,

  validate: (value: JsonValue): ValidationResult => {
    if (value === null || value === undefined || value === "") {
      return { valid: true }; // Empty is valid; required check is separate
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return { valid: false, error: "Must be in YYYY-MM-DD format" };
    }
    if (!parseCalendarDate(String(value))) {
      return { valid: false, error: "Invalid date" };
    }

    return { valid: true };
  },

  parse: (value: string): string => parseCalendarDate(value) ?? value.trim(),

  format: (value: JsonValue): string => {
    if (!value) return "";
    return formatCalendarDate(String(value)) ?? String(value);
  },

  extractionPrompt: "a date (preferably in YYYY-MM-DD format)",
};

/**
 * File control type
 *
 * Metadata-only control for file uploads. Actual file handling is done by the
 * file upload pipeline, not the form system.
 *
 * Validation here is basic; real validation happens during upload.
 *
 * WHY separate from other types:
 * - File content isn't serializable in session state
 * - Actual upload is handled by messaging platform
 * - We only store metadata (name, size, mimeType, url)
 *
 * WHY validation is minimal:
 * - Real file validation happens at upload time
 * - By the time we see it, it's already uploaded
 * - We just validate the metadata structure
 *
 * WHY display as "N file(s)":
 * - File content isn't meaningful to show
 * - Count and names are what user cares about
 */
const fileType: ControlType = {
  id: "file",
  builtin: true,

  validate: (value: JsonValue, _control: FormControl): ValidationResult => {
    if (value === null || value === undefined) {
      return { valid: true }; // Empty is valid; required check is separate
    }

    // For file type, value is typically a FieldFile or array of FieldFile
    // Basic validation - detailed validation happens in upload pipeline
    if (typeof value === "object") {
      return { valid: true };
    }

    return { valid: false, error: "Invalid file data" };
  },

  format: (value: JsonValue): string => {
    if (!value) return "";
    if (Array.isArray(value)) {
      return `${value.length} file(s)`;
    }
    if (typeof value === "object" && value !== null && "name" in value) {
      return String((value as { name: string }).name);
    }
    return "File attached";
  },

  extractionPrompt: "a file attachment (upload required)",
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Array of all built-in control types.
 *
 * These are registered automatically when FormService starts.
 * The order doesn't matter; they're looked up by id.
 *
 * WHY array + map:
 * - Array allows easy iteration for registration
 * - Map provides O(1) lookup for override checks
 * - Both derived from same source ensures consistency
 */
export const BUILTIN_TYPES: ControlType[] = [
  textType,
  numberType,
  emailType,
  booleanType,
  selectType,
  dateType,
  fileType,
];

/**
 * Map of built-in types by id for quick lookup.
 *
 * WHY Map (not object):
 * - Type-safe keys
 * - O(1) lookup performance
 * - Clear has/get semantics
 */
export const BUILTIN_TYPE_MAP: Map<string, ControlType> = new Map(
  BUILTIN_TYPES.map((t) => [t.id, t]),
);

/**
 * Register all built-in types with a FormService instance.
 *
 * This is called automatically during FormService.start().
 * You typically don't need to call this directly.
 *
 * WHY take a function (not FormService):
 * - Avoids circular dependency (builtins.ts ↔ service.ts)
 * - Service passes its registerControlType method
 * - Clean separation of concerns
 *
 * @param registerFn - The FormService.registerControlType method
 */
export function registerBuiltinTypes(
  registerFn: (
    type: ControlType,
    options?: { allowOverride?: boolean },
  ) => void,
): void {
  for (const type of BUILTIN_TYPES) {
    registerFn(type);
  }
}

/**
 * Get a built-in type by id.
 *
 * This is a convenience for checking if a type is built-in
 * before attempting to override it.
 *
 * WHY this exists:
 * - Plugins may want to extend a built-in type
 * - Checking before override allows informed decisions
 * - Avoids accidental shadowing
 *
 * @param id - The type id to look up
 * @returns The ControlType if found, undefined otherwise
 */
export function getBuiltinType(id: string): ControlType | undefined {
  return BUILTIN_TYPE_MAP.get(id);
}

/**
 * Check if a type id is a built-in type.
 *
 * WHY boolean convenience:
 * - Most callers just need yes/no answer
 * - Cleaner than checking getBuiltinType() !== undefined
 *
 * @param id - The type id to check
 * @returns true if the type is built-in
 */
export function isBuiltinType(id: string): boolean {
  return BUILTIN_TYPE_MAP.has(id);
}
