/**
 * @module extraction
 * @description LLM-based field extraction from natural language.
 *
 * Exposes prompt/schema/parse helpers consumed by the form Evaluator and
 * runs the LLM call directly only for the targeted single-field and
 * correction-detection helpers.
 */

import type { IAgentRuntime, JSONSchema, JsonValue } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { FormService } from "./service";
import type { TemplateValues } from "./template";
import { resolveControlTemplates } from "./template";
import type {
  ControlType,
  ExtractionResult,
  FormControl,
  FormDefinition,
  FormIntent,
  IntentResult,
} from "./types";
import { getTypeHandler, parseValue, validateField } from "./validation";

const FORM_INTENTS: FormIntent[] = [
  "fill_form",
  "submit",
  "stash",
  "restore",
  "cancel",
  "undo",
  "skip",
  "explain",
  "example",
  "progress",
  "autofill",
  "other",
];

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const INTENT_MEANINGS: Record<FormIntent, string> = {
  fill_form: "user is providing field values",
  submit: "user wants to submit or finish the form",
  stash: "user wants to save or pause the form for later",
  restore: "user wants to resume a saved form",
  cancel: "user wants to cancel or abandon the form",
  undo: "user wants to undo the last change",
  skip: "user wants to skip the current field",
  explain: "user wants an explanation",
  example: "user wants an example value",
  progress: "user wants a progress update",
  autofill: "user wants to use saved values",
  other: "none of the above",
};

type SingleFieldJsonResponse = {
  found?: string | boolean;
  value?: JsonValue;
  confidence?: string | number;
  reasoning?: string;
};

type CorrectionJsonField = {
  field?: string;
  old_value?: JsonValue;
  new_value?: JsonValue;
  confidence?: string | number;
};

type CorrectionJsonResponse = {
  has_correction?: string | boolean;
  corrections?: CorrectionJsonField[];
};

function parseJsonObjectResponse<T>(response: string): T | null {
  try {
    const trimmed = response.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

function parseBoolean(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIntent(str: string): str is FormIntent {
  return (FORM_INTENTS as string[]).includes(str);
}

function isSafeExtractionField(field: string): boolean {
  return field
    .split(".")
    .every((part) => part.length > 0 && !UNSAFE_OBJECT_KEYS.has(part));
}

// ============================================================================
// EVALUATOR HELPERS — schema, prompt, parse for the evaluator pass
// ============================================================================

/**
 * Build the JSON Schema fragment for the form-extractor evaluator section.
 *
 * Returned shape:
 *   { formIntent: <enum>, formExtractions: [{ field, value, confidence, isCorrection }] }
 */
export function buildFormExtractorSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      formIntent: {
        type: "string",
        enum: [...FORM_INTENTS],
      },
      formExtractions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: {},
            confidence: { type: "number" },
            isCorrection: { type: "boolean" },
            reasoning: { type: "string" },
          },
          required: ["field", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["formIntent", "formExtractions"],
    additionalProperties: false,
  };
}

/**
 * Build the prompt section for the form-extractor evaluator.
 *
 * The evaluator prompt inlines this string and asks the model to
 * populate `{ formIntent, formExtractions }` for the active form.
 */
export function buildFormExtractorPromptSection(params: {
  text: string;
  form: FormDefinition;
  controls: FormControl[];
  templateValues?: TemplateValues;
  resolveControlType?: (typeId: string) => ControlType | undefined;
}): string {
  const { text, form, controls, templateValues, resolveControlType } = params;

  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  const visibleControls = resolvedControls.filter((c) => !c.hidden);
  const fieldsDescription = visibleControls.map((c) => {
    const handler = getTypeHandler(c.type, resolveControlType?.(c.type));
    const typeHint = handler?.extractionPrompt || c.type;
    return {
      key: c.key,
      label: c.label,
      type: typeHint,
      description: c.description || typeHint,
      hints: c.extractHints ?? [],
      options: c.options?.map((o) => o.value) ?? [],
    };
  });

  return `Extract active form intent + field values.

Context JSON:
${JSON.stringify(
  {
    form: {
      name: form.name,
      description: form.description,
    },
    fields: fieldsDescription,
    user_message: text,
    intent_options: FORM_INTENTS,
    intent_meanings: INTENT_MEANINGS,
  },
  null,
  2,
)}

Return:
{
  "formIntent": "one of intent_options",
  "formExtractions": [
    { "field": "<key>", "value": <extracted>, "confidence": 0.0-1.0, "isCorrection": false, "reasoning": "brief" }
  ]
}

Rules:
- Choose exactly one intent.
- fill_form: extract every mentioned field value.
- No fields -> formExtractions=[].
- confidence 0.0-1.0.`;
}

/**
 * Parse the raw `{ formIntent, formExtractions }` object produced by the
 * evaluator pass into a typed `IntentResult`. Type coercion and
 * validation against control rules happen later (in the processor) where
 * the form definition is in scope.
 */
export function parseFormExtractorOutput(raw: unknown): IntentResult | null {
  if (!isRecord(raw)) return null;

  const intentStr =
    typeof raw.formIntent === "string" ? raw.formIntent.toLowerCase() : "other";
  const intent: FormIntent = isValidIntent(intentStr) ? intentStr : "other";

  const rawExtractions = Array.isArray(raw.formExtractions)
    ? raw.formExtractions
    : [];

  const extractions: ExtractionResult[] = [];
  const seen = new Set<string>();

  for (const entry of rawExtractions) {
    if (!isRecord(entry)) continue;
    const fieldKey = typeof entry.field === "string" ? entry.field : "";
    if (!fieldKey) continue;
    if (!isSafeExtractionField(fieldKey)) continue;

    const dedupeKey = `${fieldKey}\0${String(entry.value ?? "")}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const value: JsonValue = (entry.value as JsonValue | undefined) ?? null;

    let confidence =
      typeof entry.confidence === "number"
        ? entry.confidence
        : parseFloat(String(entry.confidence ?? ""));
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    const reasoning =
      typeof entry.reasoning === "string" ? entry.reasoning : undefined;

    extractions.push({
      field: fieldKey,
      value,
      confidence,
      reasoning,
      isCorrection: parseBoolean(entry.isCorrection),
    });
  }

  return { intent, extractions };
}

/**
 * Apply type coercion + validation to a parsed extractions list against the
 * resolved form controls. Lowers confidence to 0.3 when a value fails the
 * control's validator (so downstream confirmation flow kicks in).
 */
export function coerceExtractionsAgainstControls(
  extractions: ExtractionResult[],
  controls: FormControl[],
  templateValues?: TemplateValues,
  resolveControlType?: (typeId: string) => ControlType | undefined,
): ExtractionResult[] {
  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  const controlsByKey = new Map(
    resolvedControls.map((control) => [control.key, control]),
  );

  return extractions.flatMap((extraction) => {
    if (extraction.field.includes(".")) {
      const [parentKey, subKey, ...extraParts] = extraction.field.split(".");
      if (extraParts.length > 0 || !parentKey || !subKey) return [];
      if (!controlsByKey.has(parentKey)) return [];
      return [extraction];
    }

    const control = controlsByKey.get(extraction.field);
    if (!control) return [];
    const controlType = resolveControlType?.(control.type);

    let value = extraction.value;
    if (typeof value === "string") {
      value = parseValue(value, control, controlType);
    }

    const validation = validateField(value, control, controlType);
    if (!validation.valid) {
      const reasoning =
        `${extraction.reasoning ?? ""} (Validation failed: ${validation.error})`.trim();
      return [
        {
          ...extraction,
          value,
          confidence: Math.min(extraction.confidence, 0.3),
          reasoning,
        },
      ];
    }

    return [{ ...extraction, value }];
  });
}

// ============================================================================
// SINGLE-FIELD EXTRACTION (still owns its LLM call — narrow targeted use)
// ============================================================================

/**
 * Extract a specific field value from a user message with a focused prompt.
 *
 * Used when the agent has just asked for a specific field and expects a
 * direct answer. Independent of the evaluator pass.
 */
export async function extractSingleField(
  runtime: IAgentRuntime,
  text: string,
  control: FormControl,
  debug?: boolean,
  templateValues?: TemplateValues,
): Promise<ExtractionResult | null> {
  const resolvedControl = templateValues
    ? resolveControlTemplates(control, templateValues)
    : control;
  const formService = runtime.getService("FORM");
  const controlType =
    formService instanceof FormService
      ? formService.getControlType(resolvedControl.type)
      : undefined;
  const handler = getTypeHandler(resolvedControl.type, controlType);
  const typeHint = handler?.extractionPrompt || resolvedControl.type;

  const prompt = `Extract a single form field value from the user message.

Context JSON:
${JSON.stringify(
  {
    field: {
      key: resolvedControl.key,
      label: resolvedControl.label,
      type: typeHint,
      description: resolvedControl.description,
      hints: resolvedControl.extractHints ?? [],
      options: resolvedControl.options?.map((o) => o.value) ?? [],
      example: resolvedControl.example,
    },
    user_message: text,
  },
  null,
  2,
)}

Return only a valid JSON object with this schema:
{
  "found": true,
  "value": "extracted value or null if not found",
  "confidence": 0.95,
  "reasoning": "brief explanation"
}`;

  const runModel = runtime.useModel.bind(runtime);
  const response = await runModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.1,
  });

  const parsed = parseJsonObjectResponse<SingleFieldJsonResponse>(response);
  const found = parsed?.found === true || parsed?.found === "true";
  if (!found || !parsed) return null;

  let value = parsed.value;
  if (typeof value === "string") {
    value = parseValue(value, resolvedControl, controlType);
  }

  const confidence =
    typeof parsed.confidence === "number"
      ? parsed.confidence
      : parseFloat(String(parsed.confidence ?? ""));

  const result: ExtractionResult = {
    field: resolvedControl.key,
    value: value ?? null,
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
  };

  if (debug) {
    runtime.logger.debug(
      "[FormExtraction] Single field extraction:",
      JSON.stringify(result),
    );
  }

  return result;
}

// ============================================================================
// CORRECTION DETECTION (still owns its LLM call — narrow targeted use)
// ============================================================================

/**
 * Detect whether the user is correcting a previously filled value.
 */
export async function detectCorrection(
  runtime: IAgentRuntime,
  text: string,
  currentValues: Record<string, JsonValue>,
  controls: FormControl[],
  templateValues?: TemplateValues,
): Promise<ExtractionResult[]> {
  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  const currentValueEntries = resolvedControls.filter(
    (c) => currentValues[c.key] !== undefined,
  );
  if (currentValueEntries.length === 0) return [];

  const currentValueRows = currentValueEntries.map((c) => ({
    key: c.key,
    label: c.label,
    value: currentValues[c.key],
  }));

  const prompt = `Detect whether the user is correcting a previous form value.

Context JSON:
${JSON.stringify(
  {
    current_values: currentValueRows,
    user_message: text,
  },
  null,
  2,
)}

Return only a valid JSON object with this schema:
{
  "has_correction": true,
  "corrections": [
    {
      "field": "email",
      "old_value": "old@example.com",
      "new_value": "new@example.com",
      "confidence": 0.9
    }
  ]
}

Rules:
- Decide whether the user is correcting a previous value.
- When correcting, extract the replacement value.
- Use an empty corrections array when no corrections were found.`;

  const runModel = runtime.useModel.bind(runtime);
  const response = await runModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.1,
  });

  const parsed = parseJsonObjectResponse<CorrectionJsonResponse>(response);
  const hasCorrection =
    parsed?.has_correction === true || parsed?.has_correction === "true";
  if (!parsed || !hasCorrection || !parsed.corrections) return [];

  const formService = runtime.getService("FORM");
  const corrections: ExtractionResult[] = [];
  const correctionList = Array.isArray(parsed.corrections)
    ? parsed.corrections
    : [];
  const seen = new Set<string>();

  for (const correction of correctionList) {
    const fieldName = correction.field ? String(correction.field) : "";
    const control = resolvedControls.find(
      (c) =>
        c.label.toLowerCase() === fieldName.toLowerCase() ||
        c.key.toLowerCase() === fieldName.toLowerCase(),
    );
    if (!control) continue;

    const dedupeKey = `${control.key}\0${String(correction.new_value ?? "")}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let value = correction.new_value;
    if (typeof value === "string") {
      const controlType =
        formService instanceof FormService
          ? formService.getControlType(control.type)
          : undefined;
      value = parseValue(value, control, controlType);
    }

    const confidence =
      typeof correction.confidence === "number"
        ? correction.confidence
        : parseFloat(String(correction.confidence ?? ""));

    corrections.push({
      field: control.key,
      value: value ?? null,
      confidence: Number.isFinite(confidence) ? confidence : 0.8,
      isCorrection: true,
    });
  }

  return corrections;
}
